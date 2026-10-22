/**
 * Travel: relabel the `shot.intent` of a beat when it contradicts the picture the beat itself describes (deterministic, no model).
 * The compiler already decides by geometry, so a wrong label only misleads the editor and sends the compiler through its "label
 * does not match" branch. Rules (the reason of the beat says what was changed):
 *   emphasis / continue, but the focus is somebody else than in the previous beat -> exchange
 *   reveal, but everyone in focus has been on screen before and nobody enters in this beat -> continue (same composition as before), emphasis / release (same
 *   person closer / wider) or exchange (another person or another pairing)
 *   release, but the shot is closer than the previous one -> emphasis (same person) or exchange (another person)
 */
import type { DirectedBeat } from '../schema/ai';
import type { StageEvents } from './stage';
import { onStageAt } from './stage';

/** How close a shot is (a wider shot has a smaller number); insert has none. */
const CLOSENESS: Partial<Record<DirectedBeat['shot']['type'], number>> = { group: 0, two_shot: 1, ms: 2, mcu: 3, cu: 4, ecu: 5 };

/** The honest label for a beat that is not a reveal: holding the previous composition, another person, or the same person closer / wider. */
function plainIntent(prev: DirectedBeat | undefined, b: DirectedBeat, changed: boolean): NonNullable<DirectedBeat['shot']['intent']> {
  // after a wide shot without a particular person, attention is handed to somebody
  if (!prev || changed || prev.shot.focus.length === 0) return 'exchange';
  const was = CLOSENESS[prev.shot.type];
  const now = CLOSENESS[b.shot.type];
  if (b.shot.type === prev.shot.type && JSON.stringify(b.shot.focus) === JSON.stringify(prev.shot.focus)) return 'continue';
  if (was !== undefined && now !== undefined && now > was) return 'emphasis';
  if (was !== undefined && now !== undefined && now < was) return 'release';
  return 'exchange';
}

export function normalizeIntents(
  beats: DirectedBeat[],
  opts: { castIds: readonly string[]; events: StageEvents; awayAtStart?: ReadonlySet<string>; skip?: (b: DirectedBeat) => boolean; where: (i: number) => string },
): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  beats.forEach((b, i) => {
    const prev = i > 0 ? beats[i - 1] : undefined;
    const focus = b.shot.focus;
    const people = b.shot.type === 'insert' && b.shot.insertTarget === 'scene' ? [] : focus.length > 0 ? focus : [...onStageAt(opts.events, opts.castIds, i, opts.awayAtStart)];
    const old = b.shot.intent;
    if (old && !opts.skip?.(b)) {
      // another person than in the previous beat (a wide previous shot has no particular person: not a change)
      const changed = !!prev && prev.shot.focus.length > 0 && focus.length > 0 && !prev.shot.focus.includes(focus[0]!);
      let next: DirectedBeat['shot']['intent'] = old;
      let why = '';
      if ((old === 'emphasis' || old === 'continue') && changed) {
        next = 'exchange';
        why = '换了人';
      } else if (old === 'reveal' && b.shot.type !== 'insert' && focus.length > 0 && focus.every((c) => seen.has(c)) && !b.actors.some((a) => a.enter && focus.includes(a.castId))) {
        next = plainIntent(prev, b, changed);
        why = '画面里的人此前都出现过';
      } else if (old === 'release' && prev) {
        const was = CLOSENESS[prev.shot.type];
        const now = CLOSENESS[b.shot.type];
        if (was !== undefined && now !== undefined && now > was) {
          next = changed ? 'exchange' : 'emphasis';
          why = '景别变近了';
        }
      }
      if (next !== old) {
        b.shot.intent = next;
        b.reason = `${b.reason}（意图已按画面改标：${old}→${next}，${why}）`;
        warnings.push(`${opts.where(i)}的意图 ${old} 与画面不符（${why}），已改为 ${next}`);
      }
    }
    for (const p of people) seen.add(p);
  });
  return warnings;
}

/**
 * Travel, a span of a long scene that is NOT the last one: its last beat must not close the scene. A `release` there (or a
 * `pull_out`) is the "pull back to end the scene" gesture, but the scene goes on in the next span, so it is downgraded:
 * intent -> what the geometry says (same picture: continue; another person: exchange; closer: emphasis; wider: continue), flow -> auto,
 * pull_out -> static. `prev` is the beat before the first of `beats` (the previous span's last beat). Beats in `skip` are never touched.
 */
export function downgradeChunkEnd(
  beats: DirectedBeat[],
  opts: { prev?: DirectedBeat | undefined; skip?: (b: DirectedBeat) => boolean; where: (i: number) => string },
): string[] {
  const warnings: string[] = [];
  const i = beats.length - 1;
  const b = beats[i];
  if (!b || opts.skip?.(b)) return warnings;
  const prev = i > 0 ? beats[i - 1] : opts.prev;
  const changes: string[] = [];
  if (b.shot.intent === 'release') {
    const changed = !!prev && prev.shot.focus.length > 0 && b.shot.focus.length > 0 && !prev.shot.focus.includes(b.shot.focus[0]!);
    let next = plainIntent(prev, b, changed);
    if (next === 'release') next = changed ? 'exchange' : 'continue';
    changes.push(`intent release→${next}`);
    b.shot.intent = next;
    if (b.shot.flow !== 'auto') {
      changes.push(`flow ${b.shot.flow ?? 'null'}→auto`);
      b.shot.flow = 'auto';
    }
  }
  if (b.shot.move === 'pull_out') {
    changes.push('move pull_out→static');
    b.shot.move = 'static';
  }
  if (changes.length > 0) {
    b.reason = `${b.reason}（这一段之后场景还在继续，不是场尾：${changes.join('，')}）`;
    warnings.push(`${opts.where(i)}是分段的末尾，场景在后面还会继续，不能用场尾收束的镜头，已改：${changes.join('，')}`);
  }
  return warnings;
}
