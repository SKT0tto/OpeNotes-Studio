# Changelog

## 0.6.1

### 补充更新（2026-10-25，版本号保持 0.6.1）

- 编辑器新增「放映」入口：先保存当前项目，再打开播放器；保存失败时留在编辑器，避免播放旧内容。
- 重构播放器界面，统一为工作室的深色风格，集中提供进度、场景切换、播放速度、自动推进和画幅控制。
- 新增沉浸式原生全屏：播放、暂停和刚进入全屏时，闲置后均会收起外层控制栏；移动鼠标或使用键盘可唤回，Esc 可退出全屏。
- README 改写为中文，重新整理功能介绍、上手流程、AI 配置与项目管理说明，并加入主页、编辑器、播放器和全屏放映的示例截图。

**New title screen.** The home page is now laid out like a game title screen: the latest project's background fills the screen (a random scene background or a gradient when there is none), one idling Live2D character stands on the right, and a title menu on the left offers 导入小说开始, 继续, 新建空白项目, 打开示例, 导入项目文件 and AI 设置, with arrow-key navigation. Recent projects sit in a strip at the bottom; 全部项目 opens a searchable grid with batch management. The character loads after the first paint, stays still with reduced motion and stays silent when Live2D Core or the model is missing. The layout stacks on narrow windows.

**AI assistant: find and batch-edit.** The assistant can look up lines by scene, range, speaker, kind, text, emotion, shot, intent, focus, effects, background, who is actually on screen, timing or lock state, and change all of them at once ("整部作品里灯的特写都改成中近景"). A batch is one grouped change card and one undo step; locked lines are listed for confirmation.

**AI assistant: small scripts.** For edits no tool covers ("每隔三句插一个反应镜头", "按台词字数重新分配停顿"), the assistant writes a short script. It runs in a sandbox (QuickJS/WASM) on a read-only copy with time, memory and output limits, and can only propose changes, which go through the usual checks, lock confirmation and change card; the script is shown in the card. Live mode never applies script changes on its own.

In our evaluation with real DeepSeek calls on original test stories: 21 of 23 find-and-batch cases and 8 of 8 script cases correct, no lock violations.

## 0.6.0

**Major update.**

Version 0.5.0 was skipped on purpose: this release is a big step, so it jumps straight to 0.6.0. It adds an AI assistant that edits your performance from plain-language instructions, a vision-capable assistant that checks its own work against the picture, and a VS Code-style dockable layout. Classic camera output and existing projects are unchanged.

**AI assistant (agentic mode).** Tell the AI what to change in plain language, down to the finest detail: a line's text, an expression, a small nudge, a pause, an entrance timing, an effect, the background, a camera keyframe, or locks.
- It finds the exact lines you mean: by your selection, by a quote (even a slightly misremembered one), by speaker or position, and across turns of the conversation.
- When a request is ambiguous, it asks instead of guessing.
- Every change is shown as a card (before to after, with the reason). Apply all, apply some, or reject. One Ctrl+Z undoes the whole change.
- It respects locks and asks before overriding them.
- Say "改回去" and a previous turn is undone exactly.
- An optional live mode applies small edits automatically.
- Token usage is shown.

**It sees the picture.** Attach screenshots or short videos (sampled into frames) and talk about what you see. The assistant can also capture stage frames itself, and it always checks its own picture-changing edits, showing thumbnails and the verification result in the change card. It works with your configured DeepSeek model; a separate vision model is optional.

**Dockable layout.** The editor now has a VS Code-style layout: drag, dock, resize and maximise every panel. Presets (default, AI work, storyboard review), a reset-layout command, and a layout remembered per user.

**Multi-select and box-select.** Select several lines in the script and the storyboard with Ctrl/Shift click or by dragging a box. The AI assistant works on the selection.

**Fixes and additions.**
- A mid-scene background change now keeps the people visible (the AI used to pick an empty shot).
- The AI reports who is really on screen.
- Head tilt (low head / raise head) was added.

**Measured quality.** In our evaluation with real DeepSeek calls on original test stories, about 80 realistic instructions were 99% correct, all 9 picture cases passed, with 0 unintended edits and 0 lock violations.

**Compatibility.** Classic camera output and existing projects are unchanged.

## 0.4.0

Original-style screen effects. They are generated in code: no game assets are included, and the fog edge is a procedural shader, not a game texture. Existing projects render as before: `memory_glow` is unchanged, and the classic and travel goldens are untouched.

**Memory / flashback.** A soft, cloudy white fog edge is the default (white bands are an option, or both), with cool, warm, sepia and mono tones. A memory is entered and left through white, the way the original does it: the screen goes white, the effect switches underneath, the white clears. The background is also softened a little while a memory is on.

**Inner voice.** The scene dims for a character's inner voice; the dialogue, HUD and banner stay bright.

**Flash and white dip.** A white flash for a sudden moment, and a white dip transition (about a second of white) for cuts into or out of a strong light.

**Shake.** A short, decaying camera shake, for impacts.

**Daze.** A full-screen blur that takes colour away, with an optional eyelid that closes and opens with a soft edge.

**The AI director can use them.** In both classic and travel the model can choose these effects (prompt versions `scene-4` and `scene-4+travel-7`). The rule director (no AI) uses them in travel. All of them are editable keys on the timeline and in the inspector.

Tests: unit (`fxEffects`, `fxDirector`), classic and travel goldens unchanged, e2e `camera-system`, `perf-safety`, `play-demo`, `timeline`, `stage` and `editor-basic`. The new effects add well under 0.5 ms (daze under 2 ms) to the 95th percentile frame cost.

## 0.3.0

A much better AI director. The classic camera and the classic prompt are unchanged: the classic system prompt, schema and prompt version are byte-identical to 0.2.1, and classic compile output and goldens are untouched. Classic generation does benefit from the smarter chunking and the chunk-end fix below.

**Fewer wrong shots.** In our evaluation on original test stories (213 beats before, 218 after, same judge and criteria), beats judged unreasonable went from about 4% to about 1%, and reasonable beats from 74% to 93%. The three biggest failures are gone: shots on the wrong person (a line credited to the wrong speaker), validation rewriting a correct two-shot, and object close-ups being thrown away.

**Two-shots respect who is talking and who is on stage.** The pair is the speaker plus the person being spoken to or answering, and nobody who has not entered yet or has already left is put into it. Object inserts (a hand, a stone, a key) are kept when the text or the model's reason names a thing to show.

**Intents match the picture.** When a shot's intent contradicts the framing the shot itself describes (a "reveal" of somebody already on screen, a "release" that is closer than the shot before, an "emphasis" on a new person), it is relabelled and the reason says so.

**Travel prompt with examples.** The travel instructions now explain each intent with a right and a wrong example and include a short worked scene, so the model writes what a beat actually is.

**Smarter chunking.** Long scenes are cut by the measured cost per paragraph, each later chunk gets the last paragraphs, the last beats and who is on stage, and people already shown in a group shot are not announced as "not yet seen". This works for classic as well. A cached re-run plans the same chunks, so it hits the cache.

**No wasted strict-schema request.** A provider that does not support strict JSON schema is asked once per process; later requests go straight to the plain JSON mode.

**Chunk end is not scene end.** The model sometimes treated the end of a non-final chunk as the end of the scene and added a closing pull-back. Every non-final chunk now says that the scene goes on afterwards, and a deterministic guard downgrades a closing release or pull-out at the last beat of a non-final chunk (with a warning that gives the reason). In a small live check on original test stories, spurious scene-end pull-backs went from 3 of 7 chunk ends to 0 of 5.

Tests: unit (`directorChunking`: continuation note, classic prompt untouched, guard; director travel fixes), travel golden and classic goldens unchanged, e2e `camera-system` and `camera-regeneration`.

## 0.2.1

Playback performance and travel polish. The classic camera output is unchanged: classic compile output is byte-identical to 0.2.0 and classic frames render identically within one colour level (the golden tests are untouched).

**Smoother playback.** Far fewer dropped frames in the player and in the editor, on a classic and on a travel project: no spike when a camera move starts (shaders and textures are prepared before they are first drawn), cheaper hidden characters in travel scenes, a cache for the blurred background of a still classic shot, and the editor no longer re-renders its panels while a project plays (the time readout, slider and timeline playhead follow the player directly; the inspector follows twice a second).

**Travel: people are carried, not cross-faded.** A person who enters or leaves the frame during a camera move is now carried in and out by the camera instead of fading, so there is no double image; a fade stays only for somebody who is already on screen and has to disappear (at most 0.2 s). Moves take about one second, like the original (median about 1.1 s instead of 0.9 s).

**Reason text.** The reason of a travel shot in the shot panel and on the timeline no longer repeats its "运镜" prefix.

**Auto quality for slow machines (travel only).** When the frames of a travel scene keep taking longer than their budget to prepare, blurs run at a lower resolution and off-screen characters update less often; after a stretch of headroom it returns to normal by itself. It looks at the work of a frame, not at the time between frames, so a 30 fps cap or a power-saver mode does not trigger it. The classic camera never changes quality.

**Lower memory.** Background pictures that neither the current nor the next scene uses are released from the GPU, and the next scene's pictures are loaded ahead; a scene uploads only the costumes it starts in, and a costume worn later in the scene is uploaded just before it first appears.

Tests: unit (`qualityGovernor`, a compile / evaluate budget), e2e (`perf-safety`: GL state shortcut, released backgrounds, playhead outside React, quality fallback, blur cache, costume upload), travel golden v13, classic goldens unchanged. `scripts/perf/frame-work.mjs` is a headless frame-time harness for maintainers.

## 0.2.0

Camera travel mode: a second camera system that moves like Our Notes. The classic camera is untouched and stays the default; classic AI generation and compile output are byte-identical to 0.1.5.

**Classic / travel switch.** A switch in the toolbar chooses the camera system of the project, and every scene can override it. Existing projects keep classic.

**Moves inside one continuous space.** In travel mode the stage is one continuous space: the camera slides and pushes across it instead of cutting between unrelated framings, with parallax on the background. Every move has a reason (a narrative intent such as exchange, reaction, rupture or reveal); the move-or-cut decision, its distance and its duration come from that reason and the real geometry of who stands where. Cuts remain where the story calls for them (a reaction, a rupture, a new person into a close-up).

**Two-shots pair neighbours.** A two-shot frames the two people who are next to each other on the stage; someone standing between them stays in frame instead of being skipped.

**Reasons are visible.** The camera panel and the timeline show the reason of each shot, so you can see why the camera moved or cut and change it.

**AI director.** A travel prompt (`scene-3` + `travel-5`) and new intent fields let the model say why a shot exists. A `flow=cut` from the model is only a suggestion; deterministic code validates it against the geometry and rewrites a reason that contradicts it.

**Regenerate cameras.** When you switch to travel and some scenes have no travel direction yet, a notice offers to regenerate the camera of the current scene or of all those scenes. Only the camera is redone, through the usual diff preview, and your manual edits and locks are kept.

Tests: unit (`travelPolicy`, `travelOriginal`, travel golden v11, classic golden unchanged), e2e (`camera-system`, `camera-regeneration`).

## 0.1.5

Background assets, redone (v0.1.4 feedback: "backgrounds are hard to tell apart", "one scene can only have one background", "logos and name-card pictures were used as backgrounds", "answering a questionnaire one picture at a time is too tiring").

**Every background says what it is.** `asset-labels/backgrounds.json` now carries, for all 349 backgrounds, a unique `title`, a one-line `description`, `tags` and a `category` (scene 302 / insert 19 / decor 23 / event 5), imported by the idempotent `scripts/import-bg-content.ts` from the reviewed content pass. Ownership the user confirmed (bands, owner, residents, place) is never touched; the 37 review suggestions (name / place-type corrections and ownership doubts) are stored as pending `fixes` and are applied only when you accept them in the workbench. 18 low-resolution duplicate copies are linked to their master (`duplicateOf`). The catalog name of a background is its title.

**decor never reaches a scene by itself.** The old filter looked for a `decorative` kind that does not exist, so logos, plain colours and UI screenshots could be picked. One function (`shared/director/bgCategory.ts`) now decides: decor is never automatic, insert pictures (sky, signals, crossings) only for cut-away shots, event pictures only with a cue in the text (or a virtual stage in a performance), duplicate copies never. The AI catalogue lists them in separate tables, validation replaces a decor / insert / duplicate choice with a compliant background and says so, and the pickers hide decor behind "显示装饰素材" (a manual choice is still allowed and flagged by the continuity check).

**One scene, several backgrounds.** New `background` track (cut / dip to black / crossfade; purpose move / insert / time). Compile gives `bgSegments`; the world of the scene (camera, ground, people) stays that of the first full-size background and any other picture is fitted over it, so switching between 2048x1119 and 1600x900 pictures moves nobody (head frames change <= 0.005H, tested first). Older projects have no such track and compile byte-for-byte as before (golden hashes). The AI director: Pass 1 (`breakdown-3`) may list up to 3 `moves` inside a scene when the text states a change of place, Pass 2 (`scene-3`) puts the switches on beats (only backgrounds of the scene's set, cut-aways only with an insert shot without people) and validation repairs everything deterministically. The rule director finds "走出校门 / 来到车站前 / 回到…的房间" from the place words of the backgrounds themselves. Three new continuity checks (decor in the track, band conflict after a switch, more than 6 switches).

**Editor.** A 背景 lane at the top of the timeline (thumbnail blocks; double-click adds a switch through the picker, drag, Delete, lock, undo), key fields for picture / transition / seconds / purpose, "在此处切换背景…" in the inspector, switch badges on storyboard cards. The inspector's background `<select>` is now a popup grid shared with the asset browser: "适合本场景" first, then the others with the reason they do not fit.

**Asset browser and labelling workbench.** Cards show a thumbnail (server-made small PNG without any native image library, cached in `data/cache/thumbs/`; contact-sheet crop or a placeholder card when the library is missing), the bold title, the description (full text on hover) and badges (band colour, place, time, category, stage, owner, "同一画面 xN" with folded duplicates). Search covers title, description, tags, place, owner and id (all terms must hit, ranked). The new workbench (`/label` (standalone, no link from the editor), replaces the questionnaire): thumbnail grid grouped by place / band / category / confidence, click / Ctrl / Shift / drag-box selection, chip buttons for band, owner, place, category, time of day, indoor/outdoor and stage, red / yellow / green frames, a review queue with the large picture, the AI suggestion ("现值 -> 建议" with the reason, accept / reject), keyboard control (1-5 band, 0 generic, ? unknown, Enter confirm and next, E title, arrows, Space zoom, Ctrl+Z), progress bar, every change saved at once through the validating API and undoable, and it works without the asset library.

Tests: unit (bgTrack, p20, bgUi), integration (labels / thumbnails over HTTP), e2e (`bg-track`, `label-workbench`); the integration expectations follow the restored library (247 models / 349 backgrounds).

**Upload your own backgrounds.** The background picker (inspector, keyframes, timeline) and the asset browser's background tab have an 「上传背景」 button and accept drag and drop: PNG / JPG / WebP (converted to PNG in the browser, scaled down only when larger than the stage needs, short side >= 320 px). `POST /api/import/background` runs the existing import plan under the import lock; ids are `user_<sha256 prefix>`, so a repeated upload is reported as already in the library; the display name is kept in `backgrounds/<id>.meta.json` in the asset library (the committed label file is not touched). New uploads appear at once without a reload. Uploaded backgrounds can be deleted (`DELETE /api/import/background/:id`, `user_` ids only); `GET .../usage` lists the projects and scenes that use one and the confirmation warns about them.

**Entrance flicker fixed.** The Live2D engine only advances a model while it is rendered, so an actor waiting off screen piled up seconds of model time and applied it in one step on its first visible frame (physics reset, hair and clothes jumped from a stale pose). Hidden actors now keep updating every frame, and a model swapped into a slot drops time accumulated while it was off stage.

**Line-by-line preview.** The editor preview has a 「逐句」 switch (default off): playback holds at the end of each line and Space advances while playing. The setting is shared with the play page's 自动推进 checkbox and the in-stage HUD.

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
