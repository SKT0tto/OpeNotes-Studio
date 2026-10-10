# Changelog

## 0.1.1

- Preview frame: the editor preview, `/play`, Stage Lab, Actor Lab and storyboard thumbnails now keep the exact project frame shape (16:9, or 2.16:1 on the play page) in any window size, panel drag / collapse and browser zoom, letterboxed / pillarboxed and never stretched or cropped. One shared `AspectBox` (ResizeObserver) hosts every canvas
- LLM settings: the server re-reads `.env` on every request (no restart after editing a key); real environment variables win over `.env`, and a value saved in the AI settings panel wins over both
- The AI settings no longer claim "configured" without a usable key: empty and placeholder keys (`sk-ant-...`) count as missing, a hosted OpenAI-compatible endpoint needs a key, and the status says "filled in, not verified" / "verified" / "last call failed" from the real connection test and real generation results
- Generation failures are shown as failures: a 401 / timeout / network error never ends in "all scenes generated" or a passing continuity check; the dialog names the reason and the fix (for example "API key invalid or missing -> open AI settings"), lists succeeded and failed scenes separately and retries only the failed ones
- Changing a costume no longer flashes a black preview: the new model is loaded first while the previous frame stays on screen

## 0.1.0

First public release (renamed from the internal "Our Notes AI Story Studio").

- Asset indexer/browser, Live2D stage, original-style staging, timeline editor with locks and undo/redo
- AI director (Claude / OpenAI-compatible) and labelled rule director, diff review, continuity check
- One-click novel generation (txt/md import, GBK detection, cancel/resume)
- Redesigned start screen with environment checks
- Project export/import as `.openotes.json` (legacy `.ournotes.json` still accepted)
- Licensed GPL-3.0-or-later

## Unreleased

- First-run setup wizard (Cubism Core, asset import, AI key) and a real Core check on the home page
- Asset import from a local folder or zip: model3.json normalisation (site-style packages), SHA-256 / header validation, duplicate and conflict detection, label matching, import report
- Optional Haneoka checklist (links to site pages only, no downloads; server-enforced disclaimer)
- Cubism Core: one-click copy from Live2D's official URL or a user-chosen official file, after confirming the Live2D licence
- Step-by-step guide `docs/GUIDE_ASSETS.md`
