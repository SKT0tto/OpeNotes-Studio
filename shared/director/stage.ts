/**
 * Who is on stage at which beat of a direction. The same rule `expandScene` + the compiler use: an actor with `enter` is away
 * until the beat that enters him, an actor with `exit` is away from the beat that exits him on (the last flag wins, as in
 * `expandScene`). Everybody else is there from the start.
 */
import type { DirectedBeat } from '../schema/ai';

type StageBeat = Pick<DirectedBeat, 'actors'>;

export interface StageEvents {
  /** castId -> index of the beat that enters him. */
  enter: Map<string, number>;
  /** castId -> index of the beat that exits him. */
  exit: Map<string, number>;
}

export function stageEvents(beats: readonly StageBeat[]): StageEvents {
  const enter = new Map<string, number>();
  const exit = new Map<string, number>();
  beats.forEach((b, i) => {
    for (const a of b.actors) {
      if (a.enter) enter.set(a.castId, i);
      if (a.exit) exit.set(a.castId, i);
    }
  });
  return { enter, exit };
}

/** The people on stage while beat `index` plays. `awayAtStart` = people who already left before the first beat given (a later chunk of a long scene). */
export function onStageAt(ev: StageEvents, castIds: readonly string[], index: number, awayAtStart: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const c of castIds) {
    const e = ev.enter.get(c);
    const x = ev.exit.get(c);
    if (e !== undefined && index < e) continue;
    if (x !== undefined && index >= x) continue;
    if (e === undefined && awayAtStart.has(c)) continue;
    out.add(c);
  }
  return out;
}

/** On-stage set of every beat. */
export function stageTimeline(beats: readonly StageBeat[], castIds: readonly string[], awayAtStart: ReadonlySet<string> = new Set()): Array<Set<string>> {
  const ev = stageEvents(beats);
  return beats.map((_, i) => onStageAt(ev, castIds, i, awayAtStart));
}

export interface StageSummary {
  /** On stage after the last beat. */
  onStage: string[];
  /** Nobody has spoken, been in focus, been on stage in a group shot or acted yet: still unseen by the audience. */
  notYetSeen: string[];
  /** Left the stage during the beats given. */
  exited: string[];
}

/** The stage state after `beats` (used to brief the next chunk of a long scene). */
export function stageSummary(beats: ReadonlyArray<Pick<DirectedBeat, 'actors' | 'speaker' | 'shot'>>, castIds: readonly string[], awayAtStart: ReadonlySet<string> = new Set()): StageSummary {
  const ev = stageEvents(beats);
  const after = onStageAt(ev, castIds, beats.length, awayAtStart);
  const seen = new Set<string>();
  beats.forEach((b, i) => {
    if (b.speaker) seen.add(b.speaker);
    for (const f of b.shot.focus) seen.add(f);
    for (const a of b.actors) seen.add(a.castId);
    // a group shot shows everybody on stage, named in its focus or not
    if (b.shot.type === 'group') for (const c of onStageAt(ev, castIds, i, awayAtStart)) seen.add(c);
  });
  return {
    onStage: castIds.filter((c) => after.has(c)),
    notYetSeen: castIds.filter((c) => !seen.has(c)),
    exited: castIds.filter((c) => ev.exit.has(c) && !after.has(c)),
  };
}
