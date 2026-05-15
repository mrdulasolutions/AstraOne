# Astra Dock

> Your screen-aware AI assistant, one keystroke away.

**Astra Dock** is a translucent macOS HUD that floats above every app, captures what you're looking at, and answers questions about it through any model on OpenRouter — no copy-pasting, no app-switching, no friction.

A product of **Astra One** by [MR Dula Solutions](#about), a DBA of MR Dula Enterprise, LLC.

---

## What it does

- **Float anywhere.** A wide pill HUD pinned to the top of your screen. Drag it, hide it, summon it with ⌘\\. Stays above other apps and fullscreen content.
- **Agent mode.** Ask doesn't just chat — it runs a bounded tool-call loop against your chosen model. The agent can call built-in tools (screen / window capture) and any MCP tools you've registered, asking for your approval on writes via an in-pill approval card.
- **MCP host.** Connect to remote MCP servers (GitHub, Notion, internal company APIs) with a URL + bearer token, or to local stdio MCP servers (Claude Code, filesystem, sqlite). Pick which discovered tools the agent is allowed to use.
- **Two brain providers.** OpenRouter (any of their hundreds of models, with the live catalog filterable by Free / Vision / Audio) and Anthropic native (Claude Sonnet / Haiku via their official SDK). Tool-calling works on both.
- **Talk to your screen.** Hit the **Mic** button to dictate a prompt — ElevenLabs Scribe transcribes it straight into the ask field. Toggle **Auto-speak responses** in settings and answers come back as natural ElevenLabs voice.
- **Approval & audit.** Every tool call has an `effect` (read / write / exec) and a `policy` (auto / prompt / always-prompt). Writes default to prompt; an append-only audit log records every call (id, hash of args, duration, approver, status).
- **Tune the look.** Glass-style translucency with a live opacity slider in settings, applied to the pill and the settings panel both.
- **Stay private.** Screen captures live in RAM only. A **Panic** button wipes the buffer in one click. API keys and MCP bearer tokens are encrypted with macOS `safeStorage` when available.

---

## Quick start

### Requirements

- **macOS** 13+ (tested on macOS Sequoia)
- **Node.js** 20 or newer
- A free or paid **OpenRouter** account ([openrouter.ai](https://openrouter.ai))
- *(Optional, for voice)* an **ElevenLabs** account ([elevenlabs.io](https://elevenlabs.io)) — needed only if you want mic transcription or spoken answers

### Install & run

```bash
git clone https://github.com/mrdulasolutions/AstraOne.git
cd AstraOne
npm install
npm start
```

The Astra Dock pill will float to the top of your primary display.

### First-launch checklist

1. **Grant Screen Recording.** macOS will prompt the first time you capture. If you miss it: **System Settings → Privacy & Security → Screen Recording → toggle on for Electron** (and restart the app).
2. **Add your OpenRouter key.** Click ⚙ → paste your key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) → **Save API key**. Paste with ⌥⌘V to bypass macOS smart-quote substitution. The placeholder confirms the prefix and length so you can verify nothing got mangled.
3. **Pick a tool-capable model.** In the same settings panel, filter by **Vision** (essential for screenshot questions) AND prefer a model that supports tool calling — `anthropic/claude-3-5-sonnet`, `anthropic/claude-sonnet-4`, `openai/gpt-4o-mini`, or `google/gemini-2.0-flash-exp:free`. Free auto-routers often lack tool support and will fail the agent loop.
4. *(Optional)* **Connect an MCP server.** ⚙ → MCP Servers → **＋ Connect to a remote MCP server** (URL + bearer token) OR **＋ Add local MCP server** (stdio command). Click **Connect**, then **＋ Register all** to add its discovered tools to the agent's registry.
5. *(Optional)* **Enable voice.** In the ElevenLabs section: paste an ElevenLabs key, save, pick a voice from the auto-loaded catalog, and toggle **Speak answers automatically** if you want every reply read aloud. macOS will ask for microphone access the first time you tap Mic.

### Daily usage

| Action | Shortcut |
|---|---|
| Toggle the dock | ⌘\\ |
| Ask the current prompt | ⌘↵ (or click **Ask**) |
| Move the dock | Arrow keys, or drag |
| Panic (wipe capture buffer) | ⌘⎋ |

**Ask** auto-captures your active window if no screenshot is already buffered. To override, click **Screen** (full desktop) or **Window** (foreground app) before asking.

---

## Configuration

Everything lives in the settings panel (⚙ button on the pill):

| Setting | What it does |
|---|---|
| **Provider** | `openrouter` (default) or `anthropic` native. Each has its own key and (for Anthropic) its own model id field. |
| **OpenRouter key** | Authenticates chat completions, the model catalog, and the agent's tool-call loop. Stored encrypted via `safeStorage` when available. Placeholder shows the on-file prefix + length + a warning if the format doesn't match. |
| **Anthropic key** | Same pattern as OpenRouter, used when Provider is set to Anthropic. |
| **Model** | The chat/vision model used for **Ask**. Browse the live OpenRouter catalog with filter chips (All / Free / Vision / Audio) and per-model metadata (FREE badge, vision/audio support, context size, price-per-million). |
| **Agent · Tools & Permissions** | Lists every tool registered in the agent (built-ins + MCP). Per-tool policy dropdown: `default` (effect-based), `auto`, `prompt`, `always-prompt`. **Recent activity** below shows the last 20 audit-log entries. |
| **MCP Servers** | Two add-flows: **Remote** (URL + bearer token + optional headers) and **Local stdio** (command + args + env). Per-server cards expose Connect / Disconnect / **＋ Register all** / Refresh / Remove, plus the discovered-tool list with effect badges and schema-warning chips. |
| **Pill transparency** | Adjusts the glass alpha across the pill, reply panel, approval card, and settings panel. |
| **ElevenLabs key** | Authenticates Scribe (STT) and TTS calls. Stored encrypted via `safeStorage` when available. |
| **Voice** | The ElevenLabs voice used for spoken answers. Live catalog from `/v1/voices`, searchable, filterable by category. |
| **Speak answers automatically** | When on, every answer is read aloud immediately. The reply panel's 🔊 button works manually either way. |
| **Keyboard shortcuts** | Reference card; shortcuts are non-rebindable in v0.1. |

Preferences persist to `~/Library/Application Support/astra-dock/prefs.json`.

---

## How agent mode works

When you hit **Ask**, the dock no longer fires a single chat-completion. It runs a bounded tool-call loop:

```
Ask  →  model sees: prompt + (optional) screenshot + list of registered tools
        ┃
        ┣  no tool needed     →  final text → reply panel
        ┃
        ┗  picks a tool       →  permissions check  →  auto OR awaits your approval
                               →  registry handler runs (built-in or MCP proxy)
                               →  tool result wrapped in <tool_output untrusted>...</tool_output>
                               →  back to the model for the next turn
```

Bounds: max **8 model turns**, max **90 seconds** wall clock, fully cancellable via `Cmd+\\` (hide) or **Panic** (clears the run). Every tool call lands in `audit.log` regardless of outcome.

**Effect × policy.** Tools declare an intrinsic `effect` — `read` (auto), `write` (prompt), or `exec` (always-prompt). You can override per tool, per server, or globally in **⚙ → Agent · Tools & Permissions**. Write/exec calls triggered within 2 turns of a *different MCP server's* tool result are force-prompted even when policy is auto — a mitigation against prompt-injection-driven writes whose context came from elsewhere.

**Tool sources today:**
- `builtin` — `astra.capture_primary_screen`, `astra.capture_active_window` (more in PR-D).
- `mcp` — any tool from a connected MCP server that you've registered via **＋ Register all** or per-row **Add to registry**.

## Privacy & security

- **Captures never leave RAM** until you click **Ask** with the **Include image** behavior active. They are not written to disk.
- **Panic** (⌘⎋ or the red Panic button) immediately clears the capture buffer.
- **API keys** are encrypted with Apple's Keychain-backed `safeStorage` when available; otherwise base64-encoded as a fallback. No keys are transmitted except as `Authorization: Bearer` headers to `openrouter.ai`.
- **Prompt-injection defense.** Astra Dock instructs the model to treat screen pixels and pasted text as untrusted data and refuses to follow instructions embedded inside captured content.
- **No telemetry.** The app makes no analytics or crash-reporting calls.

---

## Roadmap

| Feature | Status |
|---|---|
| Pill HUD with translucency control | ✅ shipping |
| Active-window auto-capture | ✅ shipping |
| Live OpenRouter model catalog with vision/audio metadata | ✅ shipping |
| In-shell reply panel with auto-sizing + copy | ✅ shipping |
| Always-on-top above menu bar and fullscreen apps | ✅ shipping |
| 🎙 Voice input via ElevenLabs Scribe | ✅ shipping |
| 🔊 Spoken responses via ElevenLabs Flash v2.5 | ✅ shipping |
| **Tool-call agent loop** with provider abstraction (OpenRouter + Anthropic) | ✅ shipping |
| **Approval card** for write/exec tools with risk-colored border + Cmd+Y/N hotkeys | ✅ shipping |
| **Append-only audit log** of every tool call (id, args-hash, duration, approver) | ✅ shipping |
| **MCP client** — stdio + Streamable HTTP transports, schema linter, per-tool policies | ✅ shipping |
| **Astra as an MCP server** — let Claude Code / Codex / Cursor call into the dock | 🚧 PR-D in progress |
| Connector cookbook (recommended community MCP configs) | 🔜 PR-E |
| Signed `.dmg` distribution | 🔜 planned |
| Windows / Linux builds | 🔜 evaluating |

---

## License

Astra Dock is **proprietary, commercial software**. Copyright © 2026 MR Dula Solutions, a DBA of MR Dula Enterprise, LLC. All rights reserved.

See [LICENSE](LICENSE) for the full terms. Third-party component notices live in [NOTICE.md](NOTICE.md).

If you are interested in commercial licensing, evaluation, or partnership, see [About](#about) below.

---

## About

**Astra One** is the assistant product line from **MR Dula Solutions**, a DBA of MR Dula Enterprise, LLC. Based in Wake County, North Carolina.

For licensing inquiries, support, or partnership questions: **[matt@mrdula.solutions](mailto:matt@mrdula.solutions)**.

---

## Acknowledgments

Built on [Electron](https://www.electronjs.org/) (MIT) with Chromium components. LLM routing via [OpenRouter](https://openrouter.ai/). Voice transcription and text-to-speech via [ElevenLabs](https://elevenlabs.io/) (Scribe + Flash v2.5). Full third-party attribution in [NOTICE.md](NOTICE.md).
