# Astra Dock

> Your screen-aware AI assistant, one keystroke away.

**Astra Dock** is a translucent macOS HUD that floats above every app, captures what you're looking at, and answers questions about it through any model on OpenRouter — no copy-pasting, no app-switching, no friction.

A product of **Astra One** by [MR Dula Solutions](#about), a DBA of MR Dula Enterprise, LLC.

---

## What it does

- **Float anywhere.** A wide pill HUD pinned to the top of your screen. Drag it, hide it, summon it with ⌘\\. Stays above other apps and fullscreen content.
- **Ask about what's on screen.** One click: Astra Dock screenshots your active window and sends it to a vision-capable LLM with your question. Answers drop into a panel below the pill.
- **Talk to your screen.** Hit the **Mic** button to dictate a prompt — ElevenLabs Scribe transcribes it straight into the ask field. Toggle **Auto-speak responses** in settings and answers come back as natural ElevenLabs voice (any voice from your account's catalog).
- **Bring your own model.** Pulls the live OpenRouter catalog so you can pick any model — free or paid, text or vision, mainstream or specialty — with metadata badges (FREE / VISION / AUDIO / context size / pricing) to help you choose.
- **Tune the look.** Glass-style translucency with a live opacity slider in settings, applied to the pill and the settings panel both.
- **Stay private.** Captures live in RAM only. A **Panic** button wipes the buffer in one click. API keys are encrypted with OS-level safe storage when available.

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
2. **Add your OpenRouter key.** Click ⚙ → paste your key from [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) → **Save API key**.
3. **Pick a model.** In the same settings panel, filter by **Vision** (essential for screenshot questions), search by name, and click a model row to set it.
4. *(Optional)* **Enable voice.** In the ElevenLabs section: paste an ElevenLabs key, save, pick a voice from the auto-loaded catalog, and toggle **Speak answers automatically** if you want every reply read aloud. macOS will ask for microphone access the first time you tap Mic.

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
| **OpenRouter key** | Authenticates chat completions and the model catalog. Stored encrypted via `safeStorage` when available. |
| **Model** | The chat/vision model used for **Ask**. Browse the live catalog with filter chips and per-model metadata. |
| **Pill transparency** | Adjusts the glass alpha across the pill, reply panel, and settings panel. |
| **ElevenLabs key** | Authenticates Scribe (STT) and TTS calls. Stored encrypted via `safeStorage` when available. |
| **Voice** | The ElevenLabs voice used for spoken answers. Live catalog from `/v1/voices`, searchable, filterable by category. |
| **Speak answers automatically** | When on, every answer is read aloud immediately. The reply panel's 🔊 button works manually either way. |
| **Keyboard shortcuts** | Reference card; shortcuts are non-rebindable in v0.1. |

Preferences persist to `~/Library/Application Support/astra-dock/prefs.json`.

---

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
