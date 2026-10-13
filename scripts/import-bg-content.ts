/** One-off, idempotent: merge dev-notes/bg-content.json into asset-labels/backgrounds.json (P20-0). Usage: tsx scripts/import-bg-content.ts [content.json] [labels.json] */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LabelFileSchema } from '../shared/schema/assetLabels';
import { mergeBgContent, type BgContent } from '../shared/catalog/importBgContent';

const contentFile = path.resolve(process.argv[2] ?? 'dev-notes/bg-content.json');
const labelsFile = path.resolve(process.argv[3] ?? 'asset-labels/backgrounds.json');
const content = JSON.parse(await fs.readFile(contentFile, 'utf8')) as BgContent;
const file = LabelFileSchema.parse(JSON.parse(await fs.readFile(labelsFile, 'utf8')));
const summary = mergeBgContent(file, content);
await fs.writeFile(labelsFile, JSON.stringify(LabelFileSchema.parse(file), null, 1) + '\n');
console.log(JSON.stringify({ ...summary, changed: summary.changed.length }, null, 1));
