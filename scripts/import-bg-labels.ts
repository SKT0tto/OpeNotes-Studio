/** One-off generator of asset-labels/backgrounds.json from docs/bg-labels.draft.json plus the user's R1/R2 answers. Run: npx tsx scripts/import-bg-labels.ts */
import fs from 'node:fs';
import chars from '../shared/data/characters.json';
import bands from '../shared/data/bands.json';
import { LabelFileSchema, type BgLabel } from '../shared/schema/assetLabels';

const draft = JSON.parse(fs.readFileSync('docs/bg-labels.draft.json', 'utf8')) as Record<string, Record<string, unknown>>;
delete draft._meta;
const keyOfName = (n: string | null) => (n ? chars.characters.find((c) => c.name === n.split('（')[0])?.key ?? null : null);
const stage = (n: number) => `adv_bkg_stage_${String(n).padStart(6, '0')}`;
const now = '2026-10-10';
const ANS = 'user R2';
const labels: Record<string, BgLabel> = {};
for (const [id, v] of Object.entries(draft)) {
  const rest = { ...v };
  delete rest.name;
  delete rest.weather;
  labels[id] = { source: 'draft', ...rest } as unknown as BgLabel;
}
const set = (ids: string[], patch: Partial<BgLabel>) => { for (const id of ids) Object.assign(labels[id]!, patch, { source: 'user' }); };

// R2-6: vehicles are generic
set([61, 62, 95, 96, 111, 112, 128, 276, 306].map(stage), { bands: ['generic'], exclusive: false, confidence: 'confirmed', answer: `${ANS}：车辆通用，任何人可用`, question: null });
// R2-3: 046 is Saki's house
set([stage(46)], { bands: ['avemujica'], access: 'private', location: '祥子家', placeName: '祥子家', owner: '丰川祥子', exclusive: true, confidence: 'confirmed', answer: `${ANS}：046=祥子家（Ave Mujica）`, question: null });
// R2-5b: Roarin' Nest, home ground of 一家Dumb Rock!, anyone may use
set(['27', '28', stage(22)], { bands: ['generic'], affinity: ['dumbrock'], homeBand: 'dumbrock', exclusive: false, confidence: 'confirmed', answer: `${ANS}：Roarin' Nest 主场一家Dumb Rock!（软偏好），任何乐队可用`, question: null });
// R2-7: VR Floor and the blue virtual stage are MewType only
set(['20', stage(257), stage(320)], { bands: ['mewtype'], exclusive: true, confidence: 'confirmed', answer: `${ANS}：MewType 专属`, question: null });
set([stage(257), stage(320)], { stage: true });
// Ritsu's rooms: only 313 and 314; 267 is Arale's; 266 owner unknown
set([stage(267)], { bands: ['mewtype'], owner: '仲町阿拉蕾', location: '阿拉蕾的房间', placeName: '阿拉蕾的房间', exclusive: true, confidence: 'confirmed', usage: { moods: ['sad', 'emo', 'melancholy', '忧郁', '低落', '消沉', '难过', '伤感'], activity: 'singing', rarity: 'rare' }, answer: `${ANS}：267 衣柜暗室属于阿拉蕾；很少用，仅在阿拉蕾情绪低落（emo）时去那里唱歌`, question: null });
set([stage(266)], { bands: [], owner: null, location: null, placeName: null, exclusive: false, confidence: 'unknown', question: 'R2-9', answer: `${ANS}：266 不属于律，主人不明（按 R2-9 处理）`, evidence: '拍摄灯少女卧室；用户答复不属于律，主人不明' });
for (const id of [stage(313), stage(314)]) set([id], { answer: `${ANS}：律的房间只有 313/314` });

// residents (who lives there): the owner; Peace之家 is shared by the whole 一家Dumb Rock!
const dumb = bands.bands.find((b) => b.key === 'dumbrock')!.members;
for (const l of Object.values(labels)) {
  if (l.access !== 'private' || !l.owner) continue;
  l.ownerKey = keyOfName(l.owner);
  l.residents = l.location === 'Peace之家' ? dumb : l.ownerKey ? [l.ownerKey] : [];
}
// catalog description errors (the external manifest is left alone)
const rename = (n: number, name: string, desc?: string) => Object.assign(labels[stage(n)]!, { nameOverride: name, ...(desc ? { descriptionOverride: desc } : {}) });
rename(16, '水瀬女子学園 校门前 · 日间 · 晴天', '水瀬女子学園的玻璃校舍、步道和绿树（立柱刻校名）');
rename(18, '都立芸術学院中学校 剧场外观 · 日间 · 晴天', '都立芸術学院中学校的两层剧场建筑、入口台阶和玻璃门');
rename(121, '码头停车区 · 日间 · 晴天', '码头旁的停车区，高台设施、车辆与山景');
for (const [n, t] of [[181, '傍晚 · 晴天'], [182, '夜间'], [220, '日间 · 晴天']] as const) rename(n, `花咲川女子学園 校门 · ${t}`);

for (const l of Object.values(labels)) l.updatedAt = now;
const ids = Object.keys(labels).sort((a, b) => (Number.isNaN(+a) === Number.isNaN(+b) ? (a < b ? -1 : 1) : Number.isNaN(+a) ? 1 : -1));
const file = LabelFileSchema.parse({ version: 1, rules: { unknownPolicy: 'avoid' }, labels: Object.fromEntries(ids.map((i) => [i, labels[i]])) });
fs.mkdirSync('asset-labels', { recursive: true });
fs.writeFileSync('asset-labels/backgrounds.json', JSON.stringify(file, null, 1) + '\n');
const c: Record<string, number> = {};
for (const l of Object.values(file.labels)) c[l.confidence] = (c[l.confidence] ?? 0) + 1;
console.log(ids.length, c);
