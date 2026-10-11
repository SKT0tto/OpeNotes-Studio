# Changelog

## 0.1.4

Fixes "some characters do not move" and "group shots are not harmonious" (v0.1.3 feedback).

**Frozen characters (root cause, present since 0.1.0).** The Cubism Core heap was configured at 32 MB. Loading the 6th-10th model of a project made the Core re-allocate its heap, and every model created before that kept views on the old heap: motions and parameters kept running in JS (so every parameter-based check passed) but the rendered output stopped. Which people froze depended on the model load order.
- Core heap default is now 256 MB, configurable with `cubismMemoryMB` in `studio.config.json` or `CUBISM_MEMORY_MB` (64-1024, delivered through `/api/health`, applied before the first model is created in the play page, stage lab and actor lab).
- Safety net: after every model load the library compares heap views; models left on an old heap are rebuilt (`[cubism] heap reallocated, reloading N models`) and the stage swaps the new instance in at once.
- Debug hooks `getActorVertexHash`, `getActorHeapStale`, `getActorScreenBoxes`; new e2e `liveness-real` (10-model project, sequential play and the s_2 -> s_3 -> s_4 -> s_1 -> s_5 jump order, 16:9 and 2.16:1, editor, and a forced 32 MB heap) checks vertices and head pixels instead of parameters.

**Group shots (3+ people) follow the original again.** Measured on the original: big tight heads (3 people 0.41H ... 6 people 0.29H on the wide frame), faces about 1.45 -> 1.21 head heights apart, faces never covered and always inside the frame, bodies and hair may overlap and leave the frame, never full-body. Replaces the 0.1.3 shrink-to-fit layout (heads 0.11-0.17H, zig-zag rows).
- One row, centred, equal pitch, head sizes pulled together (min/max >= 0.90), the middle person x1.04 and in front; a back row only for a real depth difference (a band's drummer, standing between two front faces) or beyond six people.
- Camera moves of a group are capped (push-in 1.05x, pan 0.024W) and the faces stay inside the frame at both ends.
- Style fields: new `framing.groupHead3 / groupHeadDecay / groupHeadMin / groupPitch3 / groupPitchStep / groupPitchMin / groupFaceShare / groupFaceEdge / groupEyeY / groupHeightEqualize / groupCenterBoost / groupDepthGap / groupBackScale / groupBackDrop / groupOneRowMax / groupFrontCrowded / groupOverflowScale / groupOverflowDrop / groupMoveZoom / groupPanShare`; the old `groupSpacing, groupRowSpacing, groupRowDrop, groupStaggerFrom, groupShrink, groupMinScale, groupEdgeMargin, groupWideStretch, groupRowDepthGap` are removed (stored overrides are ignored and listed as style issues). Two-shots are unchanged.

## 0.1.3

Fixes "the group shot (everybody in frame) looks crowded".

Measured on the real AI-generated projects in `data/projects` (daily scenes and band performances, 16:9 / 2.16:1, original reference t094 for comparison):

- Before: neighbouring faces were 0.51H apart for three people, 0.40H for four and 0.30H for five (16:9); with four and five people the head boxes overlapped by up to 30% / 51% (a face half covered by the next one), and the three-person layout was fixed to the right so the left head was cut by the frame edge (up to -0.16H) while the right side had a wide margin.
- After: faces keep at least 1.2-1.5 head widths between their centres, no head box overlaps another (0%), every head including the hair is inside the frame with at least 0.06H margin on both sides, and the arrangement is centred. Spacing (16:9): 3 people 0.54H, 4 people 0.39H, 5 people 0.28H (wide 2.16:1: 0.70H / 0.49H / 0.36H); bodies may overlap slightly, faces never.

Changes:

- Groups of three or more are laid out by head width instead of by fixed screen positions: the pitch between neighbouring faces is `framing.groupSpacing` head widths inside a row and `framing.groupRowSpacing` between a front and a back row person; the arrangement is centred and the camera zooms out as far as needed so that everybody (and a margin of `framing.groupEdgeMargin`) fits, also at the end of a push-in / pan.
- More people are drawn smaller (`groupShrink` per extra person, floor `groupMinScale`) and in two staggered rows: with a depth range in the blocking the far half is the back row (a band: the vocalist stays front centre, the drummer behind, the others left and right), otherwise groups of `groupStaggerFrom` or more alternate. The back row sits lower (`groupRowDrop`) and a little smaller (`groupBackScale`). Wide frames spread the spacing over the extra width (`groupWideStretch`).
- A group shot shows everybody on stage: a person who is present but not in the beat's focus is arranged with the others instead of standing half behind a neighbour.
- All of it is style data (global -> scene -> shot) with inspector fields in the "Framing" group, previewed instantly. The old `framing.groupFaceX0/1/2` values are replaced by these.

Download package and production run:

- GitHub Releases now carry a ready-to-run zip (`OpeNotes-Studio-v<version>.zip`, built by `.github/workflows/release.yml` on a `v*` tag, or locally with `npm run package-release`): the built app, `Start-Windows.cmd` / `start.sh`, docs, `asset-labels/` and `examples/`; no game assets, no Cubism Core, no tests (about 0.7 MB). Unzip it and double-click the start script (Node.js 22+ is needed): it installs the production dependencies on the first run, offers to download the Live2D Cubism Core from Live2D's official address after you accept the Live2D Proprietary Software License (`scripts/fetch-core.mjs`; answering no leaves it to the web wizard), starts the server and opens the browser. To upgrade, unzip the new version over the old folder and keep `data/` and `studio.config.json`.
- `npm run build` now also bundles the server to `dist/server/index.mjs`, and `npm start` runs that bundle (one port, default 5274, serves the web app and the API; no Vite, no tsx). The front-end-only packages (React, Pixi, zustand, immer, the Live2D engine) moved to devDependencies, so `npm ci --omit=dev` installs only what the server needs. `npm run start:dev` keeps the old tsx start.
- Fix: in a production build the web bundle's `/assets/*` files collided with the server's asset-library route; the bundle is now emitted to `/app/*`.

## 0.1.2

Fixes "several characters do not move at all in generated performances".

Root causes:

- Live-mode (band performance) models call their idle `idle_01`, not `idle01`; the compiler only looked for `idle01`, so the five musicians had no idle at all ("has no idle01 motion"), and the only motions they got were the long one-shot `play01_*` / `action_*` / `finish_*` clips. When a clip ended nothing replaced it: the motion queue ran dry and the character stood frozen for the rest of the scene.
- The engine's "return to idle when a one-shot finishes" callback never fires (the Live2D engine only calls `onFinish` for motions with audio), so the safety net the player relied on did not exist; any gap between a finished clip and the timeline's next idle event left the model without a motion.
- Bystanders in everyday scenes only ever got `idle01` (a 6 s loop, a few degrees of head sway, one blink); the rule director gave gestures to speakers only, so listeners looked frozen next to a gesturing speaker.
- Motion / expression ids the AI (or a hand edit) used that did not exist in the outfit the character wears at that moment were dropped (empty), and a costume change did not re-map them.

Fixes:

- Every model has an idle: `idle01`, `idle_01` (live-mode) or the first `idle*` family. Compiled motion lists always start in an idle loop and every one-shot is followed by it; instrument motions (`play*`) loop until something else is keyed.
- Engine guard (`Live2DActor.keepAlive`): a character that is on stage and whose motion queue is empty restarts its idle on the next frame, so nobody can stay frozen whatever went wrong (seek, refused start, missing event). A seek inside the motion that is already playing now really restarts it at the right position.
- Bystander reactions (rule director, no AI call, nothing written into the project): while somebody else speaks, a character that has been still for `performance.listenerReactGap` seconds (default 5) makes a small reaction (nod, glance, shy smile, thoughtful tilt) chosen from the line's emotion; hand-made / AI motion keys inside the line win, musicians keep playing, the moments are staggered per character. Style fields `performance.listenerReact` and `performance.listenerReactGap`.
- Resource validation: an unknown motion / expression id is mapped to the closest one the character's CURRENT outfit has (same family, same kind with another number, keyword category, emotion table, mild generic gesture) instead of being dropped; the compiler re-maps on a costume change and says so in the compile warnings. The AI validator uses the same mapping.
- Editor: jumping to a beat in another scene no longer blanks the preview for seconds; the new scene's background, models, motions and expressions load while the previous frame stays on screen, and only the final no-I/O swap happens with the stage hidden (within one frame).
- Timeline: rule-director ghost keys of one actor in one line get distinct ids (several reaction keys per line would have collided).
- Server: writing / reading calibration and project files retries on the short-lived Windows file locks (EPERM / EBUSY / EACCES) instead of answering 500.
- Dev hooks: `getActorMotion`, `stopActorMotion`, `stageProbe`.

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
