# OpeNotes Studio

> **Unofficial fan project.** BanG Dream!, "Our Notes" and all related characters, names and assets are the property of Bushiroad, Craft Egg and other rights holders. This project is not affiliated with or endorsed by them.
> **This repository contains no game assets and no Live2D Cubism Core.** You must supply legally obtained, properly extracted assets yourself and comply with their terms. The Cubism Core must be obtained from Live2D's official site and used under Live2D's license.

OpeNotes Studio turns a novel into a Live2D staged performance in the style of *BanG Dream! Our Notes*: an AI (or rule-based) director splits scenes, picks backgrounds and outfits, writes shots and acting, and you polish every line in a timeline editor, then play it back or export the project.

Author: bilibili [@羽丘魅魔高松灯](https://space.bilibili.com/358479834) · License: [GPL-3.0-or-later](LICENSE)

Website: <https://skt0tto.github.io/OpeNotes-Studio/> 

**New here? Read the step-by-step guide: [docs/GUIDE_ASSETS.md](docs/GUIDE_ASSETS.md)** (install, Cubism Core, getting and importing assets, AI keys, one-click generation, troubleshooting; written in Chinese).

## Features

- One-click generation from a `.txt` / `.md` novel (UTF-8 / GBK detected, chapters, cancel and resume, stats)
- AI director (Claude, OpenAI-compatible: DeepSeek, LM Studio, vLLM) and a labelled non-AI rule director
- Editor: script, inspector, stage tools, timeline, storyboard, field locks, undo/redo, diff view with per-scope accept/reject
- AI assistant: tell the AI in plain language what to change (text, expressions, timing, effects, background, camera, locks); it shows every change as an undoable card, respects locks, and can look at the stage and your screenshots
- VS Code-style dockable layout (drag, dock, resize, maximise, presets) and multi-select / box-select of lines
- Original-style staging (framing, two-shot / group layouts, dialogue box) and a player at `/play/<id>`
- Asset browser and catalog indexer; first-run setup wizard (Cubism Core, asset import, AI key); one-click import of your own asset folder / zip with normalisation, checksums, duplicate detection
- Project export/import (`.openotes.json`, old `.ournotes.json` files still import); exports hold asset ids only, never asset files

Screenshots are intentionally not committed because they would contain game assets; run the app to see it.

## Setup

### Option 1: download package (recommended for beginners)

1. Install [Node.js](https://nodejs.org) 22 or newer (LTS).
2. Download `OpeNotes-Studio-v<version>.zip` from [Releases](https://github.com/SKT0tto/OpeNotes-Studio/releases/latest) and unzip it anywhere (a path without spaces is safest).
3. Windows: double-click `Start-Windows.cmd`. macOS / Linux: run `./start.sh` in a terminal (or `bash start.sh`).
4. On the first run it installs the dependencies (needs internet) and asks whether you accept the [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html) and want the Live2D Cubism Core downloaded from Live2D's official address. Answer `Y` (or `N` and do it later in the web wizard).
5. The browser opens at <http://127.0.0.1:5274>; follow the setup wizard to import your assets. Keep the window open while you work; closing it stops the server.

The package contains the built app only (no game assets, no Cubism Core). **To upgrade, unzip the new version over the old folder and keep `data/` and `studio.config.json`** (your projects, settings and asset-library path). Automation flags for the start scripts: `--yes` (accept the licence and download the Core), `--no-core` (skip it), `--no-browser`. The port is `API_PORT` or `port` in `studio.config.json` (default 5274). Maintainers: `npm run package-release` builds the same zip locally into `release/`; pushing a `v*` tag publishes it via `.github/workflows/release.yml`. Background labelling: the standalone labelling workbench (thumbnail grid, batch chips, review queue with keyboard shortcuts, undo; every change is saved at once to `asset-labels/backgrounds.json`) is a tool page of its own at http://localhost:5273/label (dev server; port 5274 for a production start). It is deliberately not linked from the editor, the asset browser or the home page.

### Option 2: developers (git clone)

Requires Node.js 22+ (developed on 24) and, for `npm run test:e2e`, Microsoft Edge.

```
npm install
npm run dev        # server on :5274, Vite on :5273 (open http://127.0.0.1:5273)
```

Production-style run from a clone: `npm run build && npm start` (one port, 5274, serves the web app and the API from `dist/`).

### First run: the setup wizard

Open the page; the home page "环境检查" card and the **配置向导** walk through three steps with a status each: (1) Cubism Core, (2) import assets, (3) AI key. On a fresh clone the wizard opens by itself because the asset library is empty. Details and screenshots-free walkthrough: [docs/GUIDE_ASSETS.md](docs/GUIDE_ASSETS.md).

### Asset library

The studio reads an asset library (`models/`, `backgrounds/`, `media/`, optional `manifest.json`) from `ASSET_ROOT`, default `./assets` (gitignored). Assets are never part of this repository. Put assets there by:

- **Importing** (recommended): wizard step 2 -> choose a folder or `.zip` you already have. The importer detects models (`*model3.json`) and backgrounds, **normalises** each model (site-style `model3.json` files with absolute texture paths and one big motion group become the layout this project needs; the result is written as a copy, your original files are untouched), validates PNG / `MOC3` headers, computes SHA-256, detects duplicates (identical content is skipped; different content under an existing id is a conflict you must opt in to overwrite), matches background ids with `asset-labels/backgrounds.json`, and shows a report (models, backgrounds, motions, expressions, skipped, errors). A different library folder can be chosen in the same step; it is written to `studio.config.json` and needs a server restart.
- **Asset pack** (your own library as one zip): `npm run pack-assets -- --out D:\packs\openotes-assets.zip` packs the library at `ASSET_ROOT` (`models/`, `backgrounds/`, `media/`, `manifest.json`) plus an `openotes-pack.json` description (counts, size, per-file SHA-256) into a zip (stored/deflated by type, ZIP64 for >4 GB, never inside the repo). The importer takes such a zip (or the unpacked folder) with the layout at the root or inside one wrapper directory, streams the extraction (no whole-file reads), validates `openotes-pack.json` when present (a mismatch blocks the import), shows progress, and can be cancelled. Format: [docs/GUIDE_ASSETS.md](docs/GUIDE_ASSETS.md#45-整包素材包native-layout--openotes-packjson).
- **Copying files by hand** into `ASSET_ROOT` (same layout as the importer writes).

Configure with, in priority order:

1. environment variables: `ASSET_ROOT`, `AUDIO_ROOTS` (`;`-separated extra audio folders), `CUBISM_CORE_URL`, `API_PORT`, `DATA_DIR`, `IMPORT_MAX_BYTES` (uncompressed size cap of one import, default 16 GB)
2. `studio.config.json` (copy `studio.config.example.json`; gitignored; the wizard also writes `assetRoot` / `cubismCoreUrl` here)
3. built-in defaults (see `server/config.ts`)

`.env.example` documents the variables; copy it to `.env` (gitignored), which the server reads at start-up (variables already set in the shell win).

Runtime data (index cache `data/index/catalog.json`, projects, caches, `data/setup.local.json` with your confirmations) lives in `data/` (gitignored).

**Haneoka manifest (optional, off until you accept a disclaimer).** Wizard step 2 -> "素材清单": reads the public index of haneoka.org (three JSON endpoints, descriptive User-Agent with this repository's URL, cached for 24 h, serial requests), compares it with your library, and lets you tick bands / characters / outfits / backgrounds to produce a checklist (export Markdown or CSV). Every entry links to the matching **page** on Haneoka only. The project **does not download any asset**: the site's terms forbid downloading assets for reuse without the rights holders' permission, so you download manually if and only if you are entitled to, then import locally. The disclaimer is enforced server-side (403 until confirmed, and again when its text changes).

### Cubism Core

Live2D rendering needs the proprietary Cubism Core 5.x, which is not in this repository. By default it is loaded at runtime from Live2D's official URL. Wizard step 1 can also **save a local copy** to `vendor/live2dcubismcore.min.js` (gitignored; fetched only from Live2D's official address, after you confirm the [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)); if the official URL is unavailable, pick a `live2dcubismcore.min.js` from the official Cubism SDK for Web instead. The file is checked for the Live2D header and `csmGetLatestMocVersion`, and the browser verifies it supports moc3 v5. It must never be committed.

## Scripts

| Script | What |
|---|---|
| `npm run dev` / `build` / `start` | dev servers / Vite build + server bundle (`dist/web`, `dist/server`) / production server (serves `dist/web` and the API on one port; `start:dev` runs the TypeScript sources with tsx) |
| `npm run package-release` | build the download zip into `release/` (run `npm run build` first) |
| `npm run typecheck`, `npm run lint` | tsc, eslint |
| `npm test` | unit tests (no real assets needed) |
| `npm run test:integration` | against the real `ASSET_ROOT` (skipped with a notice if unreadable) |
| `npm run pack-assets -- --out <zip>` | pack the current `ASSET_ROOT` into an importable zip with `openotes-pack.json` |
| `npm run test:e2e` | Playwright with Microsoft Edge; reuses a running dev server on :5273 |

## AI director (optional)

Without a key everything except the AI features works; the AI entry points then say what is missing (nothing pretends to be AI).

- **Configure**: project list or editor top bar -> `AI 设置`. Pick a provider, fill model / address / key, `测试连接`. The key is written to `data/settings.local.json` (gitignored) and never sent back to the browser (only a mask such as `sk-…087b` is shown).
  - **Claude**: key from console.anthropic.com (default model `claude-sonnet-5-5`), or `ANTHROPIC_API_KEY` in the environment.
  - **OpenAI-compatible** (DeepSeek, LM Studio, vLLM ...): base URL (LM Studio `http://localhost:1234/v1`, DeepSeek `https://api.deepseek.com`), model name, optional key. Environment variables / `.env` (`LLM_PROVIDER`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`) provide defaults; what you save in the dialog wins.
- **Use**: project list -> `AI 拆解…` (paste a story: scenes, backgrounds, outfits with reasons) -> create the project -> left tab `AI 导演` -> generate the performance of the current / all scenes; choose a scope (camera, performance, outfit, staging, effects) or only the selected line to regenerate part of it. Locked content and content you edited are never overwritten; one generation is one undo step.
- **One click from a novel**: project list -> `AI 拆解…` -> paste or load a `.txt` / `.md` (UTF-8 or GBK are detected; chapter headings such as `第一章` or `# 标题` are counted) -> `一键生成完整演出`. It breaks the text down, creates the project, then directs every scene (3 at a time), shows progress, can be cancelled and resumed (`继续生成剩余场景`; finished scenes are cached and kept), prints calls / tokens / time, and lists continuity warnings. Then `放映` (`/play/<id>`, with a 16:9 / 2.16:1 frame choice) or `在编辑器中精修`. A sample input is `examples/mygo-rehearsal.txt` (original text, five chapters, outfit changes, a formal performance).
- **Rule director** (no key needed): pick `规则导演（非 AI）` in the dialog or in the `AI 导演` tab. It splits scenes by chapter / time words, matches backgrounds and outfits by keywords, finds quoted speech and its speaker, and uses a fixed shot rhythm. Everything it makes is marked `规则`, never `AI`.
- **Review**: every proposal is a diff against the current scene (grouped by line structure / camera / performance / outfit / staging / effects, before -> after). Accept all, accept chosen scopes, or reject; accepting is one undo step and always goes through the lock-enforcing merge. The tab also shows the run log and the continuity check (click a warning to jump to it).
- Results are cached by input hash in `data/llm-cache/`; a repeat run sends no request.
- Tests never touch the network: they replay recorded model outputs from `tests/fixtures/llm/`. A manual live check against a real model: `LLM_LIVE=1 npm run test:integration -- llm-live`.

## HTTP API

- `GET/PUT /api/llm/settings`, `POST /api/llm/test` - AI settings (masked keys only) and connection test
- `POST /api/director/breakdown`, `/scene`, `/scenes` (SSE) - AI breakdown and scene direction
- `POST /api/import/scan|upload|plan|run` start a job (`{jobId}`); `GET|DELETE /api/import/jobs/:id` - progress / cancel (plan and report arrive in the job); `GET/PUT /api/import/target`
- `GET /api/sources/haneoka`, `.../list`, `POST .../accept|manifest` - manifest source (403 until the disclaimer is confirmed)
- `GET /api/setup/core`, `POST /api/setup/core/accept-license|fetch|upload|reset` - Cubism Core
- `GET /api/health` - version, ASSET_ROOT probe, index state
- `GET /api/catalog` - compact catalog; `GET /api/catalog/models/:id` - full model entry (motions with orientation stats, expressions)
- `GET /assets/*` - static files from `ASSET_ROOT` (Range supported, traversal rejected with 400); `GET /audio/:n/*` - files from the n-th `AUDIO_ROOTS` entry

## Tests

`npm run typecheck && npm run lint && npm test` need no assets. `npm run test:integration` needs a readable `ASSET_ROOT`; `npm run test:e2e` needs Microsoft Edge and starts (or reuses) the dev servers; the AI e2e flows use a second server pair in test mode with recorded responses and never touch a real key.

## Project layout

```
server/    Express API: catalog indexer, projects, LLM providers, director, settings
shared/    schemas, staging maths, timeline compiler, director logic (used by server and web)
web/       React editor, Pixi/Live2D engine, player, labs
tests/     unit, integration, e2e, synthetic fixtures (no real assets)
examples/  sample novel (original text)
docs/      user guide (GUIDE_ASSETS) and staging style reference
```

## Acknowledgements

Built on React, Pixi.js, untitled-pixi-live2d-engine, Express, zod, zustand, immer and Vite (see [THIRD_PARTY.md](THIRD_PARTY.md)). Style notes were researched from public descriptions of the original game's presentation; no game code is used.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). Copyright (C) 2026 bilibili @羽丘魅魔高松灯. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security notes: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md).
