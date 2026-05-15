# Architecture

Three-process Electron app. The entire agent stack lives in the **main** process; the renderer is sandboxed and talks to main only through the preload bridge.

```
┌────────────────────────────────────────────────────────────┐
│ Renderer (sandboxed, contextIsolation:true)                │
│   pill • reply panel • settings • approval card            │
│   subscribes: tool:event, glass:requestApproval, mcp:*     │
└────────────────────────────┬───────────────────────────────┘
                             │ IPC (window.glass.*)
┌────────────────────────────┴───────────────────────────────┐
│ Main process                                               │
│                                                            │
│  agents/router.js                                          │
│   ▶ runAgent  ▶ awaitApproval  ▶ emit tool:event           │
│                                                            │
│  tools/                                                    │
│   registry.js        permissions.js   auditLog.js          │
│   mcpClient.js       schemaLinter.js  builtins/capture.js  │
│                                                            │
│  providers/                                                │
│   openrouter.js      anthropic.js                          │
│                                                            │
│  util/shellEnv.js    safeStorage  desktopCapturer          │
└────────────────────────────────────────────────────────────┘
```

## Module responsibilities (PR-A → PR-C)

### `tools/registry.js`

Single source of truth for what tools the agent can call. Tools register with `{ id, source, effect, description, jsonSchema, renderPreview?, handler }`. The registry generates **provider-specific specs** (`toOpenAIToolSpecs`, `toAnthropicToolSpecs`) — schema normalization lives HERE so providers stay thin.

Tool ids are dot-namespaced; OpenAI's name regex only allows `[A-Za-z0-9_-]`, so we encode `astra.capture_active_window` → `astra_capture_active_window` for transport and decode back via `decodeIdFromOpenAI`.

### `tools/permissions.js`

`evaluate({ tool, recentServers })` returns `'auto'` or `'prompt'`. Reads policy from injected getters (`getToolPolicy`, `getServerPolicy`, `getGlobalPolicy`) so prefs storage is decoupled. Holds an in-memory session-grants map (`grantServerSession`); never persisted. Implements cross-server escalation: `write`/`exec` after a different server's tool result is force-prompted.

### `tools/auditLog.js`

Append-only JSONL. SHA-256 hash of canonicalized args by default; redacted args optional. Sensitive field names (`api_key`, `authToken`, `clientSecret`, …) are always replaced with `[REDACTED]`. Rotation at 10 MB → `audit.log.1`. `tail(n)` reads the file for the **Recent activity** view.

### `tools/builtins/capture.js`

Registers `astra.capture_primary_screen` and `astra.capture_active_window` using `desktopCapturer`. Same JPEG@82 / 1920×1200 pipeline that the legacy IPC handlers used; the existing `glass:capturePrimaryScreen` / `glass:captureActiveWindow` still work for backward compat.

### `tools/schemaLinter.js`

Walks an MCP tool's JSON schema and flags suspicious fields. `inferEffect(toolName)` classifies tools heuristically (`read_*` → read, `write_*` → write, `exec_*` → exec; unknown → write as a safety default).

### `tools/mcpClient.js`

Pool of MCP server connections. Per server: `{ id, config, status, client, transport, discoveredTools[], stderrRing }`. Transports:

- **stdio**: spawn via SDK with `shell: false` + `mergedSpawnEnv(env)` (login-shell `PATH` merged in)
- **http**: `StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`

`add` / `remove` / `connect` / `disconnect` / `refreshTools` / `registerTool` / `unregisterTool`. Registered tools take the form `mcp.<serverId>.<toolName>` and proxy through the underlying client's `callTool`. SDK is loaded via dynamic `import()` so our CJS main can consume the ESM SDK; `defaultLoadSdk(type)` loads only the transport needed.

### `providers/openrouter.js`

OpenAI-shape chat completions against `openrouter.ai/api/v1/chat/completions`. Adds the `tools` parameter for function calling. Auto-retries once on 429 / 503 after 1.5 s before propagating. Converts internal normalized messages → OpenAI content blocks (`text` + `image_url` for vision + `tool` role for results).

### `providers/anthropic.js`

Native `@anthropic-ai/sdk` integration. Quirks handled:

- `system` is a top-level string (not a message)
- Assistant tool calls live as `tool_use` content blocks
- Tool results sit in `user` messages as `tool_result` blocks
- Strict user/assistant alternation — consecutive same-role messages are merged

### `agents/router.js`

The orchestrator. `run({ prompt, providerId, model, includeScreen })` returns the final assistant text. Bounded: 8 iterations × 90 s wall clock × `AbortSignal`. Single in-flight run guard. Emits `tool:event` (phase: `thinking` | `calling` | `awaiting_approval` | `result` | `final`).

Wraps tool output in `<tool_output server="…" untrusted>…</tool_output>` and the system prompt instructs the model to treat that as data, not instructions.

### `util/shellEnv.js`

Spawns the user's login shell once (`$SHELL -ilc 'env -0'`) and caches the result. Without this, packaged Electron launched from Finder has a minimal `PATH` and silently fails to spawn `npx`/`node`/`python3`.

## Security posture

| Surface | Mitigation |
|---|---|
| API keys + MCP bearer tokens | `safeStorage` encrypted at rest; `sanitizeApiKey()` strips non-ASCII on read+write so smart-quote substitution can't break fetch |
| Renderer | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. CSP `connect-src 'none'` — renderer has zero outbound network |
| Stdio MCP spawn | `shell: false`. Schema linter flags suspicious fields before registration |
| HTTP MCP auth | Bearer token never crosses to the renderer; serialization exposes only `hasBearerToken` |
| Prompt injection | `<tool_output untrusted>` envelope + cross-server escalation + system-prompt instruction |
| Audit | Append-only JSONL of every tool call (hash, approver, status, duration) |

## Tests

Native `node:test`, no fixtures dir, no mocks. 92 tests across:

- `registry.test.mjs` (13) — shape, schema normalization, encoders
- `permissions.test.mjs` (10) — policy matrix, grants, escalation
- `auditLog.test.mjs` (10) — canonicalize, hash, redact, rotate, tail
- `router.test.mjs` (10) — loop, approval pause, denial, cancel, iteration cap
- `providers.openrouter.test.mjs` (7) — message conversion + response parsing
- `providers.anthropic.test.mjs` (9) — tool_use/tool_result + role merging
- `schemaLinter.test.mjs` (9) — field detection + effect inference
- `mcpClient.test.mjs` (19) — stdio + http transports with a mocked SDK
- `policy.test.mjs` (1) — copyleft detector (carried over)

All run in CI on `macos-latest` for every push/PR.
