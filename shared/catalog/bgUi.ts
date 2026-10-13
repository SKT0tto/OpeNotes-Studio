/** Pure helpers behind the background cards, the picker and the labelling workbench (no DOM, so they are unit-tested). */
import type { BgCategory, BgFix, BgLabel, BgLabelPatch } from '../schema/assetLabels';
import { GENERIC_BAND } from '../schema/assetLabels';
import { bgCategoryOf } from '../director/bgCategory';
import type { BackgroundEntry } from '../schema/assets';

export const BAND_COLOR: Record<string, string> = {
  mygo: '#3b8fd0', avemujica: '#a3204f', mewtype: '#f0629a', millsage: '#8f4bd6', dumbrock: '#f09a2b', [GENERIC_BAND]: '#7d8799',
};
export const UNKNOWN_COLOR = '#5b6272';
export const bandColor = (key: string | undefined | null): string => (key ? (BAND_COLOR[key] ?? UNKNOWN_COLOR) : UNKNOWN_COLOR);

export const CATEGORY_LABEL: Record<BgCategory, string> = { scene: '场景', insert: '插入镜头', decor: '装饰', event: '特殊画面' };
export const CATEGORY_COLOR: Record<BgCategory, string> = { scene: '#5b8cff', insert: '#3fb68b', decor: '#c565d8', event: '#e58a3c' };
export const TIME_LABEL: Record<string, string> = { day: '日', dusk: '傍晚', night: '夜', unspecified: '未定' };
export const INDOOR_LABEL: Record<string, string> = { indoor: '室内', outdoor: '室外', abstract: '抽象', screen: '屏幕' };

/** Border colour of a card in the workbench: green = confirmed, yellow = AI draft (likely), red = unknown or a pending review question. */
export type Review = 'confirmed' | 'likely' | 'unknown' | 'question';
export function reviewOf(b: Pick<BackgroundEntry, 'labels'>): Review {
  const l = b.labels;
  if (!l) return 'unknown';
  if ((l.fixes?.length ?? 0) > 0) return 'question';
  if (l.bands.length === 0 || l.confidence === 'unknown') return 'unknown';
  return l.confidence === 'confirmed' ? 'confirmed' : 'likely';
}
export const REVIEW_COLOR: Record<Review, string> = { confirmed: '#5ad19a', likely: '#e6b450', unknown: '#ff6b6b', question: '#ff6b6b' };
export const REVIEW_LABEL: Record<Review, string> = { confirmed: '已确认', likely: 'AI 推测', unknown: '未知', question: '有疑问' };

/** One line "建议：…（原 …）" of the first suggestion with a proposal. */
export function suggestionText(l: BgLabel | undefined): string | null {
  const f = l?.fixes?.find((x) => x.suggest);
  if (!f) {
    const q = l?.fixes?.find((x) => x.question);
    return q ? `疑问：${q.question!.slice(0, 40)}` : null;
  }
  return `建议：${f.suggest!.replace(/（.*$/, '')}${f.current ? `（原 ${f.current.replace(/ · .*$/, '')}）` : ''}`;
}

const stripNote = (s: string) => s.replace(/（[^）]*）/g, '').trim();

/**
 * The label patch that accepting a suggestion means, or null for a suggestion that is only a question / has no one-click fix.
 * Name suggestions write `title`; place-type suggestions write `placeType` (and `indoor` / `category` when the text says so). Ownership is never changed here.
 */
export function fixPatch(f: BgFix): BgLabelPatch | null {
  if (!f.suggest || /^owner|疑问/.test(f.field) || f.question) return null;
  // split on a slash that is not inside a full-width parenthesis
  const parts = f.suggest.split(/\s*\/\s*(?![^（）]*）)/);
  const type = (s: string) => /^[A-Za-z_]+/.exec(s.trim())?.[0];
  const patch: BgLabelPatch = {};
  const catMatch = /category=(scene|insert|decor|event)/.exec(f.suggest);
  if (catMatch) patch.category = catMatch[1] as BgCategory;
  switch (f.field) {
    case 'name': patch.title = stripNote(f.suggest); break;
    case 'placeType': { const t = type(parts[0]!); if (t) patch.placeType = t; break; }
    case 'placeType/name': { const t = type(parts[0]!); if (t) patch.placeType = t; if (parts[1]) patch.title = stripNote(parts[1]); break; }
    case 'placeType/indoor': { const t = type(parts[0]!); if (t) patch.placeType = t; if (parts[1] && /^(indoor|outdoor)$/.test(parts[1].trim())) patch.indoor = parts[1].trim() as 'indoor' | 'outdoor'; break; }
    case 'placeType/name/category': break;
    case 'nameOverride/descriptionOverride': {
      if (parts[0]) patch.nameOverride = parts[0].trim();
      if (parts[1]) patch.descriptionOverride = parts[1].trim();
      break;
    }
    default: return null;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Entries that wait for the user: unknown ownership, an AI guess, or a review suggestion; grouped by place for a calm review order. */
export function pendingQueue(list: readonly BackgroundEntry[]): BackgroundEntry[] {
  const place = (b: BackgroundEntry) => b.labels?.placeName ?? b.labels?.location ?? b.name.replace(/（.*?）/g, '').split('·')[0] ?? '';
  return list
    .filter((b) => !b.labels?.duplicateOf && bgCategoryOf(b) !== 'decor' && reviewOf(b) !== 'confirmed')
    .sort((a, b) => {
      const rank = (x: BackgroundEntry) => (reviewOf(x) === 'question' ? 0 : reviewOf(x) === 'unknown' ? 1 : 2);
      return place(a).localeCompare(place(b), 'zh') || rank(a) - rank(b) || (a.id < b.id ? -1 : 1);
    });
}

/** Terms of one search: every term must hit some field; the score says how good the hit is (title > tags / place > description). */
export function searchBackgrounds(list: readonly BackgroundEntry[], query: string): BackgroundEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...list];
  const out: Array<{ b: BackgroundEntry; s: number }> = [];
  for (const b of list) {
    const fields: Array<[string, number]> = [
      [b.name, 6], [b.tags.join(' '), 4], [`${b.labels?.placeName ?? ''} ${b.labels?.location ?? ''} ${b.location ?? ''}`, 4], [`${b.labels?.owner ?? ''} ${b.labels?.placeType ?? ''}`, 3],
      [`${b.setting ?? ''} ${b.time ?? ''} ${b.weather ?? ''}`, 2], [b.description ?? '', 1], [`${b.id} ${b.aliases.join(' ')}`, 1],
    ];
    const lower = fields.map(([t, w]) => [t.toLowerCase(), w] as const);
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const hit = lower.filter(([text]) => text.includes(t));
      if (hit.length === 0) { ok = false; break; }
      score += Math.max(...hit.map(([, w]) => w));
    }
    if (ok) out.push({ b, s: score });
  }
  return out.sort((x, y) => y.s - x.s || (x.b.id < y.b.id ? -1 : 1)).map((x) => x.b);
}

const TIME_ZH: Record<string, string> = { day: '日间', dusk: '傍晚', night: '夜间' };

/** A catalog-shaped entry from a label alone (the workbench shows labels even when the asset library is missing); `from` is the real catalog entry when there is one. */
export function entryFromLabel(id: string, l: BgLabel, from?: BackgroundEntry): BackgroundEntry {
  const base: BackgroundEntry = from
    ? { ...from }
    : { id, url: `/assets/backgrounds/${encodeURIComponent(id)}.png`, width: null, height: null, name: id, aliases: [], kind: /^\d+$/.test(id) ? 'card' : 'scene', location: null, category: null, setting: null, time: null, weather: null, description: null, tags: [] };
  return {
    ...base,
    name: l.title ?? l.nameOverride ?? base.name,
    description: l.description ?? l.descriptionOverride ?? base.description,
    tags: [...new Set([...base.tags, ...(l.tags ?? [])])],
    location: l.placeName ?? l.location ?? base.location,
    setting: from?.setting ?? (l.indoor === 'outdoor' ? '室外' : l.indoor === 'indoor' ? '室内' : null),
    time: from?.time ?? TIME_ZH[l.time] ?? null,
    labels: l,
    category: bgCategoryOf({ id, kind: base.kind, labels: l }),
  };
}
