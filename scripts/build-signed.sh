#!/usr/bin/env bash
#
# Build signed + notarized + stapled DMGs for Astra Dock.
#
# Works around macOS codesign's name-ambiguity bug when more than one cert with
# the same Common Name exists across Keychains (e.g. orphan copy in
# /Library/Keychains/System.keychain that lacks the matching private key).
#
# How: drives the build in three stages using the explicit cert SHA1 hash so
# codesign never has to resolve a name.
#
#   1.  electron-builder --dir  →  unsigned .app per arch
#   2.  @electron/osx-sign with --identity=<SHA1>  →  signs the .app with
#       hardened runtime + entitlements; SHA1 bypasses the name lookup
#   3.  notarytool submit --wait  →  Apple notarization on the .app
#   4.  stapler staple             →  ticket attached
#   5.  electron-builder --mac dmg --prepackaged  →  wrap signed .app in a DMG
#   6.  codesign + notarytool + stapler on the DMG itself  →  Gatekeeper-clean
#       acceptance of the DMG file too
#
# Required env vars:
#   APPLE_ID                       — your Apple ID email
#   APPLE_APP_SPECIFIC_PASSWORD    — 16-char password from appleid.apple.com
#   APPLE_TEAM_ID                  — 10-char team identifier
#   ASTRA_SIGN_IDENTITY            — SHA1 hash of the Developer ID cert to use
#                                    (run `security find-identity -v -p codesigning`
#                                    to look it up; the value is the long hex
#                                    string before the cert name)
#
# Optional env vars:
#   ASTRA_ARCHES                   — space-separated list, default "arm64 x64"
#   ASTRA_SKIP_ZIPS                — "1" to skip zip update bundles
#
# Usage:
#   export APPLE_ID=you@example.com
#   export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
#   export APPLE_TEAM_ID=ABCDE12345
#   export ASTRA_SIGN_IDENTITY=703B3A4BDAB5A2A71095FF91483B2C0AB9F2DDEC
#   ./scripts/build-signed.sh

set -euo pipefail

# ── Preconditions ───────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

require() {
  [ -n "${!1:-}" ] || { echo "✗ \$$1 not set — see comments at the top of $0" >&2; exit 1; }
}
require APPLE_ID
require APPLE_APP_SPECIFIC_PASSWORD
require APPLE_TEAM_ID
require ASTRA_SIGN_IDENTITY

ARCHES="${ASTRA_ARCHES:-arm64 x64}"
ENTITLEMENTS="build/entitlements.mac.plist"
[ -f "$ENTITLEMENTS" ] || { echo "✗ $ENTITLEMENTS not found"; exit 1; }

# Verify the identity exists and has a private key locally before we burn
# notarization time on Apple's queue.
if ! security find-identity -v -p codesigning | grep -q "$ASTRA_SIGN_IDENTITY"; then
  echo "✗ Identity SHA1 $ASTRA_SIGN_IDENTITY not found in any keychain in your search list." >&2
  echo "  Run: security find-identity -v -p codesigning" >&2
  exit 1
fi

# ── Helpers ─────────────────────────────────────────────────────────────────

# Map arch → electron-builder appOutDir convention
app_out_dir_for() {
  case "$1" in
    arm64) echo "dist/mac-arm64" ;;
    x64)   echo "dist/mac" ;;
    *)     echo "dist/mac-$1" ;;
  esac
}

sign_app() {
  local app="$1"
  echo "  → @electron/osx-sign $app (identity=$ASTRA_SIGN_IDENTITY)"
  npx --package=@electron/osx-sign -- electron-osx-sign "$app" \
    --identity="$ASTRA_SIGN_IDENTITY" \
    --hardened-runtime \
    --entitlements="$ENTITLEMENTS" \
    --entitlements-inherit="$ENTITLEMENTS" \
    --gatekeeper-assess=false \
    --strict \
    --no-pre-auto-entitlements \
    --type=distribution \
    --options=runtime,library
  codesign --verify --deep --strict "$app"
}

notarize_and_staple() {
  local target="$1"
  local zip="/tmp/astra-notary-$$-$RANDOM.zip"
  if [[ "$target" == *.app ]]; then
    ditto -c -k --keepParent "$target" "$zip"
    local submit="$zip"
  else
    local submit="$target"
  fi
  echo "  → notarytool submit (this can take 3–10 min)"
  xcrun notarytool submit "$submit" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  rm -f "$zip"
  echo "  → stapling ticket onto $target"
  xcrun stapler staple "$target"
}

# ── 1. Build unsigned .app per arch ─────────────────────────────────────────

echo "▸ Cleaning dist/"
rm -rf dist/

for arch in $ARCHES; do
  echo ""
  echo "==[ $arch — unsigned pack ]=="
  CSC_IDENTITY_AUTO_DISCOVERY=false \
    npx electron-builder --dir --mac --"$arch" --config.mac.identity=null
  app="$(app_out_dir_for "$arch")/Astra Dock.app"
  [ -d "$app" ] || { echo "✗ Expected $app to exist" >&2; exit 1; }
done

# ── 2. Sign + notarize + staple each .app ───────────────────────────────────

for arch in $ARCHES; do
  echo ""
  echo "==[ $arch — sign + notarize + staple .app ]=="
  app="$(app_out_dir_for "$arch")/Astra Dock.app"
  sign_app "$app"
  notarize_and_staple "$app"
done

# ── 3. Package each signed .app into a DMG, then sign + notarize the DMG ───

for arch in $ARCHES; do
  echo ""
  echo "==[ $arch — DMG packaging + sign + notarize + staple ]=="
  app="$(app_out_dir_for "$arch")/Astra Dock.app"
  npx electron-builder --mac dmg --"$arch" \
    --prepackaged "$app" \
    --config.mac.identity=null

  # The DMG itself needs signing + notarization too so `spctl --assess` on the
  # DMG file (not just the .app inside) passes for Gatekeeper.
  dmg="$(ls -1t dist/*.dmg | grep -E "$([ "$arch" = arm64 ] && echo 'arm64' || echo '0\.dmg$')" | head -1)"
  echo "  → codesign DMG $dmg"
  codesign --sign "$ASTRA_SIGN_IDENTITY" --timestamp "$dmg"
  notarize_and_staple "$dmg"
done

# ── 4. (Optional) Zip update bundles for electron-updater ───────────────────

if [ "${ASTRA_SKIP_ZIPS:-}" != "1" ]; then
  echo ""
  echo "==[ zip update bundles ]=="
  for arch in $ARCHES; do
    app="$(app_out_dir_for "$arch")/Astra Dock.app"
    npx electron-builder --mac zip --"$arch" \
      --prepackaged "$app" \
      --config.mac.identity=null
  done
fi

# ── 5. Final verification ───────────────────────────────────────────────────

echo ""
echo "==[ final verification ]=="
for dmg in dist/*.dmg; do
  echo "── $dmg ──"
  echo "   size:        $(du -h "$dmg" | cut -f1)"
  echo "   checksum:    $(hdiutil verify "$dmg" 2>&1 | grep checksum | tail -1)"
  echo "   gatekeeper:  $(spctl --assess --type open --context context:primary-signature "$dmg" 2>&1 | tail -1)"
  echo "   stapler:     $(xcrun stapler validate "$dmg" 2>&1 | tail -1)"
done

echo ""
echo "✓ Done. Artifacts in dist/"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null || true
