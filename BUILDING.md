# Building Astra Dock for distribution

This guide covers producing distributable `.dmg` and `.zip` artifacts of Astra Dock for macOS. Targets both Apple Silicon (arm64) and Intel (x64).

## Prerequisites

- macOS 13+ with Xcode Command Line Tools (`xcode-select --install`)
- Node 20+
- `npm ci` to install deps (electron-builder, @electron/notarize, electron, plus existing runtime deps)

## Quick paths

| You want… | Command | Output |
|---|---|---|
| Test the bundling locally (no signing, no notarization) | `npm run dist:unsigned` | `dist/Astra Dock-<v>-arm64.dmg`, `dist/Astra Dock-<v>.dmg` (x64), zips for both archs |
| Build a signed `.dmg` for *your* machine | `npm run dist` *(with a Developer ID cert in your Keychain)* | Signed but not notarized — Gatekeeper will still warn on first launch on other machines |
| Build a signed + notarized `.dmg` for general distribution | `npm run dist` *(with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars)* | Production-grade artifact |
| Just the app bundle (no DMG/zip wrapper) | `npm run pack` | `dist/mac-arm64/Astra Dock.app` |

Architecture-specific variants: `npm run dist:arm64`, `dist:x64`, `dist:universal`.

## Outputs

After `npm run dist:unsigned` you'll find in `dist/`:

```
Astra Dock-0.1.0-arm64.dmg        ← Apple Silicon installer
Astra Dock-0.1.0-arm64-mac.zip    ← Apple Silicon update bundle
Astra Dock-0.1.0.dmg              ← Intel installer
Astra Dock-0.1.0-mac.zip          ← Intel update bundle
mac-arm64/Astra Dock.app/         ← raw arm64 bundle (also inside the .dmg)
mac/Astra Dock.app/               ← raw x64 bundle
latest-mac.yml                    ← electron-updater channel manifest
```

## Going production: signing + notarization

Apple's distribution path is:

1. **Sign** the bundle with a **Developer ID Application** certificate so Gatekeeper recognizes you as a registered Apple developer.
2. **Notarize** the signed app with Apple's notarization service so Gatekeeper doesn't warn on first launch.
3. **Staple** the notarization ticket so notarization works offline.

electron-builder handles all three when configured.

### 1. Get a Developer ID Application certificate

- [developer.apple.com](https://developer.apple.com/) → enroll in the Apple Developer Program ($99/year).
- Xcode → Settings → Accounts → your team → Manage Certificates → `+` → **Developer ID Application**.
- The cert installs into your login Keychain. Verify:
  ```bash
  security find-identity -v -p codesigning | grep "Developer ID Application"
  ```
  Should show one valid identity.

### 2. Get notarization credentials

You need three values:

- `APPLE_ID` — your Apple ID email.
- `APPLE_APP_SPECIFIC_PASSWORD` — a 16-char password from [appleid.apple.com → Sign-In and Security → App-Specific Passwords](https://appleid.apple.com). **NOT** your Apple ID password.
- `APPLE_TEAM_ID` — your 10-char team identifier (visible at developer.apple.com → Membership Details).

### 3. Run the signed + notarized build

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"
npm run dist
```

`build/notarize.cjs` runs as the `afterSign` hook — it submits to Apple via `notarytool` and waits (~3–10 min). On success, electron-builder staples the ticket onto the `.app` and `.dmg`.

To verify the produced `.dmg` is signed and notarized:

```bash
codesign --verify --deep --strict --verbose=4 "dist/Astra Dock-0.1.0-arm64.dmg"
spctl --assess --type open --context context:primary-signature -v "dist/Astra Dock-0.1.0-arm64.dmg"
stapler validate "dist/Astra Dock-0.1.0-arm64.dmg"
```

All three should print `accepted` / `valid`.

## Configuration reference

All build config lives in `package.json` under the `build` key:

- `appId: com.mrdulasolutions.astra-dock` — bundle identifier (also used by macOS for the user-data directory and TCC privacy DB).
- `productName: Astra Dock` — display name.
- `mac.hardenedRuntime: true` — required for notarization.
- `mac.entitlements: build/entitlements.mac.plist` — hardened-runtime entitlements (JIT, unsigned exec memory for Chromium, library validation off for spawning unsigned MCP children, network client, audio input).
- `mac.extendInfo` — Info.plist additions: `NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription`, `NSAppleEventsUsageDescription`.
- `mac.target` — DMG + ZIP for arm64 and x64. ZIPs are for `electron-updater` auto-update; DMGs are the user-facing installers.

## Entitlements rationale

See `build/entitlements.mac.plist`. Each entitlement is justified:

| Entitlement | Why we need it |
|---|---|
| `com.apple.security.cs.allow-jit` | V8 JIT inside Chromium |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Same — V8's code allocator |
| `com.apple.security.cs.disable-library-validation` | Required to spawn user-configured MCP stdio servers (npx, node, python — these aren't signed by Astra's developer) |
| `com.apple.security.network.client` | Outbound HTTP to OpenRouter / Anthropic / OpenAI / ElevenLabs / MCP servers |
| `com.apple.security.device.audio-input` | ElevenLabs Scribe mic recording |

Anything else stays off. We do NOT request `com.apple.security.device.camera`, `com.apple.security.personal-information.*`, or sandbox.

## Auto-update (future)

The `mac.target` config already builds the ZIPs and `latest-mac.yml` manifest that `electron-updater` consumes. To wire auto-update:

1. Add `electron-updater` as a dependency.
2. In `src/main/index.js`, on app ready: `autoUpdater.checkForUpdatesAndNotify()`.
3. Host the artifacts somewhere `electron-updater` can reach (GitHub Releases works out of the box — set `publish: github` in the build config and electron-builder will upload on `--publish always`).

Out of scope for v0.1.0.

## Common build failures

- **"Cannot find module '@electron/notarize'"** → `npm ci` again. Was added in this commit.
- **"identity must be set to null"** when running `npm run dist` without a cert → use `npm run dist:unsigned` instead, or install a Developer ID Application cert into your Keychain.
- **Notarization fails with "Invalid Identifier"** → confirm `APPLE_TEAM_ID` is the 10-char team identifier, NOT your developer username.
- **DMG mounts but app crashes immediately** → check Console.app for codesign errors. The hardened runtime is unforgiving about entitlement mismatches; verify `build/entitlements.mac.plist` matches what we actually use.
- **Build dies on the x64 leg with a download timeout** → re-run; Electron binary mirrors can be slow. The arm64 artifacts are already built and don't need to be rebuilt.

## Sizes

Reference (v0.1.0, unsigned):

- `arm64.dmg` ≈ 96 MB
- `x64.dmg` ≈ 101 MB
- `arm64.app` (unpacked) ≈ 230 MB
- Most of the bulk is Chromium itself (V8, Blink, V8 snapshot blobs).

Universal build (both arches in one bundle) is ~1.9× the size — only worth shipping if you have one binary serving both, e.g. a non-Mac-App-Store download page.
