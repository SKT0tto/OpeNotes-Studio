import { createHash } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import charactersData from '../../shared/data/characters.json';
import bandsData from '../../shared/data/bands.json';
import { parseCostume, splitModelId } from '../../shared/catalog/costume';
import { parseExpressionName } from '../../shared/catalog/expressionNames';
import { parseMotionName } from '../../shared/catalog/motionNames';
import type {
  AudioEntry, BackgroundEntry, BandEntry, Catalog, CharacterEntry, ExpressionEntry, ModelEntry, MotionEntry,
} from '../../shared/schema/assets';
import { resolveInside } from '../util/safePath';
import { readMotionStats } from './motionStats';
import { readLabelFile } from './labels';
import { bgCategoryOf } from '../../shared/director/bgCategory';
import type { LabelFile } from '../../shared/schema/assetLabels';

export const NPC_BAND_NAME = '配角 / NPC';
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac', '.opus']);
/** Bump whenever ModelEntry's shape or the motion/expression name parsing changes. */
const CACHE_SCHEMA = 2;

export interface ModelPart { models: ModelEntry[]; modelSigs: string[]; modelWarnings: string[] }
const MODEL_PARTS = new WeakMap<Catalog, ModelPart>();

export interface IndexerOptions {
  assetRoot: string;
  audioRoots?: string[];
  /** Index cache file (inside the writable data dir). Omit to disable caching. */
  cacheFile?: string;
  /** Background labels (asset-labels/backgrounds.json). Omit for none. */
  labelsFile?: string;
  /** Reuse the model part of a previous build (labels-only refresh). */
  reuse?: ModelPart;
  /** Max concurrent motion file reads. */
  concurrency?: number;
  log?: (msg: string) => void;
}

interface Manifest {
  models?: Array<{
    id: string; name?: string; nickname?: string; characterKey?: string; bandName?: string;
    color?: string; aliases?: string[]; subCharacter?: boolean;
  }>;
  backgrounds?: Array<Record<string, unknown> & { id: string }>;
}

interface CacheFile {
  schema: number;
  assetRoot: string;
  models: Record<string, { sig: string; entry: ModelEntry }>;
}

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function statOrNull(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function listDirs(p: string): Promise<string[]> {
  try {
    return (await fs.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

/** Width/height from a PNG header (IHDR), or nulls when the file is not a PNG. */
export async function readPngSize(file: string): Promise<{ width: number | null; height: number | null }> {
  let fh: FileHandle | null = null;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(24);
    const { bytesRead } = await fh.read(buf, 0, 24, 0);
    if (bytesRead === 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch {
    /* fall through */
  } finally {
    await fh?.close();
  }
  return { width: null, height: null };
}

const encodePath = (rel: string) => rel.split('/').map(encodeURIComponent).join('/');

interface Model3 {
  FileReferences?: {
    Moc?: string;
    Textures?: string[];
    Physics?: string;
    Expressions?: Array<{ Name?: string; File?: string }>;
    Motions?: Record<string, Array<{ File?: string }>>;
  };
}

async function indexModel(
  modelsDir: string, id: string, readLimit: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<ModelEntry> {
  const dir = path.join(modelsDir, id);
  const json = JSON.parse(await fs.readFile(path.join(dir, 'model3.json'), 'utf8')) as Model3;
  const refs = json.FileReferences ?? {};
  const exists = async (rel: string | undefined): Promise<boolean> => {
    if (!rel) return false;
    const abs = resolveInside(dir, rel);
    return abs !== null && (await statOrNull(abs)) !== null;
  };
  const missing: string[] = [];
  const check = async (rel: string | undefined) => {
    if (rel && !(await exists(rel))) missing.push(rel);
  };
  await check(refs.Moc);
  for (const t of refs.Textures ?? []) await check(t);
  const hasPhysics = await exists(refs.Physics);
  if (refs.Physics && !hasPhysics) missing.push(refs.Physics);

  const expressions: ExpressionEntry[] = [];
  for (const e of refs.Expressions ?? []) {
    if (!e.Name || !e.File) continue;
    await check(e.File);
    const p = parseExpressionName(e.Name);
    expressions.push({ name: e.Name, file: e.File, family: p.family, index: p.index });
  }

  const motions = await Promise.all(
    Object.entries(refs.Motions ?? {}).flatMap(([name, list]) => {
      const file = list[0]?.File;
      if (!file) return [];
      return [readLimit(async (): Promise<MotionEntry> => {
        const abs = resolveInside(dir, file);
        const stats = abs ? await readMotionStats(abs) : null;
        if (!stats) missing.push(file);
        const p = parseMotionName(name);
        return { name, file, family: p.family, side: p.side, variant: p.variant, stats };
      })];
    }),
  );
  motions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const preview = (await exists('preview.png')) ? `/assets/models/${encodeURIComponent(id)}/preview.png` : null;
  return {
    id,
    ...idDerived(id),
    hasPhysics,
    url: `/assets/models/${encodeURIComponent(id)}/model3.json`,
    preview,
    textureCount: (refs.Textures ?? []).length,
    motions,
    expressions,
    missingFiles: missing,
  };
}

/** Fields that depend only on the directory name; recomputed even for cached entries. */
function idDerived(id: string) {
  const parts = splitModelId(id);
  const info = parseCostume(parts.costume);
  return {
    characterKey: parts.characterKey,
    isSub: parts.isSub,
    costume: parts.costume,
    costumeInfo: info,
    mode: info.mode,
    quality: info.quality,
    still: info.still,
  };
}

async function modelSignature(modelsDir: string, id: string): Promise<string> {
  const dir = path.join(modelsDir, id);
  const stats = await Promise.all(
    ['model3.json', '.', 'motions', 'expressions', 'preview.png'].map((n) => statOrNull(path.join(dir, n))),
  );
  return stats.map((s) => (s ? `${s.mtimeMs}:${s.size}` : '-')).join('|');
}

async function readManifest(assetRoot: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(assetRoot, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

async function indexBackgrounds(assetRoot: string, manifest: Manifest | null, sigs: string[], labels: LabelFile | null): Promise<BackgroundEntry[]> {
  const dir = path.join(assetRoot, 'backgrounds');
  let files: string[] = [];
  let metas = new Set<string>();
  try {
    const all = await fs.readdir(dir);
    files = all.filter((f) => f.toLowerCase().endsWith('.png'));
    metas = new Set(all.filter((f) => f.endsWith('.meta.json')));
  } catch {
    /* no backgrounds dir */
  }
  const meta = new Map((manifest?.backgrounds ?? []).map((b) => [String(b.id), b]));
  const entries = await mapPool(files, 32, async (file): Promise<BackgroundEntry> => {
    const id = file.slice(0, -4);
    const abs = path.join(dir, file);
    const [size, st] = await Promise.all([readPngSize(abs), statOrNull(abs)]);
    sigs.push(`bg:${id}:${st?.size ?? 0}:${st?.mtimeMs ?? 0}`);
    const m = meta.get(id);
    const strArray = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const label = labels?.labels[id];
    let upName: string | null = null;
    if (metas.has(`${id}.meta.json`)) {
      try {
        const n = (JSON.parse(await fs.readFile(path.join(dir, `${id}.meta.json`), 'utf8')) as { name?: unknown }).name;
        if (typeof n === 'string' && n.trim()) upName = n.trim();
      } catch {
        /* malformed sidecar: ignore */
      }
    }
    return {
      id,
      url: `/assets/backgrounds/${encodeURIComponent(file)}`,
      width: size.width ?? (typeof m?.width === 'number' ? m.width : null),
      height: size.height ?? (typeof m?.height === 'number' ? m.height : null),
      name: label?.title ?? label?.nameOverride ?? upName ?? str(m?.name) ?? id,
      aliases: strArray(m?.aliases),
      kind: str(m?.kind),
      location: str(m?.location),
      category: bgCategoryOf({ id, kind: str(m?.kind), labels: label }),
      setting: str(m?.setting) ?? (label?.indoor === 'outdoor' ? '室外' : label?.indoor === 'indoor' ? '室内' : null),
      time: str(m?.time) ?? ({ day: '日间', dusk: '傍晚', night: '夜间' } as Record<string, string>)[label?.time ?? ''] ?? null,
      weather: str(m?.weather),
      description: label?.description ?? label?.descriptionOverride ?? str(m?.description),
      tags: [...new Set([...strArray(m?.tags), ...(label?.tags ?? []), ...(upName ? ['用户上传'] : [])])],
      ...(label ? { labels: label } : {}),
    };
  });
  return entries.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
}

async function walkAudio(root: string, rel = '', depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  let items;
  try {
    items = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const it of items) {
    const r = rel ? `${rel}/${it.name}` : it.name;
    if (it.isDirectory()) out.push(...(await walkAudio(root, r, depth + 1)));
    else if (AUDIO_EXT.has(path.extname(it.name).toLowerCase())) out.push(r);
  }
  return out.sort();
}

async function indexAudio(assetRoot: string, audioRoots: string[], sigs: string[]): Promise<AudioEntry[]> {
  const out: AudioEntry[] = [];
  const add = async (root: string, rel: string, id: string, url: string, source: AudioEntry['source']) => {
    const st = await statOrNull(path.join(root, rel));
    if (!st) return;
    sigs.push(`audio:${id}:${st.size}`);
    out.push({ id, name: path.basename(rel), url, source, ext: path.extname(rel).slice(1).toLowerCase(), bytes: st.size });
  };
  const mediaRoot = path.join(assetRoot, 'media');
  for (const rel of await walkAudio(mediaRoot)) await add(mediaRoot, rel, `media/${rel}`, `/assets/media/${encodePath(rel)}`, 'media');
  for (const [i, root] of audioRoots.entries()) {
    for (const rel of await walkAudio(root)) await add(root, rel, `user${i}/${rel}`, `/audio/${i}/${encodePath(rel)}`, 'user');
  }
  return out;
}

function buildCharacters(models: ModelEntry[], manifest: Manifest | null): { characters: CharacterEntry[]; bands: BandEntry[] } {
  const bands: BandEntry[] = bandsData.bands.map((b) => ({ key: b.key, name: b.name, memberKeys: b.members, formation: b.formation }));
  const bandName = new Map(bands.map((b) => [b.key, b.name]));
  const known = new Map(charactersData.characters.map((c) => [c.key, c]));
  const manifestByKey = new Map<string, NonNullable<Manifest['models']>[number]>();
  for (const m of manifest?.models ?? []) if (m.characterKey && !manifestByKey.has(m.characterKey)) manifestByKey.set(m.characterKey, m);

  const keys = [...new Set(models.map((m) => m.characterKey))].sort();
  const characters = keys.map((key): CharacterEntry => {
    const k = known.get(key);
    const mf = manifestByKey.get(key);
    const isSub = key.startsWith('sub_');
    return {
      key,
      name: k?.name ?? mf?.name ?? (isSub ? key.slice(4) : key),
      nickname: mf?.nickname ?? null,
      bandKey: k?.band ?? null,
      bandName: k ? (bandName.get(k.band) ?? k.band) : isSub ? NPC_BAND_NAME : (mf?.bandName ?? NPC_BAND_NAME),
      role: k?.role ?? null,
      color: mf?.color ?? null,
      isSub,
      aliases: mf?.aliases ?? [],
      modelIds: models.filter((m) => m.characterKey === key).map((m) => m.id),
    };
  });
  return { characters, bands };
}

export async function buildCatalog(opts: IndexerOptions): Promise<Catalog> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const modelsDir = path.join(opts.assetRoot, 'models');
  const warnings: string[] = [];

  let cache: CacheFile | null = null;
  if (opts.cacheFile) {
    try {
      const c = JSON.parse(await fs.readFile(opts.cacheFile, 'utf8')) as CacheFile;
      if (c.schema === CACHE_SCHEMA && c.assetRoot === opts.assetRoot) cache = c;
    } catch {
      /* no usable cache */
    }
  }

  // Motion reads are the bulk of the work: one shared limiter bounds open files.
  const limit = opts.concurrency ?? 32;
  let active = 0;
  const waiters: Array<() => void> = [];
  const readLimit = async <T,>(fn: () => Promise<T>): Promise<T> => {
    while (active >= limit) await new Promise<void>((r) => waiters.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };

  const sigs: string[] = [];
  let reused = 0;
  let models: ModelEntry[];
  const nextCache: CacheFile = { schema: CACHE_SCHEMA, assetRoot: opts.assetRoot, models: {} };
  if (opts.reuse) {
    // labels-only refresh: the (expensive) model index of the previous build is still valid
    models = opts.reuse.models;
    sigs.push(...opts.reuse.modelSigs);
    warnings.push(...opts.reuse.modelWarnings);
  } else {
    const ids = await listDirs(modelsDir);
    const indexed = await mapPool(ids, 16, async (id): Promise<ModelEntry | null> => {
      if (!(await statOrNull(path.join(modelsDir, id, 'model3.json')))) {
        warnings.push(`models/${id}: no model3.json, skipped`);
        return null;
      }
      const sig = await modelSignature(modelsDir, id);
      sigs.push(`model:${id}:${sig}`);
      const hit = cache?.models[id];
      if (hit && hit.sig === sig) {
        reused++;
        const entry = { ...hit.entry, ...idDerived(id) };
        nextCache.models[id] = { sig, entry };
        return entry;
      }
      try {
        const entry = await indexModel(modelsDir, id, readLimit);
        nextCache.models[id] = { sig, entry };
        return entry;
      } catch (e) {
        warnings.push(`models/${id}: ${(e as Error).message}`);
        return null;
      }
    });
    models = indexed.filter((m): m is ModelEntry => m !== null);
    for (const m of models) {
      if (m.missingFiles.length) warnings.push(`models/${m.id}: ${m.missingFiles.length} referenced file(s) missing`);
    }
  }
  const modelSigs = [...sigs];
  const modelWarnings = [...warnings];

  const manifest = await readManifest(opts.assetRoot);
  let labels: LabelFile | null = null;
  if (opts.labelsFile) {
    try {
      labels = await readLabelFile(opts.labelsFile);
    } catch (e) {
      warnings.push(`背景标注文件无效，已忽略：${(e as Error).message.slice(0, 200)}`);
    }
  }
  const [backgrounds, audio] = await Promise.all([
    indexBackgrounds(opts.assetRoot, manifest, sigs, labels),
    indexAudio(opts.assetRoot, opts.audioRoots ?? [], sigs),
  ]);
  const { characters, bands } = buildCharacters(models, manifest);
  if (labels) {
    const have = new Set(backgrounds.map((b) => b.id));
    const stale = Object.keys(labels.labels).filter((id) => !have.has(id));
    if (stale.length > 0) warnings.push(`背景标注中有 ${stale.length} 个 id 在素材里不存在（${stale.slice(0, 5).join(', ')}${stale.length > 5 ? '…' : ''}）`);
    const unlabelled = backgrounds.filter((b) => !labels.labels[b.id]).length;
    if (unlabelled > 0) warnings.push(`${unlabelled} 张背景尚无标注，按通用处理（类别按 scene，进待确认队列）`);
    const cards = backgrounds.filter((b) => b.kind === 'card' && !labels.labels[b.id]?.category && Number(b.id) > 13);
    if (cards.length > 0) warnings.push(`${cards.length} 张名片背景（${cards.slice(0, 4).map((b) => b.id).join(', ')}…）可能是其它背景的重复拷贝`);
    sigs.push(`labels:${createHash('sha1').update(JSON.stringify(labels)).digest('hex')}`);
  }

  const version = createHash('sha1').update(sigs.sort().join('\n')).digest('hex').slice(0, 16);
  if (opts.cacheFile && !opts.reuse) {
    try {
      await fs.mkdir(path.dirname(opts.cacheFile), { recursive: true });
      await fs.writeFile(opts.cacheFile, JSON.stringify(nextCache));
    } catch (e) {
      warnings.push(`index cache not written: ${(e as Error).message}`);
    }
  }
  log(`index: ${models.length} models (${reused} cached), ${backgrounds.length} backgrounds, ${audio.length} audio in ${Date.now() - t0} ms`);
  const out: Catalog = { version, generatedAt: Date.now(), models, backgrounds, audio, characters, bands, warnings, ...(labels ? { labelRules: labels.rules } : {}) };
  MODEL_PARTS.set(out, { models, modelSigs, modelWarnings });
  return out;
}

export type CatalogStatus = { state: 'indexing' } | { state: 'ready'; ms: number } | { state: 'error'; error: string };

/** Holds the current catalog; indexing starts immediately and requests await it. */
export class CatalogService {
  status: CatalogStatus = { state: 'indexing' };
  private current: Promise<Catalog>;

  constructor(private readonly opts: IndexerOptions) {
    this.current = this.run();
  }

  private run(reuse?: ModelPart): Promise<Catalog> {
    const t0 = Date.now();
    this.status = { state: 'indexing' };
    const p = buildCatalog(reuse ? { ...this.opts, reuse } : this.opts).then(
      (c) => {
        this.status = { state: 'ready', ms: Date.now() - t0 };
        return c;
      },
      (e: unknown) => {
        this.status = { state: 'error', error: (e as Error).message };
        throw e;
      },
    );
    p.catch(() => {});
    return p;
  }

  get(): Promise<Catalog> {
    return this.current;
  }

  /** Re-index; other requests keep getting the previous catalog until the new one is ready. */
  refresh(): Promise<Catalog> {
    return this.rebuild();
  }

  /** The labels file changed: redo only the backgrounds part (models are reused). */
  async relabel(): Promise<Catalog> {
    const part = MODEL_PARTS.get(await this.current);
    return this.rebuild(part);
  }

  private rebuild(reuse?: ModelPart): Promise<Catalog> {
    const next = this.run(reuse);
    next.then((c) => { this.current = Promise.resolve(c); }, () => {});
    return next;
  }
}
