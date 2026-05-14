# NOTICE — Third-Party Components

**Astra Dock**
Copyright © 2026 MR Dula Solutions, a DBA of MR Dula Enterprise, LLC. All rights reserved.

Astra Dock is proprietary commercial software (see [LICENSE](LICENSE)) that incorporates third-party open-source components, each governed by its own license terms.

## Runtime / build dependencies

- **Electron** — MIT License. Includes Chromium components under licenses described in Electron's distribution notices. <https://github.com/electron/electron/blob/main/LICENSE>
- **license-checker** — BSD-3-Clause. <https://github.com/davglass/license-checker>

A full machine-readable summary of the licenses of all transitive runtime and build dependencies can be regenerated with:

```bash
npm run check:licenses
```

The `scripts/check-licenses.mjs` script enforces a permissive-only policy: any GPL, LGPL, or AGPL component will cause the script to exit non-zero. Add new dependencies under MIT, ISC, BSD, or Apache-2.0 only.

## OpenRouter

Astra Dock calls the [OpenRouter](https://openrouter.ai) HTTP API to route chat-completion requests to third-party model providers chosen by the user. OpenRouter, the upstream model providers, and any models invoked are governed by their own terms; Astra Dock does not redistribute them.

## ElevenLabs

Astra Dock optionally calls the [ElevenLabs](https://elevenlabs.io) HTTP API for two features: speech-to-text transcription (Scribe model) and text-to-speech synthesis (Flash v2.5 model). Audio uploaded to ElevenLabs and audio synthesized by ElevenLabs are governed by ElevenLabs' terms of service; Astra Dock does not redistribute ElevenLabs models or voice data.
