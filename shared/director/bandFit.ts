/** Which backgrounds may a scene use? One pure function shared by the digest, the validator, the rule director, the continuity check and the editor. */
import { GENERIC_BAND, type BgLabel, type LabelRules } from '../schema/assetLabels';
import type { BackgroundEntry } from '../schema/assets';
import { autoSelectable, type BgUse } from './bgCategory';

export const DEFAULT_RULES: LabelRules = { unknownPolicy: 'avoid' };

export interface SceneWho {
  /** Band keys of the main characters on stage (sub characters and unbanded NPCs excluded). */
  bands: readonly string[];
  /** Character keys on stage. */
  cast: readonly string[];
  /** Character key of the host when the scene is a visit ("去爱音家"). */
  guestOf?: string | null | undefined;
  /** Free-text mood / scene summary / source text, used only to test a label's usage conditions. */
  mood?: string | undefined;
  text?: string | undefined;
}

const ACTIVITY_RE: Record<string, RegExp> = { singing: /唱|歌|sing/i, sleeping: /睡|入眠|sleep/i, studying: /学习|写作业|复习|study/i, streaming: /直播|stream/i };

/** Does the scene satisfy a label's usage conditions (mood and activity)? Labels without conditions always do. */
export function usageMet(label: BgLabel, who: SceneWho): boolean {
  const u = label.usage;
  if (!u) return true;
  const mood = (who.mood ?? '').toLowerCase();
  if (u.moods.length > 0 && !u.moods.some((m) => mood.includes(m.toLowerCase()))) return false;
  if (u.activity && !ACTIVITY_RE[u.activity]!.test(`${who.text ?? ''} ${who.mood ?? ''}`)) return false;
  return true;
}

/** ok: fine; fallback: unknown ownership, last resort only (warn); no: not allowed. */
export type Fit = 'ok' | 'fallback' | 'no';

export const isUnknownLabel = (l: BgLabel): boolean => l.bands.length === 0;

export function bgFit(label: BgLabel | undefined, who: SceneWho, rules: LabelRules = DEFAULT_RULES): Fit {
  if (label && !usageMet(label, who)) return 'no';
  if (!label || label.bands.includes(GENERIC_BAND)) return 'ok';
  if (isUnknownLabel(label)) return rules.unknownPolicy === 'allow' ? 'ok' : rules.unknownPolicy === 'forbid' ? 'no' : 'fallback';
  if (!label.exclusive) return 'ok';
  const home = label.residents ?? [];
  if (who.guestOf && home.includes(who.guestOf)) return 'ok';
  if (who.bands.length === 0 && who.cast.length === 0) return 'no';
  if (!who.bands.every((b) => label.bands.includes(b))) return 'no';
  if (label.access === 'private' && home.length > 0 && !who.cast.some((c) => home.includes(c))) return 'no';
  return 'ok';
}

/** Short Chinese reason why `bgFit` said no (for warnings). */
export function bandText(label: BgLabel | undefined, bandName: (k: string) => string): string {
  if (!label || label.bands.includes(GENERIC_BAND)) return '通用';
  if (label.bands.length === 0) return '未知';
  const who = label.bands.map(bandName).join('/');
  return label.owner && label.access === 'private' ? `${label.location ?? label.owner}（${who}）` : `${who}${label.exclusive ? '专属' : ''}`;
}

/** Bands of the main characters on stage. */
export function sceneBands(chars: ReadonlyMap<string, { bandKey: string | null; isSub: boolean }>, cast: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of cast) {
    const c = chars.get(k);
    if (c && !c.isSub && c.bandKey) out.add(c.bandKey);
  }
  return [...out].sort();
}

/** Backgrounds usable for a scene, in two tiers (fallback = unknown ownership, to be used only when `ok` has nothing). */
export function allowedBackgrounds(bgs: readonly BackgroundEntry[], who: SceneWho, opts: { performance?: boolean; rules?: LabelRules; use?: BgUse } = {}): { ok: BackgroundEntry[]; fallback: BackgroundEntry[] } {
  const ok: BackgroundEntry[] = [];
  const fallback: BackgroundEntry[] = [];
  const use = opts.use ?? 'scene';
  for (const b of bgs) {
    // decor / insert / duplicates never; an `event` stage (virtual live space) is still fine for a performance
    if (!autoSelectable(b, use) && !(opts.performance && b.labels?.stage === true && autoSelectable(b, 'event'))) continue;
    if (opts.performance && b.labels?.stage !== true) continue;
    const f = bgFit(b.labels, who, opts.rules);
    if (f === 'ok') ok.push(b);
    else if (f === 'fallback') fallback.push(b);
  }
  return { ok, fallback };
}
