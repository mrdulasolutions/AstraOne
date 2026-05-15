# Getting Started

> Last updated: 2026-05-15. Reflects PR-C shipping.

## Requirements

- **macOS** 13 or newer (tested through Sequoia)
- **Node.js** 20+
- A free or paid **[OpenRouter](https://openrouter.ai)** account (provider for the agent)
- *(Optional)* **[ElevenLabs](https://elevenlabs.io)** account if you want voice in/out
- *(Optional)* **[Anthropic](https://console.anthropic.com)** account if you want Claude native instead of OpenRouter

## Install

```bash
git clone https://github.com/mrdulasolutions/AstraOne.git
cd AstraOne
npm install
npm start
```

The pill HUD appears at the very top of your primary display.

## First-launch checklist

1. **Grant Screen Recording.** macOS will prompt the first time you ask the agent to capture. If you miss it: **System Settings → Privacy & Security → Screen Recording → enable the Electron host** and restart.
2. **Add your OpenRouter key.** Click ⚙ → **OpenRouter key** → paste from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) using **⌥⌘V** (paste-without-formatting — avoids macOS smart-quote substitution mangling the key). Save. The placeholder confirms the prefix and length.
3. **Pick a tool-capable model.** ⚙ → **Model** picker. Filter by **Vision** and pick a model that supports function calling. Known-good free option: `google/gemini-2.0-flash-exp:free`. Reliable paid options: `anthropic/claude-3-5-sonnet`, `anthropic/claude-sonnet-4`, `openai/gpt-4o-mini`. Free auto-routers (`openrouter/free`) often lack tool support and will fail the agent loop.
4. *(Optional)* **Connect an MCP server.** See [MCP Servers](MCP-Servers).
5. *(Optional)* **Enable voice.** ⚙ → **ElevenLabs key** → paste, save. Pick a voice. Toggle **Speak answers automatically** for auto-playback.

## Daily usage

| Action | Shortcut |
|---|---|
| Toggle the dock | `⌘\` |
| Ask the current prompt | `⌘↵` (or click **Ask**) |
| Approve / deny a pending tool call | `⌘Y` / `⌘N` (when an approval card is focused) |
| Move the dock | Arrow keys, or drag |
| Panic (wipe capture buffer + cancel any agent run) | `⌘⎋` |

## Quick test

After setup, type **"what's on my screen?"** and hit `⌘↵`. The model should call `astra.capture_active_window` (auto-approved since it's `effect: read`), then answer based on the result. You'll see the chip cycle: `Thinking… → Calling capture_active_window… → ✓ capture_active_window → final`.

If the answer is generic / vague: see [FAQ → "Agent answers from the screenshot when an MCP is connected"](FAQ).
