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
│   ├── main/                         # Electron main process
│   │   ├── index.js                  # Window, lifecycle, IPC surface, prefs
│   │   ├── agents/
│   │   │   └── router.js             # Tool-call loop (run, cancel, events, bounds)
│   │   ├── providers/
│   │   │   ├── openrouter.js         # OpenAI-shape provider + retry on 429/503
│   │   │   └── anthropic.js          # @anthropic-ai/sdk; tool_use/tool_result blocks
│   │   ├── tools/
│   │   │   ├── registry.js           # Tool registry + schema normalizers
│   │   │   ├── permissions.js        # effect × policy, session grants, cross-server escalation
│   │   │   ├── auditLog.js           # Append-only JSONL with rotation + redaction
│   │   │   ├── schemaLinter.js       # Warnings + effect inference for MCP tools
│   │   │   ├── mcpClient.js          # Stdio + Streamable HTTP MCP client manager
│   │   │   └── builtins/
│   │   │       └── capture.js        # astra.capture_primary_screen / capture_active_window
│   │   └── util/
│   │       └── shellEnv.js           # Login-shell PATH capture for packaged Electron
│   ├── preload/
│   │   └── preload.js                # Context-bridged window.glass.* API
│   ├── renderer/                     # UI (Chromium renderer, sandboxed)
│   │   ├── overlay.html
│   │   ├── overlay.css
│   │   ├── overlay.js
│   │   └── assets/
│   │       └── astra-dock.svg
├── scripts/
│   └── check-licenses.mjs            # Blocks GPL/LGPL/AGPL deps
├── tests/                            # Node native test runner; no fixtures dir
│   ├── policy.test.mjs               # Copyleft detector
│   ├── registry.test.mjs             # Tool registry shape + schema normalization
│   ├── permissions.test.mjs          # Policy matrix + escalation rules
│   ├── auditLog.test.mjs             # Hash, redact, rotate, tail
│   ├── router.test.mjs               # Tool-call loop with a fake provider
│   ├── providers.openrouter.test.mjs # OpenAI-shape conversion
│   ├── providers.anthropic.test.mjs  # Anthropic tool_use/tool_result conversion
│   ├── schemaLinter.test.mjs         # Sensitive/path/exec field detection
│   └── mcpClient.test.mjs            # stdio + http transports against a mock SDK
├── docs/
│   └── wiki/                         # Canonical source for the GitHub wiki
├── .github/
│   └── workflows/
│       └── ci.yml                    # licenses + tests on push/PR (macOS)
├── package.json
├── LICENSE
├── README.md
├── DEVELOPER.md                      (this file)
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

Astra Dock is a three-process Electron app with the entire agent stack living in the main process.

| Process | File(s) | Responsibility |
|---|---|---|
| **Main** | `src/main/index.js` + `tools/` + `agents/` + `providers/` + `util/` | Window lifecycle, global shortcuts, system tray, screen capture via `desktopCapturer`, OpenRouter + Anthropic + ElevenLabs HTTP, MCP stdio + Streamable HTTP clients, prefs, `safeStorage` for API keys + MCP bearer tokens, tool registry, permissions, audit log, the tool-call loop |
| **Preload** | `src/preload/preload.js` | Context-bridged API surface (`window.glass.*`). Sandboxed; no Node access in the renderer |
| **Renderer** | `src/renderer/*` | UI rendering, drag/resize via `-webkit-app-region`, prompt textarea, settings panel, reply panel, approval card, model picker, voice picker, MCP server cards, transparency slider |

### Main-process layering (PR-A → PR-C)

```
┌──────────────────────────────────────────────────────────────┐
│  agents/router.js   ◀── tool-call loop (run / cancel / emit) │
│      ▲                                                       │
│      │ uses                                                  │
│      ▼                                                       │
│  tools/                                                      │
│    registry.js           schema normalize + result encode    │
│    permissions.js        effect × policy + session grants    │
│    auditLog.js           JSONL append + rotate + redact      │
│    schemaLinter.js       MCP tool warnings + effect inference│
│    mcpClient.js          stdio + http MCP transport pool     │
│    builtins/capture.js   astra.capture_* tools               │
│                                                              │
│  providers/                                                  │
│    openrouter.js         OpenAI-shape + retry on 429/503     │
│    anthropic.js          @anthropic-ai/sdk native            │
│    openai.js             api.openai.com direct (PR-E)        │
│                                                              │
│  util/                                                       │
│    shellEnv.js           login-shell PATH for child_process  │
└──────────────────────────────────────────────────────────────┘
```

All deps are **injected** into `initAgentStack()` (called from `app.whenReady`) so each module is unit-testable without spinning up Electron.

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
| `setElevenLabsKey(key)` | Encrypt-and-save the ElevenLabs API key |
| `getElevenLabsKeyPresent()` | Boolean: is an ElevenLabs key on file? |
| `setElevenLabsVoice(voiceId)` | Persist the selected voice id |
| `setTtsAutoSpeak(enabled)` | Persist whether answers auto-play on arrival |
| `listVoices(force)` | Fetch ElevenLabs `/v1/voices` (cached 30 min) |
| `transcribeAudio({ audioBuffer, mimeType })` | POST audio to ElevenLabs Scribe; returns transcript |
| `speakText({ text, voiceId? })` | POST text to ElevenLabs TTS; returns `{ base64, mimeType }` MP3 |
| **`runAgent({ prompt, providerId, model, includeScreen })`** | Run the agent loop and return the final assistant text |
| **`approveToolCall({ callId, decision })`** | Renderer's response to an `awaiting_approval` event: `'approve' \| 'deny' \| 'approve_server_session'` |
| **`cancelAgentRun()`** | Abort the in-flight agent run |
| **`getAuditLog({ limit })`** | Tail the audit log (last N entries) |
| **`listTools()` / `setToolPolicy({ toolId, policy })`** | Inspect the registry; override per-tool policy |
| **`setProvider({ providerId })` / `setProviderApiKey({ providerId, key })` / `getProviderKeyPresent({ providerId })` / `clearProviderKey({ providerId })` / `setProviderModel({ providerId, model })`** | Provider abstraction surface (OpenRouter / Anthropic / OpenAI / ElevenLabs). `setProviderModel` persists the per-provider model id; OpenRouter uses its existing `openrouterModel` field, Anthropic and OpenAI use their own `anthropicModel` / `openaiModel` prefs. |
| **`listMcpServers()` / `addMcpServer(config)` / `removeMcpServer(id)` / `connectMcpServer(id)` / `disconnectMcpServer(id)` / `refreshMcpTools(id)` / `registerMcpTool({ serverId, toolName })` / `unregisterMcpTool({ serverId, toolName })` / `updateMcpServerAuth({ id, headers, bearerToken })` / `getMcpStderr(id)`** | MCP server pool management |
| `openExternal(url)` | Open an `https://` link in the user's browser |
| `resizeToContent({ width, height })` | Renderer asks main to size the window to fit |
| `setLayout(mode)` | Legacy no-op (settings now lives inside the pill window) |
| `onState(fn)` / `onHotkeyAsk(fn)` / `onPanicEvent(fn)` / `onForcePill(fn)` / **`onToolEvent(fn)`** / **`onRequestApproval(fn)`** / **`onMcpStatus(fn)`** / **`onMcpRemoved(fn)`** | Subscribe to events from main |

### Adding a new IPC handler

1. Add the handler in `src/main/index.js` inside `setupIpc()`. Always return a `{ ok, ... }` shape so the renderer can branch on success.
2. Expose it from `src/preload/preload.js` via `ipcRenderer.invoke(...)`.
3. Use it in `src/renderer/overlay.js` via `await window.glass.yourMethod(...)`.

### State & prefs

- **Session state** (`sessionImageBase64`, `sessionImageMeta`, `captureArmed`) lives in main-process memory only. Never written to disk. Cleared by `Panic`.
- **Audit log** at `~/Library/Application Support/astra-dock/audit.log` (JSONL, rotated at 10 MB → `audit.log.1`). Never holds API keys or screenshots — args are SHA-256 hashed by default; `redactionMode: 'redact'` keeps a redacted snapshot.
- **Prefs** persist to `~/Library/Application Support/astra-dock/prefs.json` via `app.getPath('userData')`. Notable keys:
  - `openrouterModel` — chat/vision model id
  - `pillOpacity` — `0.0`–`1.0`, drives `--surface-alpha`
  - `elevenlabsVoiceId` — selected TTS voice
  - `ttsAutoSpeak` — auto-play answers on arrival
  - `provider` — `'openrouter'` or `'anthropic'` (active brain)
  - `toolPolicies` / `serverPolicies` — `{ id: 'auto' | 'prompt' | 'always-prompt' }`
  - `mcpServers` — array of `{ id, type, … }` configs. `bearerToken_enc` is encrypted via `safeStorage`; the plaintext `bearerToken` only exists in memory.
- **API keys** stored inside `prefs.json` under `apiKey_<provider>` (`openrouter`, `anthropic`, `openai`, `elevenlabs`, and `astra_server` for the Astra-as-MCP-server bearer), encrypted via `safeStorage.encryptString` when `safeStorage.isEncryptionAvailable()` (true on macOS with the user logged in), otherwise base64-encoded as a fallback. **`sanitizeApiKey()`** strips non-printable / non-ASCII bytes on both read and write — fetch's `Authorization` header can't carry them, and macOS smart-quote substitution loves to sneak Unicode into pasted keys.

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

### Audio pipeline (ElevenLabs)

**Speech → text (Scribe):**

```
renderer btnMic click → navigator.mediaDevices.getUserMedia({ audio: ... })
                             ↳ MediaRecorder('audio/webm;codecs=opus')
                             ↳ chunks gathered while recording
btnMic click again        → recorder.stop()
                             ↳ Blob → ArrayBuffer → IPC glass:transcribeAudio
main glass:transcribeAudio → multipart POST /v1/speech-to-text
                             ↳ headers: xi-api-key
                             ↳ form fields: file=<blob>, model_id=scribe_v1
                             ↳ returns { text }
renderer                  → prompt textarea ← transcript
```

**Text → speech (Flash v2.5):**

```
renderer btnReplySpeak    → IPC glass:speakText({ text })
main glass:speakText      → POST /v1/text-to-speech/{voiceId}
                             ↳ body: { text, model_id: 'eleven_flash_v2_5', voice_settings }
                             ↳ headers: xi-api-key, accept: audio/mpeg
                             ↳ returns binary MP3
main                      → { base64, mimeType: 'audio/mpeg' }
renderer                  → new Audio('data:audio/mpeg;base64,...').play()
```

Notes:
- Audio buffers travel renderer → main as ArrayBuffers (not Blobs); Node's `Buffer.from(payload.audioBuffer)` reconstructs them main-side.
- The ElevenLabs API key never enters the renderer process; only the main process holds it via `safeStorage`.
- Voice catalog is cached in main memory for 30 minutes (`voicesCache`).
- Default voice id `21m00Tcm4TlvDq8ikWAM` ("Rachel") is used until the user picks one explicitly.
- Renderer tracks a single `currentTtsAudio` element so a new speak request cancels any in-flight playback cleanly.

### Agent tool-call loop (PR-A)

```
btnAsk click
   │
   ▼
runAgent({ prompt, providerId, model, includeScreen })
   │
   ▼
router.run:
   for iter in 0..maxIterations (8):
     ▶ provider.chat({ apiKey, model, messages, tools, signal })
     ▶ if response.toolCalls is empty → emit 'final' → return text
     ▶ for each toolCall:
         resolved tool = registry.get(decodeIdFromOpenAI(name))
         decision = permissions.evaluate({ tool, recentServers })
         if decision === 'prompt':
           emit 'awaiting_approval'
           decision = await awaitApproval(descriptor)
         if approved:
           result = await tool.handler(args, { runId, callId, signal })
           append { role: tool_result, content: <tool_output untrusted>… }
         else:
           append synthetic error tool_result
         auditLog.record(...)
       loop continues
```

Bounds: 8 iterations × 90 s wall clock × external `AbortSignal`. One run at a time
(`router.isRunning()`). Recent servers (newest first) drive cross-server escalation
in `permissions.evaluate`.

### Tool registry & schema normalization

Internal tool ids are dot-namespaced (`astra.capture_active_window`, `mcp.github.list_repos`).
Provider tool-name regexes only allow `[A-Za-z0-9_-]`, so the registry encodes
dots → underscores when generating provider specs (`encodeIdForOpenAI`).
`decodeIdFromOpenAI(encoded, registry)` walks the registry to find the original id
when a model emits a `tool_call`.

Tool results are encoded per provider:

- OpenAI / OpenRouter: `{ role: 'tool', tool_call_id, content: <string> }`
- Anthropic: `{ type: 'tool_result', tool_use_id, content, is_error? }` inside a `user` message

Tool output is wrapped in `<tool_output server="…" untrusted>…</tool_output>` before
being fed back to the model, and the system prompt instructs the model to treat
that block as untrusted data — instructions inside MUST NOT bind behavior.

### Permissions

Two orthogonal axes:

- **effect** (intrinsic, set at registration time): `read | write | exec`
- **policy** (user-controlled, persisted): `auto | prompt | always-prompt`

Defaults by effect: `read → auto`, `write → prompt`, `exec → always-prompt`.
Resolution order (most-specific wins): per-tool policy → per-server policy → global → default.

**Session grants**: `permissions.grantServerSession(serverId, ms)` records an in-memory
expiry. While valid, tools from that server with effect `read`/`write` (NOT `exec`)
resolve to `auto`. Grants never auto-execute `always-prompt` tools.

**Cross-server escalation**: `write`/`exec` tools fired within `crossServerWindow`
turns of a *different* server's tool result are force-prompted regardless of policy.
This is the prompt-injection mitigation referenced in the system prompt.

### MCP client (PR-B + PR-C)

`mcpClient.js` manages a pool of MCP server connections:

```
add(config)  →  servers map entry, status='disconnected', persisted
connect(id) →  status='connecting' →
                 type==='stdio'  : spawn via SDK with shell:false + mergedSpawnEnv
                 type==='http'   : StreamableHTTPClientTransport(url, requestInit:{headers})
               client.connect(transport) → listTools → status='connected'
disconnect(id) → close client+transport, unregister tools, status='disconnected'
remove(id)     → disconnect + delete from prefs
```

Discovered MCP tools stay *outside* the central registry until the user clicks
**Add to registry** (or **＋ Register all**). When registered:

```
id        = `mcp.<serverId>.<toolName>`
source    = 'mcp'
serverId  = <serverId>          ← lets permissions distinguish servers
effect    = inferEffect(toolName)  ← schemaLinter heuristic
handler   = (args, ctx) → client.callTool({ name, arguments: args }, undefined, { signal })
jsonSchema = the MCP tool's input schema
renderPreview = generic "Call serverId.toolName with: key=val, …" formatter
```

Bearer tokens for HTTP MCPs travel encrypted at rest (`bearerToken_enc` in
prefs.json via `safeStorage`). In-memory configs carry plaintext `bearerToken`;
`persistableMcpConfig()` / `hydratedMcpConfig()` (in `main/index.js`) swap between
the two as configs cross the disk boundary. The renderer never sees the plaintext —
serialization exposes only a `hasBearerToken: boolean` flag.

The SDK is loaded via dynamic `import()` (the SDK is ESM-only; our main is CJS).
`defaultLoadSdk(type)` lazily loads only the transport the caller needs.

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

Distribution is wired up via **electron-builder**. See [`BUILDING.md`](BUILDING.md) for the full guide. TL;DR:

```bash
npm run dist:unsigned   # local test build (DMG + ZIP for arm64 + x64, ~100 MB each)
npm run dist            # signed build (requires Developer ID Application cert in Keychain)
APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... npm run dist
                        # signed + notarized, the production path
```

Artifacts land in `dist/`. `build/entitlements.mac.plist` enumerates the hardened-runtime entitlements we request (JIT, unsigned-exec memory, library-validation-off for spawning unsigned MCP children, network client, mic). `build/notarize.cjs` is the `afterSign` hook — it no-ops when the Apple env vars are unset, so unsigned local builds still work.

Auto-update is not yet wired but the build config emits `latest-mac.yml` + ZIPs ready for `electron-updater`.

## Common gotchas

- **Cannot type in the pill input** → check that the parent has `-webkit-app-region: drag` and the input has `no-drag`. The whole pill is a drag region; controls override it.
- **Window won't go on top of fullscreen apps** → `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` must be called after `show()` and re-asserted on every `showMainWindow()`.
- **Reply panel renders 67px tall** → the `vh` unit refers to the Electron window's height, which is itself sized from content. Always use pixel caps or screen-derived values for panel heights.
- **OpenRouter says "model not found"** → the user has typed an id that's not in the live catalog. Click the **↻ Refresh** button in settings to re-fetch.
- **Mic button does nothing / "denied"** → macOS hasn't granted microphone access. Open **System Settings → Privacy & Security → Microphone**, enable for the Electron host, then restart Astra Dock. Unsigned dev builds run under Electron's bundle id; signed releases will need a `NSMicrophoneUsageDescription` entry in the bundle Info.plist (set via the packager when distribution is wired up).
- **ElevenLabs voice list is empty** → no key is saved yet, OR the key is invalid. Save the key first, then click **↻ Refresh** in the Voice section.
- **TTS sounds robotic / wrong voice** → confirm the selected voice id in `prefs.json` matches the desired voice. The default fallback is `21m00Tcm4TlvDq8ikWAM` (Rachel) until the user picks otherwise.
- **Agent answers from the screenshot when an MCP is "connected"** → connecting a server doesn't auto-add its tools. Click **＋ Register all** on the server card (or pick tools individually). The amber banner at the top of MCP Servers warns when at least one server is connected with zero tools registered.
- **OpenRouter 429 mid-run** → the agent loop can fire 1–3 chat completions in quick succession (think → call tool → respond). Free-tier models with strict per-minute caps trip this. The provider auto-retries once after 1.5 s on 429/503; if it still fails, switch to a paid tool-capable model (`anthropic/claude-3-5-sonnet`, `openai/gpt-4o-mini`) in ⚙ → Model.
- **OpenRouter 401 "Missing Authentication header"** → key is truncated/malformed. The `apiKey` placeholder shows the saved prefix + length + a ⚠ when the format doesn't match `sk-or-v1-…`. Click **Clear** next to the key field, then paste a fresh key with `⌥⌘V` (paste-without-formatting).
- **"Cannot convert argument to a ByteString" before any request** → key contains a non-Latin-1 character (commonly `…` from macOS smart-quote auto-substitution). The sanitizer strips it on read; a Clear + re-paste fixes the underlying corruption.
- **MCP stdio: "command not found" or silent spawn failure** → packaged Electron launched from Finder doesn't inherit the user's full `PATH`. `shellEnv.js` mitigates this by capturing the login-shell env once. For an absolute fix, configure the MCP server with an absolute command path (`/opt/homebrew/bin/npx` etc.). The card surfaces a warning when the command isn't absolute.
- **MCP HTTP: handshake works in browser but fails in Astra** → Electron's undici sometimes mishandles SSE-only servers. PR-C added Streamable HTTP only; if a server speaks SSE classic, that's PR-roadmap territory.
- **Settings panel "stretches" when opened** → the OS window growth from ~50 px to ~700 px is what you're seeing. `setBounds(..., true)` uses macOS's native smooth resize animation; the CSS animation on the panel is intentionally a no-op to avoid fighting it.

## Owner

MR Dula Solutions / Astra One product team.
