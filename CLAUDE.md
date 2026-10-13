# OpeNotes Studio

AI story-staging studio that turns fan novels into BanG Dream! Our Notes–style Live2D performances.
GPL-3.0, unofficial fan project. Repo: https://github.com/SKT0tto/OpeNotes-Studio

## Stack and layout
- TypeScript single package. Web: Vite 6 + React 19 + Zustand/Immer + PixiJS 8 + untitled-pixi-live2d-engine (Cubism 5). Server: Express 5 (dev: tsx; prod: esbuild bundle `dist/server/index.mjs`). Shared zod schemas and pure logic in `shared/`.
- `server/` API (catalog indexer, projects, LLM providers, director, labels, asset import) · `shared/` schemas, staging maths, timeline compile/evaluate, director logic · `web/` editor, engine, player, labs, `/label` workbench · `tests/` unit / integration / e2e · `site/` static website (GitHub Pages) · `asset-labels/backgrounds.json` background label data.
- Pipeline: project → compile (pure) → evaluate(t) (pure, seekable) → Stage renders. AI only outputs intent; deterministic code does coordinates, timing, validation, lock merging (`shared/director/*`).

## Commands
- `npm run dev` — web :5273 + API :5274 (API port via `API_PORT`, never `PORT`). Prefer the preview tool config `studio` in `.claude/launch.json`; `site` serves `site/` on :5280.
- `npm run typecheck`, `npm run lint`, `npm test` (unit), `npm run test:integration` (needs real ASSET_ROOT), `npm run test:e2e` (Playwright + msedge, reuses :5273).
- `LLM_LIVE=1 npm run test:integration -- llm-live` — real model calls (optional).
- `npm run build`, `npm start`, `npm run package-release`, `npm run pack-assets -- --out <zip outside repo>`.

## Hard rules
- Never commit game assets, Live2D Cubism Core, `.env`, `studio.config.json`, `data/`, `.verify/`, `dev-notes/`, `site-art/`, `release/`. Cubism Core is fetched only from Live2D's official URL at runtime.
- Never commit or push API keys; scan with `git grep -E "sk-[A-Za-z0-9]{20,}"` before pushing.
- Never put text the maintainer wrote (their own projects/stories in `data/projects`) into commits, fixtures, screenshots or docs. Use `examples/` or AI-written originals.
- Don't bulk-download from haneoka.org or other asset sites; reading their public story/index JSON for research is fine at a low rate (cache under `dev-notes/story-cache/`).
- Label data: AI changes must keep `source: "draft"`; only the maintainer's own decisions are `source: "user"`. The PATCH label endpoint stamps `user`, so AI bulk edits go through `POST /api/asset-labels/backgrounds/restore` with full labels. Every change cites evidence in `evidence`.
- Background naming: homes "<given name>家" (estates: 若叶家, 丰川家); official names for schools/venues; `placeName == location`; titles "<地点>·<区域/特征>（日|傍晚|夜）", unique. Categories: scene / insert / decor (never auto-picked) / event.
- Unit tests must not depend on the live label file; use `tests/fixtures/backgrounds.labels.fixture.json`.

## Workflow
- The maintainer wants Opus for planning and acceptance, Sonnet for coding. Keep agent tasks focused (usage is limited); stop every process an agent starts; agents report once.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; git identity is the SKT0tto noreply address (don't change it).
- Releases: bump `package.json` + `CHANGELOG.md` + the version badge in `site/index.html`, push to `main`, then push tag `vX.Y.Z` (must equal package.json) — `.github/workflows/release.yml` builds the zip. Website deploys from `site/` via `.github/workflows/pages.yml`.
- Reply to the maintainer in Chinese.
