/**
 * Who is actually on screen while each beat plays, read the way the compiler reads it (compile.ts: `emptyRuns`, `insertRuns`, enter / exit,
 * opacity keys). Pure and catalog-free, so the agent (server side, no calibrations) can report what the viewer will see instead of what the
 * blocking says. Not covered: a person the camera hides for one shot because the frame edge cuts them (that needs the camera solve).
 */
import type { Project, Scene } from '../schema/project';
import { sampleNum } from './sample';
import { EMPTY_KINDS, sceneTimes } from './time';

export type HiddenReason = 'not_entered' | 'exited' | 'empty_beat' | 'empty_shot_bg' | 'opacity_0';
export const HIDDEN_REASON_LABEL: Record<HiddenReason, string> = {
  not_entered: '还没进场',
  exited: '已离场',
  empty_beat: '空镜句（这一句不显示人物）',
  empty_shot_bg: '空镜背景（背景切换用途=insert，到下一次换背景前所有人隐藏）',
  opacity_0: '透明度关键帧为 0',
};

export interface BeatPresence {
  beatId: string;
  /** Cast in the scene that the viewer sees during this beat. */
  visible: string[];
  /** Cast in the scene that is not seen, and why (the first reason that applies). */
  hidden: Record<string, HiddenReason>;
}

type Interval = [number, number];
const inside = (xs: Interval[], t: number) => xs.some(([a, b]) => t >= a - 1e-9 && t < b - 1e-9);

/** Presence per stored beat of `sceneId`, sampled in the middle of the beat (after entrance / exit fades). */
export function scenePresence(project: Pick<Project, 'scenes' | 'settings' | 'style'>, sceneId: string): BeatPresence[] {
  const si = project.scenes.findIndex((s) => s.id === sceneId);
  if (si < 0) return [];
  const scene = project.scenes[si]!;
  const st = sceneTimes(project)[si]!;
  const timeOf = new Map(st.beats.map((b) => [b.beatId, b]));
  const abs = (at: { beatId: string; offset: number }) => { const b = timeOf.get(at.beatId); return b ? b.start + at.offset : null; };

  // empty beats (the automatic establishing beat included) and cut-away background segments, as compile.ts builds them
  const empty: Interval[] = st.list.flatMap((b, i): Interval[] => (EMPTY_KINDS.includes(b.kind) ? [[i === 0 ? st.start : st.beats[i]!.start, st.beats[i]!.end]] : []));
  const insert = emptyShotRuns(scene, st.start, st.end, abs);

  const cast = Object.keys(scene.wardrobe);
  const opacityOf = new Map(cast.map((c) => [c, scene.tracks
    .filter((t) => t.channel === 'opacity' && t.target.kind === 'actor' && t.target.castId === c)
    .flatMap((t) => t.keys.map((k) => ({ at: abs(k.at), duration: k.duration, ease: k.ease, value: Number(k.value) })))
    .filter((k): k is { at: number; duration: number; ease: typeof k.ease; value: number } => k.at !== null)
    .sort((a, b) => a.at - b.at)]));

  return scene.beats.map((beat) => {
    const bt = timeOf.get(beat.id);
    const out: BeatPresence = { beatId: beat.id, visible: [], hidden: {} };
    if (!bt) return out;
    const t = (bt.start + bt.end) / 2;
    for (const c of cast) {
      const bl = scene.blocking[c];
      const enter = bl?.enter ? abs({ beatId: bl.enter.beatId, offset: 0 }) : null;
      const exit = bl?.exit ? abs({ beatId: bl.exit.beatId, offset: 0 }) : null;
      let why: HiddenReason | null = null;
      if (enter !== null && t < enter - 1e-9) why = 'not_entered';
      else if (exit !== null && t >= exit - 1e-9) why = 'exited';
      else if (inside(empty, t)) why = 'empty_beat';
      else if (inside(insert, t)) why = 'empty_shot_bg';
      else if (sampleNum(opacityOf.get(c)!, t, 1) <= 0.02) why = 'opacity_0';
      if (why) out.hidden[c] = why;
      else out.visible.push(c);
    }
    return out;
  });
}

/** Spans of the background track whose purpose is `insert` (people hidden until the next background key). Mirrors compile.ts. */
function emptyShotRuns(scene: Scene, start: number, end: number, abs: (a: { beatId: string; offset: number }) => number | null): Interval[] {
  const keys = scene.tracks
    .filter((t) => t.channel === 'background' && t.target.kind === 'stage')
    .flatMap((t) => t.keys.map((k) => ({ at: abs(k.at), purpose: (k.value as { purpose?: string }).purpose ?? 'move' })))
    .filter((k): k is { at: number; purpose: string } => k.at !== null)
    .sort((a, b) => a.at - b.at);
  const segs: Array<{ start: number; purpose: string }> = [{ start, purpose: 'move' }];
  for (const k of keys) {
    const s = { start: Math.max(k.at, start), purpose: k.purpose };
    const prev = segs.at(-1)!;
    if (Math.abs(prev.start - s.start) < 1e-6 && segs.length > 1) segs[segs.length - 1] = s;
    else if (Math.abs(prev.start - s.start) < 1e-6) segs[0] = s;
    else segs.push(s);
  }
  // compile.ts: only segments after the first hide the people
  return segs.flatMap((s, i): Interval[] => (i > 0 && s.purpose === 'insert' ? [[s.start, segs[i + 1]?.start ?? end]] : []));
}
