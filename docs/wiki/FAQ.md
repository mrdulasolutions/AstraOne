# FAQ / Troubleshooting

## Setup

### Why does **Ask** fail with `OpenRouter 401 Missing Authentication header`?

Your saved key is malformed or empty after sanitization. Most common cause: macOS auto-substituted three dots into an ellipsis (`…`) when you pasted a previewed/truncated key, and the sanitizer stripped it — leaving a short bad key.

Fix:
1. ⚙ → click **Clear** next to OpenRouter key.
2. Open [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) → click your key to reveal the full ~73-char string starting with `sk-or-v1-`.
3. Paste with `⌥⌘V` (paste-without-formatting) — this bypasses smart-quote substitution.
4. The placeholder will confirm `On file: sk-or-v1-ab… (73 chars)` with no warning.

### Why does **Ask** fail with `OpenRouter 429`?

The selected model hit a rate limit. The provider auto-retries once after 1.5 s; if it still 429s, your model has a strict free-tier cap. Switch to a paid tool-capable model in ⚙ → Model:

- `anthropic/claude-3-5-sonnet`
- `anthropic/claude-sonnet-4`
- `openai/gpt-4o-mini`

Or wait ~60 s and try again.

### Why does the model just describe what's on screen instead of calling my MCP tool?

Connecting an MCP server does **not** register its tools with the agent — that step is manual. Open ⚙ → MCP Servers → on the connected server card, click **＋ Register all**. The amber banner at the top of the section warns when this is the case.

### Why does the agent give "no tools" / fail to call functions on a free model?

Many free OpenRouter models don't support function calling. Confirmed working free options:

- `google/gemini-2.0-flash-exp:free` (vision + tools)

Otherwise switch to a paid tool-capable model.

## Errors

### `Cannot convert argument to a ByteString because the character at index N has a value of 8230`

A non-Latin-1 character (8230 = `…`) is in an HTTP header value. Almost always a corrupted API key (smart-quote substitution from a paste). The sanitizer strips it on read; the lasting fix is to clear and re-paste the key as plain text.

### MCP stdio: `command not found` or silent connection failure on a packaged build

Packaged Electron launched from Finder doesn't inherit your shell's full `PATH`. `shellEnv.js` mitigates by capturing the login-shell env, but you can also just use absolute paths in the server config:

- `/opt/homebrew/bin/npx` (Homebrew on Apple Silicon)
- `/usr/local/bin/npx` (Homebrew on Intel)
- `/Users/<you>/.nvm/versions/node/v20.x.x/bin/node` (nvm)

The card warns when the command isn't absolute.

### MCP HTTP: connects in browser but fails in Astra

PR-C ships only **Streamable HTTP** transport. Servers that speak the older SSE classic transport aren't supported yet (roadmap).

## UI

### The settings panel "stretches outward" when I open it

That's the OS window growing from pill-height (~50 px) to settings-height (~700 px). PR-C switched to `setBounds(..., true)` so macOS animates the resize natively, and removed the conflicting CSS animation. If you still see jank, please report — it's hardware-dependent.

### Why does the pill cover my menu bar?

Intentional. Astra Dock anchors at `display.bounds.y` (0) with `setAlwaysOnTop(true, 'screen-saver')`, so it paints above the menu bar. The trade-off: clicking the dock area near the top hits the pill, not the menu. Press `⌘\` to hide the pill and reveal the menu bar.

## Privacy & data

### Where does the audit log live? What's in it?

`~/Library/Application Support/astra-dock/audit.log` (JSONL, rotated at 10 MB → `audit.log.1`). Each entry has the tool id, source, server id, SHA-256 hash of args, approver, result byte count, duration, and status. The args themselves are NOT persisted by default — you'd need to flip `redactionMode: 'redact'` in code to keep them (still with sensitive-field redaction).

### Are screenshots ever written to disk?

No. They live as base64 strings in `sessionImageBase64` in the main process. **Panic** (`⌘⎋`) clears the buffer. They get sent to your chosen provider when you Ask and `includeScreen: true`.

### Are MCP bearer tokens stored in plaintext?

No. `bearerToken_enc` in `prefs.json` is `safeStorage.encryptString` output (macOS Keychain-backed). The renderer never sees the plaintext — server-card serialization exposes only `hasBearerToken: boolean`.

## Contributing / extending

### How do I add a new built-in tool?

1. Add the registration in `src/main/tools/builtins/<name>.js`.
2. Call its `register(registry, ctx)` from `initAgentStack()` in `src/main/index.js`.
3. Restart; the tool appears in **⚙ → Agent · Tools & Permissions**.

### How do I add a new provider?

1. Create `src/main/providers/<name>.js` exporting `chat({ apiKey, model, messages, tools, signal, maxTokens })` with the standard return shape.
2. Add it to the `providers` map in `initAgentStack()`.
3. Optional: wire a UI for its key/model in `overlay.html` / `overlay.js`.
4. Update the provider dropdown in the settings panel.

See [Architecture](Architecture) for the full module map.
