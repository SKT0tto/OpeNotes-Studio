/**
 * Haneoka (haneoka.org) metadata adapter. MANUAL-ONLY: reads three public JSON indexes, never downloads any media,
 * and only produces links to Haneoka's own pages. There is deliberately no method that plans or fetches files.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import charactersData from '../../../shared/data/characters.json';
import bandsData from '../../../shared/data/bands.json';
import { REPO_URL } from '../../../shared/meta';
import type { LabelFile } from '../../../shared/schema/assetLabels';

export const HANEOKA_ORIGIN = 'https://haneoka.org';
export const HANEOKA_PATHS = {
  live2d: '/api/v1/live2d',
  storyBackgrounds: '/api/v1/story-assets/views/backgrounds',
  cardBackgrounds: '/api/v1/backgrounds',
} as const;
export const HANEOKA_TTL_MS = 24 * 60 * 60 * 1000;
/** Bump whenever the disclaimer text changes: everyone has to confirm again. */
export const HANEOKA_DISCLAIMER_VERSION = '2026-10-10.1';
export const HANEOKA_DISCLAIMER = [
  '游戏素材（Live2D 模型、背景、音频、文本等）的权利归 Bushiroad、Craft Egg 等权利人所有。OpeNotes Studio 不提供、也不托管任何素材。',
  'Haneoka（haneoka.org）是第三方站点。其使用条款（§2）明确禁止在未经权利人或适用法律允许的情况下，下载素材用于再利用、改编、再发布或批量重新打包。',
  '本功能只读取该站公开的元数据索引，生成一份“缺哪些”的清单，每一项只链接到 Haneoka 对应的页面；不提供素材直链，也不会自动下载任何素材。',
  '是否下载、如何下载，由你自己在站点上操作，并由你自己确认：你有权使用这些素材，并遵守该站条款与适用法律。',
];

const L = (v: unknown): string | null => (Array.isArray(v) ? (typeof v[3] === 'string' ? v[3] : typeof v[1] === 'string' ? v[1] : null) : null);

const ModelRec = z.looseObject({
  live2dKey: z.string(),
  characterKey: z.string().nullish(),
  label: z.string().nullish(),
  mode: z.string().nullish(),
  quality: z.string().nullish(),
  subCharacter: z.boolean().nullish(),
  characterName: z.array(z.string()).nullish(),
});
const StoryRec = z.looseObject({ assetName: z.string() });
const CardRec = z.looseObject({ backgroundId: z.union([z.number(), z.string()]), image: z.string().nullish(), name: z.array(z.string()).nullish() });

export interface HModel { id: string; characterKey: string; label: string; mode: string; quality: string; sub: boolean; characterName: string | null }
export interface HStory { id: string }
export interface HCard { id: string; name: string | null; stem: string | null }
export interface HaneokaData { fetchedAt: number; releaseId: string | null; models: HModel[]; story: HStory[]; cards: HCard[] }
interface CacheFile extends HaneokaData { etags: Record<string, string> }

export class HaneokaFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HaneokaFormatError';
  }
}

export function parseModels(json: unknown): HModel[] {
  const obj = z.record(z.string(), z.unknown()).safeParse(json);
  if (!obj.success) throw new HaneokaFormatError('live2d 索引格式与预期不符');
  const out: HModel[] = [];
  for (const v of Object.values(obj.data)) {
    const m = ModelRec.safeParse(v);
    if (!m.success) continue;
    const r = m.data;
    out.push({
      id: r.live2dKey,
      characterKey: r.characterKey ?? r.live2dKey.split('_')[0]!,
      label: r.label ?? r.live2dKey,
      mode: r.mode ?? '',
      quality: r.quality ?? '',
      sub: Boolean(r.subCharacter),
      characterName: L(r.characterName),
    });
  }
  if (out.length === 0) throw new HaneokaFormatError('live2d 索引中没有可识别的条目');
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseStory(json: unknown): HStory[] {
  const obj = z.record(z.string(), z.unknown()).safeParse(json);
  if (!obj.success) throw new HaneokaFormatError('剧情背景索引格式与预期不符');
  const out = Object.values(obj.data).flatMap((v) => {
    const r = StoryRec.safeParse(v);
    return r.success ? [{ id: r.data.assetName }] : [];
  });
  if (out.length === 0) throw new HaneokaFormatError('剧情背景索引中没有可识别的条目');
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function parseCards(json: unknown): HCard[] {
  const entries = z.object({ entries: z.record(z.string(), z.unknown()) }).safeParse(json);
  if (!entries.success) throw new HaneokaFormatError('名片背景索引格式与预期不符');
  const out = Object.values(entries.data.entries).flatMap((v) => {
    const r = CardRec.safeParse(v);
    if (!r.success) return [];
    const base = r.data.image?.split('/').pop() ?? null;
    return [{ id: String(r.data.backgroundId), name: L(r.data.name), stem: base ? base.replace(/\.png$/i, '') : null }];
  });
  if (out.length === 0) throw new HaneokaFormatError('名片背景索引中没有可识别的条目');
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

export interface HaneokaDeps {
  cacheFile: string;
  version: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
}

/**
 * Serial, low-frequency reader: at most three requests per refresh, conditional (If-None-Match) once the cache is
 * older than 24 hours. The release id of the first response is only recorded (the global routes reject `?release=`).
 * No probing, no per-file requests.
 */
export class HaneokaSource {
  /** Number of HTTP requests this instance has made (asserted in tests). */
  requests = 0;
  constructor(private readonly deps: HaneokaDeps) {}

  private get base() {
    return this.deps.baseUrl ?? HANEOKA_ORIGIN;
  }

  async readCache(): Promise<CacheFile | null> {
    try {
      return JSON.parse(await fs.readFile(this.deps.cacheFile, 'utf8')) as CacheFile;
    } catch {
      return null;
    }
  }

  async load(opts: { force?: boolean } = {}): Promise<{ data: HaneokaData; fromCache: boolean }> {
    const now = (this.deps.now ?? Date.now)();
    const cache = await this.readCache();
    if (cache && !opts.force && now - cache.fetchedAt < HANEOKA_TTL_MS) return { data: cache, fromCache: true };

    const f = this.deps.fetch ?? fetch;
    const etags: Record<string, string> = {};
    let releaseId: string | null = null;
    const get = async (key: keyof typeof HANEOKA_PATHS): Promise<unknown | 'same'> => {
      const url = `${this.base}${HANEOKA_PATHS[key]}`;
      const headers: Record<string, string> = {
        'user-agent': `OpeNotesStudio/${this.deps.version} (+${REPO_URL})`,
        accept: 'application/json',
      };
      if (cache?.etags[key]) headers['if-none-match'] = cache.etags[key]!;
      this.requests++;
      const res = await f(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (res.status === 304) {
        etags[key] = cache?.etags[key] ?? '';
        return 'same';
      }
      if (!res.ok) throw new Error(`Haneoka ${HANEOKA_PATHS[key]}: HTTP ${res.status}`);
      const tag = res.headers.get('etag');
      if (tag) etags[key] = tag;
      releaseId ??= res.headers.get('x-haneoka-release-id');
      return await res.json();
    };

    const live = await get('live2d');
    const story = await get('storyBackgrounds');
    const cards = await get('cardBackgrounds');
    const data: CacheFile = {
      fetchedAt: now,
      releaseId: releaseId ?? cache?.releaseId ?? null,
      models: live === 'same' ? cache!.models : parseModels(live),
      story: story === 'same' ? cache!.story : parseStory(story),
      cards: cards === 'same' ? cache!.cards : parseCards(cards),
      etags,
    };
    await fs.mkdir(path.dirname(this.deps.cacheFile), { recursive: true });
    const tmp = `${this.deps.cacheFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, this.deps.cacheFile);
    return { data, fromCache: false };
  }
}

// --- listing -----------------------------------------------------------------------------------------------

export interface ListModel { id: string; label: string; mode: string; low: boolean; have: boolean; url: string }
export interface ListCharacter { key: string; name: string; models: ListModel[] }
export interface ListBand { key: string; name: string; characters: ListCharacter[] }
export interface ListBackground { id: string; kind: 'story' | 'card'; name: string | null; have: boolean; labelled: boolean; band: string | null; place: string | null; url: string }
export interface HaneokaList {
  releaseId: string | null;
  fetchedAt: number;
  locale: string;
  bands: ListBand[];
  backgrounds: ListBackground[];
  counts: { models: number; modelsMissing: number; backgrounds: number; backgroundsMissing: number };
}

export const HANEOKA_LOCALES = ['en', 'ja', 'ko', 'zh-CN', 'zh-TW'] as const;
const pageBase = (server: string, locale: string) => `${HANEOKA_ORIGIN}/${server}/${locale}`;

/** Haneoka PAGE links (never media URLs). */
export const modelPageUrl = (id: string, server = 'intl', locale = 'en') => `${pageBase(server, locale)}/live2d/${encodeURIComponent(id)}/`;
export const cardBackgroundPageUrl = (id: string, server = 'intl', locale = 'en') => `${pageBase(server, locale)}/backgrounds/${encodeURIComponent(id)}/`;
/** Story backgrounds have no verified detail page; they live under the site's asset browser. */
export const storyBackgroundPageUrl = (server = 'intl', locale = 'en') => `${pageBase(server, locale)}/assets/`;

export function buildList(
  data: HaneokaData,
  have: { models: ReadonlySet<string>; backgrounds: ReadonlySet<string> },
  labels: LabelFile | null,
  opts: { locale?: string; server?: string } = {},
): HaneokaList {
  const locale = opts.locale ?? 'en';
  const server = opts.server ?? 'intl';
  const charBand = new Map(charactersData.characters.map((c) => [c.key, c]));
  const bandName = new Map(bandsData.bands.map((b) => [b.key, b.name]));
  const bandOrder = bandsData.bands.map((b) => b.key);
  const NPC = '__npc';
  const groups = new Map<string, Map<string, ListCharacter>>();
  for (const m of data.models) {
    const known = charBand.get(m.characterKey);
    const band = known?.band ?? NPC;
    const chars = groups.get(band) ?? new Map<string, ListCharacter>();
    groups.set(band, chars);
    const c = chars.get(m.characterKey) ?? { key: m.characterKey, name: known?.name ?? m.characterName ?? m.characterKey, models: [] };
    chars.set(m.characterKey, c);
    c.models.push({ id: m.id, label: m.label, mode: m.mode, low: m.quality === 'low' || m.id.endsWith('_low'), have: have.models.has(m.id), url: modelPageUrl(m.id, server, locale) });
  }
  const bands: ListBand[] = [...bandOrder, NPC]
    .filter((k) => groups.has(k))
    .map((k) => ({ key: k, name: k === NPC ? '配角 / NPC' : (bandName.get(k) ?? k), characters: [...groups.get(k)!.values()].sort((a, b) => a.key.localeCompare(b.key)) }));

  const bgInfo = (id: string) => {
    const l = labels?.labels[id];
    return { labelled: Boolean(l), band: l ? (l.homeBand ?? (l.bands.length ? l.bands.join('/') : null)) : null, place: l ? (l.placeName ?? l.placeType) : null };
  };
  const backgrounds: ListBackground[] = [
    ...data.story.map((s): ListBackground => ({ id: s.id, kind: 'story', name: null, have: have.backgrounds.has(s.id), ...bgInfo(s.id), url: storyBackgroundPageUrl(server, locale) })),
    ...data.cards.map((c): ListBackground => ({ id: c.id, kind: 'card', name: c.name, have: have.backgrounds.has(c.id), ...bgInfo(c.id), url: cardBackgroundPageUrl(c.id, server, locale) })),
  ];
  return {
    releaseId: data.releaseId,
    fetchedAt: data.fetchedAt,
    locale,
    bands,
    backgrounds,
    counts: {
      models: data.models.length,
      modelsMissing: data.models.filter((m) => !have.models.has(m.id)).length,
      backgrounds: backgrounds.length,
      backgroundsMissing: backgrounds.filter((b) => !b.have).length,
    },
  };
}

// --- manifest ----------------------------------------------------------------------------------------------

export interface ManifestItem { kind: 'model' | 'story-background' | 'card-background'; id: string; label: string; pageUrl: string; where: string }

export function buildManifestItems(list: HaneokaList, sel: { models: string[]; backgrounds: string[] }): ManifestItem[] {
  const items: ManifestItem[] = [];
  const wantM = new Set(sel.models);
  const wantB = new Set(sel.backgrounds);
  for (const b of list.bands) {
    for (const c of b.characters) {
      for (const m of c.models) {
        if (wantM.has(m.id)) items.push({ kind: 'model', id: m.id, label: `${b.name} / ${c.name} / ${m.label}${m.low ? '（低模）' : ''}`, pageUrl: m.url, where: '打开页面，在 Live2D 查看器里点 “Download model ZIP”，保存后用本地导入' });
      }
    }
  }
  for (const g of list.backgrounds) {
    if (!wantB.has(g.id)) continue;
    if (g.kind === 'card') items.push({ kind: 'card-background', id: g.id, label: `名片背景 ${g.id}${g.name ? ` ${g.name}` : ''}`, pageUrl: g.url, where: `在页面中查看图片并自行保存为 ${g.id}.png，再用本地导入` });
    else items.push({ kind: 'story-background', id: g.id, label: `剧情背景 ${g.id}${g.place ? `（${g.place}）` : ''}`, pageUrl: g.url, where: `在站点资源页搜索 ${g.id}；保存的图片请命名为 ${g.id}.png，再用本地导入` });
  }
  return items;
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|');
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const KIND_LABEL: Record<ManifestItem['kind'], string> = { model: '模型', 'story-background': '剧情背景', 'card-background': '名片背景' };

export function manifestMarkdown(items: ManifestItem[], list: Pick<HaneokaList, 'releaseId' | 'fetchedAt'>): string {
  const lines = [
    '# OpeNotes Studio 素材清单',
    '',
    `生成于 ${new Date(list.fetchedAt).toISOString().slice(0, 10)}（站点 release：${list.releaseId ?? '未知'}）。共 ${items.length} 项。`,
    '',
    '> 素材权利属于 Bushiroad / Craft Egg 等权利人。Haneoka 条款禁止未经许可下载再利用；请自行确认有权使用后，到下列页面手动下载，再用 OpeNotes Studio 的“本地导入”导入。本清单只含页面链接。',
    '',
    '| 类型 | id | 说明 | 站点页面 | 导入提示 |',
    '|---|---|---|---|---|',
    ...items.map((i) => `| ${KIND_LABEL[i.kind]} | \`${i.id}\` | ${mdCell(i.label)} | [打开](${i.pageUrl}) | ${mdCell(i.where)} |`),
    '',
  ];
  return lines.join('\n');
}

export function manifestCsv(items: ManifestItem[]): string {
  return `\uFEFF${['type,id,label,page,note', ...items.map((i) => [KIND_LABEL[i.kind], i.id, i.label, i.pageUrl, i.where].map(csvCell).join(','))].join('\r\n')}\r\n`;
}
