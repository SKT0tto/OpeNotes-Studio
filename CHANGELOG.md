# Changelog

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
