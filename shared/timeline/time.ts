import type { Beat, Project, Scene } from '../schema/project';
import { resolveStyle, type ResolvedStyle, type StyleValues } from '../style/ournotes';

/** Beat kinds whose text is shown in the dialogue area. */
export const TEXT_KINDS: ReadonlyArray<Beat['kind']> = ['dialogue', 'narration', 'action'];
/** Beat kinds that hide the people (background only). */
export const EMPTY_KINDS: ReadonlyArray<Beat['kind']> = ['establishing', 'empty'];

export interface BeatTime {
  beatId: string;
  /** Absolute project time. */
  start: number;
  end: number;
  /** When the last character of the text is shown. */
  textEnd: number;
}

export interface SceneTime {
  start: number;
  /** First beat starts here (after the transition lead-in). */
  contentStart: number;
  end: number;
  beats: BeatTime[];
  /** The beats actually played: stored beats plus an automatic establishing shot when the scene shows a location banner. */
  list: Beat[];
  /** Resolved style of each beat in `list` (project -> scene -> beat layers). */
  styles: ResolvedStyle[];
  sceneStyle: ResolvedStyle;
  timing: TransitionTiming;
}

export interface TransitionTiming {
  /** Seconds between the scene start and its first beat. */
  lead: number;
  /** Phases of a black change: old picture stays, fades to black, stays black. The fade-in happens inside the content. */
  pause: number;
  out: number;
  hold: number;
  fadeIn: number;
  /** Hide the dialogue area during the lead (always true for the new kinds). */
  black: boolean;
}

export const textChars = (text: string) => [...text].length;
export const textRevealSeconds = (text: string, cps: number): number => textChars(text) / cps;

/** Seconds the establishing shot lasts when it carries the location banner (fade-in + delay + banner + gap). */
export function establishingSeconds(style: StyleValues, fadeIn: number, banner: boolean): number {
  const l = style.location;
  return banner ? fadeIn + l.delay + l.slideIn + l.hold + l.slideOut + l.afterGap : style.rhythm.emptySeconds;
}

/**
 * auto: dialogue / narration = max(minLine, chars / readingCps + tail) + lineGap (never shorter than the typewriter);
 * silent / empty beats use their default seconds; fixed = as written.
 */
export function beatSeconds(beat: Pick<Beat, 'kind' | 'text' | 'duration'>, style: StyleValues, ctx: { fadeIn?: number; banner?: boolean } = {}): number {
  if (beat.duration.mode === 'fixed') return beat.duration.seconds;
  const r = style.rhythm;
  switch (beat.kind) {
    case 'pause':
      return beat.duration.seconds > 0 ? beat.duration.seconds : r.minLine;
    case 'silent':
      return r.silentSeconds;
    case 'empty':
      return r.emptySeconds;
    case 'establishing':
      return establishingSeconds(style, ctx.fadeIn ?? 0, ctx.banner ?? false);
    default: {
      const n = textChars(beat.text);
      return Math.max(r.minLine, n / r.readingCps + r.tail, n / r.textSpeedCps + 0.3) + r.lineGap;
    }
  }
}

export function transitionTiming(scene: Pick<Scene, 'transitionIn'>, style: StyleValues): TransitionTiming {
  const t = style.transitions;
  switch (scene.transitionIn.kind) {
    case 'scene_black':
      return { lead: t.scenePause + t.sceneOut + t.sceneHold, pause: t.scenePause, out: t.sceneOut, hold: t.sceneHold, fadeIn: t.sceneIn, black: true };
    case 'dip_black':
      return { lead: t.dipOut + t.dipHold, pause: 0, out: t.dipOut, hold: t.dipHold, fadeIn: t.dipIn, black: true };
    case 'cut':
      return { lead: 0, pause: 0, out: 0, hold: 0, fadeIn: 0, black: false };
    default:
      return { lead: scene.transitionIn.duration, pause: 0, out: 0, hold: 0, fadeIn: 0, black: false };
  }
}

/** The beats that actually play: an establishing shot is added in front of scenes that show a location banner. */
export function effectiveBeats(scene: Scene): Beat[] {
  if (!scene.location?.show || scene.beats[0]?.kind === 'establishing') return scene.beats;
  const est: Beat = {
    id: `${scene.id}:est`, kind: 'establishing', variant: 'normal', coSpeakers: [], cutIn: 'cut', cutInKeepDialog: false, text: '',
    duration: { mode: 'auto', seconds: 0 }, shot: { type: 'establishing', focus: [], move: 'static', meta: scene.meta },
    style: { overrides: {}, meta: scene.meta }, meta: scene.meta,
  };
  return [est, ...scene.beats];
}

export function sceneTimes(project: Pick<Project, 'scenes' | 'settings' | 'style'>): SceneTime[] {
  const out: SceneTime[] = [];
  let t = 0;
  for (const scene of project.scenes) {
    const sceneStyle = resolveStyle(project.style, scene.style);
    const timing = transitionTiming(scene, sceneStyle.values);
    const start = t;
    const contentStart = start + timing.lead;
    const list = effectiveBeats(scene);
    const styles = list.map((b) => resolveStyle(project.style, scene.style, b.style));
    let cursor = contentStart;
    const beats: BeatTime[] = list.map((b, i) => {
      const st = styles[i]!.values;
      const dur = beatSeconds(b, st, { fadeIn: i === 0 ? timing.fadeIn : 0, banner: !!scene.location?.show && b.kind === 'establishing' });
      const bt = { beatId: b.id, start: cursor, end: cursor + dur, textEnd: cursor + Math.min(dur, textRevealSeconds(b.text, st.rhythm.textSpeedCps)) };
      cursor += dur;
      return bt;
    });
    out.push({ start, contentStart, end: cursor, beats, list, styles, sceneStyle, timing });
    t = cursor;
  }
  return out;
}
