/** "Set as someone's home" and the character search used by the workbench's detail editor. */
import type { BgLabelPatch } from '../schema/assetLabels';

export interface HomeCharacter { key: string; name: string; band: string }

/** Romanised / short names so that typing "Uika" finds 三角初华 (the data file only holds the Chinese names). */
const ALIASES: Record<string, string> = {
  '001': 'tomori anon', '002': 'anon chihaya', '003': 'rana kaname', '004': 'soyo nagasaki', '005': 'taki shiina',
  '006': 'uika misumi', '007': 'mutsumi wakaba', '008': 'umiri yahata', '009': 'nyamu yutenji', '010': 'sakiko togawa',
};
const TIME_ZH: Record<string, string> = { day: '日间', dusk: '傍晚', night: '夜间' };

/** Characters matching `q` by name, key, romanised name or band name (empty query = none). */
export function searchCharacters<T extends HomeCharacter>(list: readonly T[], q: string, bandName: (key: string) => string = (k) => k): T[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return list.filter((c) => `${c.name} ${c.key} ${ALIASES[c.key] ?? ''} ${bandName(c.band)}`.toLowerCase().includes(s));
}

/** Title for a home: "<名字>家·<区域>（时段）"; the area and the time of day are left out when empty / unspecified. */
export function homeTitle(name: string, area: string, time: string | undefined): string {
  const t = time ? TIME_ZH[time] : undefined;
  return `${name}家${area.trim() ? `·${area.trim()}` : ''}${t ? `（${t}）` : ''}`;
}

/** The label fields that make a background `c`'s private home (bands = her band, private, exclusive, place = "<名字>家") plus the proposed title. */
export function homePatch(c: HomeCharacter, area = '', time?: string): BgLabelPatch {
  return {
    owner: c.name, ownerKey: c.key, residents: [c.key], bands: [c.band], homeBand: c.band, access: 'private', exclusive: true,
    placeName: `${c.name}家`, title: homeTitle(c.name, area, time),
  };
}
