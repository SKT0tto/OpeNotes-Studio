/**
 * Writes .verify/bg/sheet-index.json: where every background sits on the contact sheets (sheet-NN.jpg: 4x4 cells of 400x225 with an 18 px title
 * strip, 25 px gap between rows; new-01.jpg: 2x4 cells of 640x360 for the 8 backgrounds added later). Developer tool; .verify is not shipped.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LabelFileSchema } from '../shared/schema/assetLabels';

const dir = path.resolve('.verify', 'bg');
const labels = LabelFileSchema.parse(JSON.parse(await fs.readFile('asset-labels/backgrounds.json', 'utf8')));
const NEW = new Set(Array.from({ length: 8 }, (_, i) => `adv_bkg_stage_${String(357 + i).padStart(6, '0')}`));
const cmp = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);
const old = Object.keys(labels.labels).filter((id) => !NEW.has(id)).sort(cmp);
const index: Record<string, { sheet: string; x: number; y: number; w: number; h: number; sheetW: number; sheetH: number }> = {};
old.forEach((id, i) => {
  const sheet = `sheet-${String(Math.floor(i / 16) + 1).padStart(2, '0')}.jpg`;
  const col = i % 4;
  const row = Math.floor((i % 16) / 4);
  index[id] = { sheet, x: col * 400, y: row * 250 + 18, w: 400, h: 207, sheetW: 1600, sheetH: 1000 };
});
[...NEW].sort().forEach((id, i) => {
  index[id] = { sheet: 'new-01.jpg', x: (i % 2) * 640, y: Math.floor(i / 2) * 360 + 18, w: 640, h: 342, sheetW: 1280, sheetH: 1440 };
});
await fs.writeFile(path.join(dir, 'sheet-index.json'), JSON.stringify(index, null, 1) + '\n');
console.log(`sheet-index.json: ${Object.keys(index).length} backgrounds`);
