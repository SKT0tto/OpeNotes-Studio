# Changelog

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
