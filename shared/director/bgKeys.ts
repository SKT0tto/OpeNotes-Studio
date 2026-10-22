/** Background-track keys made by the directors: where a place change lands, and what the key says (P20). */
import type { BackgroundSwitch } from '../schema/project';

export type BgTransition = BackgroundSwitch['transition'];
export type BgPurpose = BackgroundSwitch['purpose'];

export const DEFAULT_BG_SECONDS: Record<BgTransition, number> = { cut: 0, dip_black: 0.8, dip_white: 0.8, crossfade: 1 };

export function bgSwitchValue(assetId: string, transition: BgTransition, purpose: BgPurpose = 'move'): BackgroundSwitch {
  return { assetId, transition, transitionSeconds: DEFAULT_BG_SECONDS[transition], purpose };
}

/**
 * Which beat each move lands on: the first beat at or after its paragraph (the last beat when the paragraph is past the end). Several moves
 * in one paragraph take its successive beats; when the paragraph has no more beats the later move wins.
 */
export function anchorMoves<M extends { paragraph: number }>(moves: readonly M[], beatParagraphs: readonly number[]): Array<{ move: M; index: number }> {
  const out: Array<{ move: M; index: number }> = [];
  const taken = new Map<number, number>();
  for (const move of [...moves].sort((a, b) => a.paragraph - b.paragraph)) {
    let i = beatParagraphs.findIndex((p) => p >= move.paragraph);
    if (i < 0) i = beatParagraphs.length - 1;
    if (i < 0) continue;
    while (taken.has(i) && beatParagraphs[i + 1] === beatParagraphs[i]) i++;
    const prev = taken.get(i);
    if (prev !== undefined) out.splice(prev, 1);
    taken.clear();
    out.push({ move, index: i });
    out.forEach((o, k) => taken.set(o.index, k));
  }
  return out.sort((a, b) => a.index - b.index);
}
