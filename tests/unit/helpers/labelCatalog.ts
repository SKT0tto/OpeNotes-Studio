import fs from 'node:fs';
import { LabelFileSchema, type BgLabel } from '../../../shared/schema/assetLabels';
import type { BackgroundEntry } from '../../../shared/schema/assets';
import type { DirectorCatalog } from '../../../shared/director/resources';
import { bgCategoryOf } from '../../../shared/director/bgCategory';
import { fixtureCatalog } from './directorCatalog';

export const LABEL_FILE = LabelFileSchema.parse(JSON.parse(fs.readFileSync('asset-labels/backgrounds.json', 'utf8')));
export const stage = (n: number) => `adv_bkg_stage_${String(n).padStart(6, '0')}`;
const TIME: Record<string, string> = { day: '日间', dusk: '傍晚', night: '夜间' };

/** A catalog entry built from a label alone (what the indexer makes from label + manifest). */
export function bgFromLabel(id: string, l: BgLabel): BackgroundEntry {
  const card = /^\d+$/.test(id);
  const e: BackgroundEntry = {
    id, url: `/assets/backgrounds/${id}.png`, width: card ? 1600 : 2048, height: card ? 900 : 1119, name: l.title ?? l.nameOverride ?? id, aliases: [], kind: card ? 'card' : 'scene',
    location: l.placeName ?? l.location ?? null, category: null, setting: l.indoor === 'outdoor' ? '室外' : '室内', time: TIME[l.time] ?? null, weather: null,
    description: l.description ?? null, tags: l.tags ?? [], labels: l,
  };
  e.category = bgCategoryOf(e);
  return e;
}

/** Real labels (349 backgrounds), synthetic models of the recorded fixtures. */
export function labelCatalog(extraKeys: string[] = ['002', '003', '004', '005']): DirectorCatalog {
  const base = fixtureCatalog(extraKeys);
  const nick: Record<string, string> = { '001': '灯', '002': '爱音', '003': '乐奈', '004': '爽世', '005': '立希' };
  return {
    ...base,
    characters: base.characters.map((c) => ({ ...c, nickname: nick[c.key] ?? null, aliases: nick[c.key] ? [nick[c.key]!] : [] })),
    backgrounds: Object.entries(LABEL_FILE.labels).map(([id, l]) => bgFromLabel(id, l)),
    labelRules: LABEL_FILE.rules,
  };
}
