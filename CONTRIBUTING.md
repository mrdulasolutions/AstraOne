# Contributing

Astra Dock is **proprietary commercial software** owned by MR Dula Solutions, a DBA of MR Dula Enterprise, LLC. This repository accepts contributions from authorized personnel and approved external collaborators only.

## Outside contributions

Pull requests from outside the authorized contributor list will be closed without review. If you've spotted a bug or have a feature suggestion, please file an issue instead.

By submitting a contribution to this repository, you agree that:

1. Your contribution is your original work (or you have explicit permission to submit it).
2. You assign all right, title, and interest in the contribution to MR Dula Enterprise, LLC, who may relicense it under proprietary terms.
3. Your contribution does NOT contain code copied or translated from a copyleft-licensed project (GPL, LGPL, AGPL, or similar).

For larger contributions, MR Dula Solutions may require a signed Contributor License Agreement (CLA) before merging.

## Engineering guidelines

### License hygiene

- This project is intentionally **clean-room** with respect to upstream "glass overlay" / "Pickle Glass" / "Cheating Daddy" forks. Do not submit code copied or translated from those projects or from any GPL-licensed source.
- New runtime or build dependencies must use **MIT, ISC, BSD, Apache-2.0**, or a license explicitly approved in code review. Flag any **GPL/LGPL/AGPL** family dependency for legal review before merging.
- Run `npm run check:licenses` before opening a release-candidate PR.

### Code quality

- Match the existing style. No formatter is wired up yet; default to the conventions you see in `src/main/index.js`.
- All renderer ↔ main communication goes through IPC handlers exposed in `src/preload/preload.js`. Do NOT introduce `nodeIntegration` or unsafe `eval`/`Function` paths in the renderer.
- Never log or persist user prompts, screenshots, or API keys.
- See [DEVELOPER.md](DEVELOPER.md) for architecture details and the IPC surface.

### Run locally

```bash
npm install
npm start
```

First launch on macOS: enable **Screen Recording** in **System Settings → Privacy & Security → Screen Recording** for the Electron host, then restart the app. Add an OpenRouter API key in the dock's settings panel (⚙).

### Tests & CI

```bash
npm test                # Node test runner
npm run check:licenses  # dependency audit
```

CI runs the same checks on every push and PR on `macos-latest`. Both must pass before merge.

## Questions

For licensing, partnership, or commercial inquiries, see the contact information in [LICENSE](LICENSE).
