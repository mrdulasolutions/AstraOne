# Building Astra Dock for distribution

> Canonical reference: [`BUILDING.md`](https://github.com/mrdulasolutions/AstraOne/blob/main/BUILDING.md) in the main repo. This wiki page mirrors the highlights.

## Quick commands

| Goal | Command |
|---|---|
| Local test build (no signing) | `npm run dist:unsigned` |
| Just the `.app` bundle | `npm run pack` |
| Signed (cert required) | `npm run dist` |
| Signed + notarized (production) | `APPLE_ID=… APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=… npm run dist` |
| Apple Silicon only | `npm run dist:arm64` |
| Intel only | `npm run dist:x64` |
| Universal (1.9× the size) | `npm run dist:universal` |

After `npm run dist:unsigned`:

```
dist/Astra Dock-<version>-arm64.dmg     ← Apple Silicon installer  (~96 MB)
dist/Astra Dock-<version>.dmg           ← Intel installer          (~101 MB)
dist/Astra Dock-<version>-arm64-mac.zip ← updater bundle (arm64)
dist/Astra Dock-<version>-mac.zip       ← updater bundle (x64)
```

## Verifying a signed + notarized DMG

```bash
codesign --verify --deep --strict --verbose=4 "dist/Astra Dock-0.1.0-arm64.dmg"
spctl --assess --type open --context context:primary-signature -v "dist/Astra Dock-0.1.0-arm64.dmg"
stapler validate "dist/Astra Dock-0.1.0-arm64.dmg"
```

All three should print `accepted` / `valid`.

## Hardened-runtime entitlements

The set we request lives in `build/entitlements.mac.plist`. Each is justified:

| Entitlement | Why |
|---|---|
| `com.apple.security.cs.allow-jit` | V8 JIT inside Chromium |
| `com.apple.security.cs.allow-unsigned-executable-memory` | V8 code allocator |
| `com.apple.security.cs.disable-library-validation` | Spawning user-configured MCP stdio servers (npx / node / python — not signed by us) |
| `com.apple.security.network.client` | Outbound HTTPS to OpenRouter / Anthropic / OpenAI / ElevenLabs / MCP servers |
| `com.apple.security.device.audio-input` | ElevenLabs Scribe mic recording |

We intentionally do NOT request camera, personal-information, or app-sandbox.

## What gets baked into Info.plist

Three usage strings show in the macOS permission prompts (`build` → `mac.extendInfo` in `package.json`):

- `NSMicrophoneUsageDescription` — "Astra Dock uses your microphone for voice prompts (Speech-to-text via ElevenLabs Scribe)."
- `NSScreenCaptureUsageDescription` — "Astra Dock captures your screen or active window so it can answer questions about what you're looking at. Captures stay in RAM and can be wiped instantly with Panic."
- `NSAppleEventsUsageDescription` — only fires if a connected MCP server eventually asks for it; disabled by default.

## Going production

See [BUILDING.md → Going production: signing + notarization](https://github.com/mrdulasolutions/AstraOne/blob/main/BUILDING.md#going-production-signing--notarization) for the full Apple Developer flow. Short version:

1. Enroll in the Apple Developer Program → install a Developer ID Application cert into your login Keychain.
2. Generate an app-specific password at appleid.apple.com.
3. Export `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.
4. `npm run dist`.
5. `build/notarize.cjs` (our `afterSign` hook) submits to Apple's notarization service automatically.

## Roadmap

- Auto-update: `electron-updater` against GitHub Releases. The build config already emits the manifest (`latest-mac.yml`) and matching ZIPs — only the runtime wiring and a publish step are missing.
- Windows / Linux: evaluating. The codebase is largely portable but a few macOS-specific assumptions (alwaysOnTop level, smart-quote sanitization, `safeStorage` reliance) need cross-platform fallbacks.
