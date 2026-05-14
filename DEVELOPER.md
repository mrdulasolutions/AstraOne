# Astra Dock — Developer Guide

Internal-facing notes for engineers working on the Astra Dock codebase. For end-user docs, see [README.md](README.md).

---

## Prerequisites

- **macOS** 13+ (primary development and shipping target)
- **Node.js** 20+ (Electron 34 requires it; `package.json` enforces with `engines.node >= 20`)
- **npm** 10+
- An OpenRouter API key for end-to-end testing (a free key works)
- Optional: a vision-capable model (e.g. `anthropic/claude-sonnet-4`, `openai/gpt-4o-mini`, `google/gemini-2.0-flash-exp:free`) for screenshot-aware testing

## Repo layout

```
app/
├── src/
│   ├── main/           # Electron main process
│   │   └── index.js    # Window, IPC, capture, OpenRouter calls
│   ├── preload/        # Bridges main ↔ renderer
│   │   └── preload.js  # exposes window.glass.*
│   ├── renderer/       # UI (Chromium renderer)
│   │   ├── overlay.html
│   │   ├── overlay.css
│   │   ├── overlay.js
│   │   └── assets/
│   │       └── astra-dock.svg
├── scripts/
│   └── check-licenses.mjs   # Blocks GPL/LGPL/AGPL deps
├── tests/
│   └── policy.test.mjs      # Unit test for the copyleft detector
├── .github/
│   └── workflows/
│       └── ci.yml           # licenses + tests on push/PR
├── package.json
├── LICENSE
├── README.md
├── DEVELOPER.md       (this file)
├── CONTRIBUTING.md
└── NOTICE.md
```

## Running locally

```bash
npm install
npm start        # or: npm run dev
```

Both `start` and `dev` map to `electron .`; there is currently no separate watch/HMR mode — restart the app to pick up changes to main/preload. Renderer changes can be reloaded with **⌘R** when DevTools is open (see below).

### Opening DevTools

DevTools is not auto-opened. To inspect the renderer, add this to `src/main/index.js` inside `createWindow()` while debugging:

```js
mainWindow.webContents.openDevTools({ mode: 'detach' });
```

Remove before committing — DevTools should not ship in release builds.

## Architecture overview

Astra Dock is a standard three-process Electron app:

| Process | File | Responsibility |
|---|---|---|
| **Main** | `src/main/index.js` | Window lifecycle, global shortcuts, system tray, screen capture via `desktopCapturer`, OpenRouter HTTP, prefs persistence, `safeStorage` for API keys |
| **Preload** | `src/preload/preload.js` | Context-bridged API surface (`window.glass.*`). Sandboxed, no Node access in the renderer |
| **Renderer** | `src/renderer/*` | UI rendering, drag/resize via `-webkit-app-region`, prompt textarea, settings panel, reply panel, model picker, transparency slider |

### Window model

- One `BrowserWindow`, frameless + transparent, `alwaysOnTop` at `screen-saver` level so it paints above other apps, fullscreen content, and the macOS menu bar.
- `visibleOnAllWorkspaces: true, visibleOnFullScreen: true` so the dock follows the user across Spaces and survives other apps going fullscreen.
- Positioned flush at `display.bounds.y` (the very top of the primary screen) to eliminate the menu-bar gap.
- The window auto-resizes to its content. The renderer measures `.pill-shell` (pill + reply panel + settings panel) and IPC-calls `glass:resizeToContent`; main clamps to workArea.

### Renderer surface — `window.glass.*`

All preload-exposed IPC, with one-line descriptions. See `src/preload/preload.js` for the canonical list.

| Method | Purpose |
|---|---|
| `toggleVisibility()` | Show/hide the dock |
| `moveWindow(dir)` | Nudge bounds by 40px in a direction |
| `capturePrimaryScreen()` | Capture full primary display into the session buffer |
| `captureActiveWindow()` | Capture the largest non-self window |
| `askLlm({ prompt, includeImage })` | Send a chat completion to OpenRouter |
| `panic()` | Wipe the capture buffer |
| `getState()` | Snapshot of session state + saved prefs |
| `setOpenRouterKey(key)` | Encrypt-and-save the API key |
| `getOpenRouterKeyPresent()` | Boolean: is a key on file? |
| `setOpenRouterModel(model)` | Persist the selected model id |
| `listModels(force)` | Fetch `/api/v1/models` (cached 30 min unless `force`) |
| `setPillOpacity(opacity)` | Persist the glass alpha |
| `openExternal(url)` | Open an `https://` link in the user's browser |
| `resizeToContent({ width, height })` | Renderer asks main to size the window to fit |
| `setLayout(mode)` | Legacy no-op (settings now lives inside the pill window) |
| `onState(fn)` / `onHotkeyAsk(fn)` / `onPanicEvent(fn)` / `onForcePill(fn)` | Subscribe to state events from main |

### Adding a new IPC handler

1. Add the handler in `src/main/index.js` inside `setupIpc()`. Always return a `{ ok, ... }` shape so the renderer can branch on success.
2. Expose it from `src/preload/preload.js` via `ipcRenderer.invoke(...)`.
3. Use it in `src/renderer/overlay.js` via `await window.glass.yourMethod(...)`.

### State & prefs

- **Session state** (`sessionImageBase64`, `sessionImageMeta`, `captureArmed`) lives in main-process memory only. Never written to disk. Cleared by `Panic`.
- **Prefs** persist to `~/Library/Application Support/astra-dock/prefs.json` via `app.getPath('userData')`.
- **API keys** stored inside `prefs.json` under `apiKey_<provider>`, encrypted via `safeStorage.encryptString` when `safeStorage.isEncryptionAvailable()` (true on macOS with the user logged in), otherwise base64-encoded as a fallback.

### Capture pipeline

```
renderer btnAsk → glass.askLlm
                     │
                     │  (if buffer empty)
                     ▼
                 glass.captureActiveWindow → desktopCapturer.getSources(types: ['window'])
                     │                            ↳ picks largest non-Astra-Dock by area
                     │                            ↳ JPEG quality 82 @ 1920x1200 thumbnail
                     ▼
                 sessionImageBase64
                     ▼
                 askOpenRouter(apiKey, modelId, prompt, image)
                     ▼
                 POST openrouter.ai/api/v1/chat/completions
                     ▼
                 response → reply-panel in renderer
```

System prompt for chat completions is in `SYSTEM_PROMPT` (main process) and instructs the model to treat screen pixels and pasted content as untrusted data.

### CSS variables

- `--surface-alpha` — drives the glass background of the pill, reply panel, and settings panel. Controlled by the **Pill transparency** slider.
- `--reply-max-h` — runtime-computed cap for the reply/settings panels' max-height (based on `window.screen.availHeight - 180`).

## Testing

```bash
npm test                # Node --test runner
npm run check:licenses  # dependency license audit
```

The CI workflow (`.github/workflows/ci.yml`) runs both on every push and PR against `main`/`master` on `macos-latest`.

There is currently **no UI test harness**. End-to-end behavior is verified manually.

## Dependency license policy

Astra Dock is a proprietary commercial product, but its **dependencies** must remain permissive (MIT, ISC, BSD, Apache-2.0). The product itself is **NOT** open source — but we avoid copyleft deps to remove legal ambiguity around distribution.

- `scripts/check-licenses.mjs` blocks GPL/LGPL/AGPL family licenses and fails the build.
- `tests/policy.test.mjs` unit-tests the detector regex.
- Before adding a dep, check its `license` field. If unsure, flag it for legal review.

## Branding

The Astra Dock SVG logo lives at `src/renderer/assets/astra-dock.svg`. The wordmark `ASTRA DOCK` is rendered as text (not embedded in the SVG) in the settings header. Trademarks and brand assets belong to MR Dula Enterprise, LLC.

## Build / distribution

Distribution tooling is **not yet wired up**. A typical Electron production setup would add:

- `electron-builder` or `electron-forge` for `.dmg` / `.zip` packaging
- A `Developer ID Application` certificate for code signing
- A notarization step (`notarytool`) for Gatekeeper acceptance
- An auto-update mechanism (e.g. `electron-updater` with `update.electronjs.org`)

When this is set up, document the release process here.

## Common gotchas

- **Cannot type in the pill input** → check that the parent has `-webkit-app-region: drag` and the input has `no-drag`. The whole pill is a drag region; controls override it.
- **Window won't go on top of fullscreen apps** → `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` must be called after `show()` and re-asserted on every `showMainWindow()`.
- **Reply panel renders 67px tall** → the `vh` unit refers to the Electron window's height, which is itself sized from content. Always use pixel caps or screen-derived values for panel heights.
- **OpenRouter says "model not found"** → the user has typed an id that's not in the live catalog. Click the **↻ Refresh** button in settings to re-fetch.

## Owner

MR Dula Solutions / Astra One product team.
