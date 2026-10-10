import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PACK_FILE, PackSchema } from '../../../shared/schema/pack';
import { resolveInside } from '../../util/safePath';
import { readPngSize } from '../indexer';
import { checkMoc3Header, normalizeModel3, refBasename } from './normalizeModel3';

export type ItemStatus = 'new' | 'duplicate' | 'conflict' | 'error' | 'unrecognized';

export interface PlanModel {
  id: string;
  /** model3.json path inside the package. */
  src: string;
  status: ItemStatus;
  idGuessed: boolean;
  files: number;
  bytes: number;
  motions: number;
  expressions: number;
  textures: number;
  /** Rewritten from site-style (absolute textures / single motion group) to the local layout. */
  normalized: boolean;
  mocVersion: number | null;
  sha256: string;
  warnings: string[];
  errors: string[];
}

export interface PlanBackground {
  id: string;
  src: string;
  status: ItemStatus;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  /** Whether asset-labels/backgrounds.json has a label for this id. */
  labelled: boolean;
  message?: string;
}

export interface PlanMedia { files: number; bytes: number; new: number; duplicate: number; conflict: number }
export interface PlanPack { generatedAt: string; counts: { models: number; backgrounds: number; media: number }; totalBytes: number; listed: number; verified: number; problems: string[] }

export interface ImportPlan {
  planId: string;
  source: string;
  models: PlanModel[];
  backgrounds: PlanBackground[];
  media: PlanMedia | null;
  manifest: 'new' | 'duplicate' | 'conflict' | null;
  pack: PlanPack | null;
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; message: string }>;
  warnings: string[];
  fileCount: number;
  totalBytes: number;
}

/** What the writer needs; never sent to the browser. */
export interface PreparedModel { id: string; model3: string; files: Array<{ src: string; dest: string; sha256: string }> }
export interface PreparedPlan {
  plan: ImportPlan;
  srcRoot: string;
  /** keyed by the model3.json path inside the package */
  models: Map<string, PreparedModel>;
  /** background id -> package path */
  backgrounds: Map<string, string>;
  /** media files (path under media/) and the optional manifest.json, with their status */
  media: Array<{ src: string; dest: string; bytes: number; status: ItemStatus }>;
  manifest: { src: string; status: ItemStatus } | null;
}

export interface PlanOptions {
  /** Existing library to compare against (duplicate / conflict detection). */
  assetRoot: string;
  /** Known background ids that have a label. */
  labelled?: ReadonlySet<string>;
  /** `bg_*` file stem -> numeric card-background id (from the cached site index, optional). */
  cardNames?: ReadonlyMap<string, string>;
  /** Manual id overrides keyed by package path. */
  ids?: Readonly<Record<string, string>>;
  /** Name used for ids derived from the package itself. */
  packageName?: string;
  onProgress?: (p: { phase: string; done: number; total: number }) => void;
  signal?: AbortSignal;
}

const MODEL_ID = /^(?:\d{3}|sub)_[a-z0-9][a-z0-9_-]*$/i;
const GENERIC_DIRS = new Set(['', '.', 'model', 'models', 'live2d', 'data', 'output', 'runtime', 'assets', 'export']);
const STAGE_BG = /^adv_bkg_stage_\d{6}$/;
const NUMERIC_BG = /^\d{1,4}$/;
const MAX_FILES = 300_000;

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

const sanitizeId = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');

interface PkgFile { rel: string; abs: string; size: number }

async function walk(root: string, skipped: ImportPlan['skipped']): Promise<PkgFile[]> {
  const out: PkgFile[] = [];
  const rec = async (dirAbs: string, dirRel: string): Promise<void> => {
    for (const d of await fs.readdir(dirAbs, { withFileTypes: true })) {
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) skipped.push({ path: rel, reason: '符号链接，已跳过' });
      else if (d.isDirectory()) await rec(path.join(dirAbs, d.name), rel);
      else if (d.isFile()) {
        if (out.length >= MAX_FILES) throw new Error(`文件数超过上限 ${MAX_FILES}`);
        out.push({ rel, abs: path.join(dirAbs, d.name), size: (await fs.stat(path.join(dirAbs, d.name))).size });
      }
    }
  };
  await rec(root, '');
  return out;
}

const lc = (s: string) => s.toLowerCase();
const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const commonPrefix = (a: string, b: string) => {
  const x = a.split('/');
  const y = b.split('/');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i;
};

function deriveModelId(rel: string, packageName: string): { id: string; guessed: boolean } {
  const parts = rel.split('/');
  const file = parts.pop()!;
  const stem = file.replace(/(^|\.)model3\.json$/i, '');
  const candidates = [parts[parts.length - 1] ?? '', stem, ...parts.slice(0, -1).reverse(), packageName];
  for (const c of candidates) if (MODEL_ID.test(c)) return { id: c, guessed: false };
  const dir = parts[parts.length - 1] ?? '';
  const pick = !GENERIC_DIRS.has(lc(dir)) ? dir : stem !== 'model3' && !GENERIC_DIRS.has(lc(stem)) ? stem : packageName || stem;
  return { id: sanitizeId(pick) || 'model', guessed: true };
}

async function readHead(file: string, n: number): Promise<Buffer> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Canonical form for comparing model3.json regardless of formatting. */
const canonJson = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
};

async function fileHashOrNull(file: string): Promise<string | null> {
  try {
    return await sha256File(file);
  } catch {
    return null;
  }
}

export async function buildPlan(srcRoot: string, planId: string, source: string, opts: PlanOptions): Promise<PreparedPlan> {
  const skipped: ImportPlan['skipped'] = [];
  const errors: ImportPlan['errors'] = [];
  const warnings: string[] = [];
  const all = await walk(srcRoot, skipped);
  const byLowerRel = new Map(all.map((f) => [lc(f.rel), f]));
  const byBase = new Map<string, PkgFile[]>();
  for (const f of all) {
    const k = lc(path.posix.basename(f.rel));
    byBase.set(k, [...(byBase.get(k) ?? []), f]);
  }
  const pkgName = sanitizeId(opts.packageName ?? path.basename(srcRoot));
  const hashed = new Map<string, string>();
  let hashDone = 0;
  const H = async (f: PkgFile): Promise<string> => {
    if (opts.signal?.aborted) throw new Error('已取消');
    let h = hashed.get(f.rel);
    if (!h) {
      h = await sha256File(f.abs);
      hashed.set(f.rel, h);
      opts.onProgress?.({ phase: '校验', done: ++hashDone, total: all.length });
    }
    return h;
  };
  // native pack layout: models/ backgrounds/ media/ at the root, or inside one wrapper directory
  const tops = new Set(all.map((f) => f.rel.split('/')[0]));
  const prefix = tops.size === 1 && all.every((f) => f.rel.includes('/')) ? `${[...tops][0]}/` : '';
  const mediaPrefix = `${prefix}media/`;

  const resolver = (modelRel: string) => (ref: string): string | null => {
    const variants = new Set<string>();
    let r = ref.replace(/\\/g, '/').replace(/^[a-z]+:\/\/[^/]+/i, '');
    r = r.split(/[?#]/)[0]!;
    variants.add(r);
    try {
      variants.add(decodeURIComponent(r));
    } catch {
      /* keep raw */
    }
    const dir = dirOf(modelRel);
    for (const v of variants) {
      if (v.startsWith('/')) continue;
      const rel = path.posix.normalize(dir ? `${dir}/${v}` : v);
      if (!rel.startsWith('..') && byLowerRel.has(lc(rel))) return byLowerRel.get(lc(rel))!.rel;
    }
    // fall back to the base name anywhere in the package, preferring the closest directory
    for (const v of variants) {
      const hits = byBase.get(lc(refBasename(v)));
      if (hits?.length) return [...hits].sort((a, b) => commonPrefix(dirOf(b.rel), dir) - commonPrefix(dirOf(a.rel), dir))[0]!.rel;
    }
    return null;
  };

  const models = new Map<string, PreparedModel>();
  const planModels: PlanModel[] = [];
  const claimed = new Set<string>(); // package files used by a model (never treated as backgrounds)
  const modelDirs: string[] = [];

  for (const f of all.filter((x) => /(^|[./])model3\.json$/i.test(x.rel))) {
    const dir = dirOf(f.rel);
    const override = opts.ids?.[f.rel];
    const derived = override ? { id: sanitizeId(override), guessed: false } : deriveModelId(f.rel, pkgName);
    const pm: PlanModel = {
      id: derived.id, src: f.rel, status: 'new', idGuessed: derived.guessed, files: 0, bytes: 0, motions: 0, expressions: 0,
      textures: 0, normalized: false, mocVersion: null, sha256: '', warnings: [], errors: [],
    };
    planModels.push(pm);
    modelDirs.push(dir);
    let raw: unknown;
    try {
      raw = JSON.parse((await fs.readFile(f.abs, 'utf8')).replace(/^\uFEFF/, ''));
    } catch (e) {
      pm.errors.push(`model3.json 解析失败：${(e as Error).message}`);
      pm.status = 'error';
      continue;
    }
    const norm = normalizeModel3(raw, resolver(f.rel));
    pm.errors.push(...norm.errors);
    pm.warnings.push(...norm.warnings);
    if (derived.guessed) pm.warnings.push(`无法从目录名识别模型 id，暂用「${derived.id}」；角色/服装识别可能不准，可在表格中手动改 id`);
    if (norm.errors.length > 0 || !norm.json) {
      pm.status = 'error';
      continue;
    }
    pm.normalized = norm.changed;
    pm.motions = norm.counts.motions;
    pm.expressions = norm.counts.expressions;
    pm.textures = norm.counts.textures;
    const mocSrc = norm.files.find((x) => x.dest === 'model.moc3');
    if (mocSrc) {
      const head = checkMoc3Header(await readHead(byLowerRel.get(lc(mocSrc.src))!.abs, 8));
      if (!head.ok) {
        pm.errors.push(head.message!);
        pm.status = 'error';
        continue;
      }
      pm.mocVersion = head.version;
    }
    const files: PreparedModel['files'] = [];
    for (const x of norm.files) {
      const pf = byLowerRel.get(lc(x.src))!;
      claimed.add(pf.rel);
      files.push({ src: pf.rel, dest: x.dest, sha256: await H(pf) });
      pm.bytes += pf.size;
    }
    const preview = byLowerRel.get(lc(dir ? `${dir}/preview.png` : 'preview.png'));
    if (preview) {
      claimed.add(preview.rel);
      files.push({ src: preview.rel, dest: 'preview.png', sha256: await H(preview) });
      pm.bytes += preview.size;
    }
    const model3 = JSON.stringify(norm.json, null, 2);
    pm.files = files.length + 1;
    pm.bytes += Buffer.byteLength(model3);
    pm.sha256 = createHash('sha256')
      .update([`model3.json\0${createHash('sha256').update(canonJson(model3)).digest('hex')}`, ...files.map((x) => `${x.dest}\0${x.sha256}`).sort()].join('\n'))
      .digest('hex');
    models.set(f.rel, { id: pm.id, model3, files });
  }

  // id uniqueness inside the package, then comparison with the library
  const seenIds = new Map<string, PlanModel>();
  for (const pm of planModels) {
    if (pm.status === 'error') continue;
    const prev = seenIds.get(pm.id);
    if (prev) {
      pm.errors.push(`包内有另一个模型也叫「${pm.id}」（${prev.src}），本项已跳过；可手动改 id`);
      pm.status = 'error';
      models.delete(pm.src);
      continue;
    }
    seenIds.set(pm.id, pm);
    const existingDir = path.join(opts.assetRoot, 'models', pm.id);
    if (!(await fs.stat(existingDir).catch(() => null))) continue;
    const prepared = models.get(pm.src)!;
    let identical = true;
    const old = await fs.readFile(path.join(existingDir, 'model3.json'), 'utf8').catch(() => null);
    if (old === null || canonJson(old) !== canonJson(prepared.model3)) identical = false;
    for (const f of prepared.files) {
      if (!identical) break;
      if ((await fileHashOrNull(path.join(existingDir, f.dest))) !== f.sha256) identical = false;
    }
    pm.status = identical ? 'duplicate' : 'conflict';
  }

  // backgrounds: PNGs that no model uses
  const bgs: PlanBackground[] = [];
  const bgPaths = new Map<string, string>();
  const modelIds = new Set(planModels.map((m) => m.id));
  for (const f of all) {
    if (!/\.png$/i.test(f.rel) || claimed.has(f.rel) || f.rel.startsWith(mediaPrefix)) continue;
    const dir = dirOf(f.rel);
    if (modelDirs.some((d) => d !== '' && (dir === d || dir.startsWith(`${d}/`)))) continue; // a model's own files
    const stem = path.posix.basename(f.rel).replace(/\.png$/i, '');
    if (modelIds.has(stem)) continue; // site preview image of a model
    let id: string | null = opts.ids?.[f.rel] ? sanitizeId(opts.ids[f.rel]!) : null;
    id ??= STAGE_BG.test(stem) || NUMERIC_BG.test(stem) ? stem : (opts.cardNames?.get(stem) ?? null);
    const pb: PlanBackground = { id: id ?? '', src: f.rel, status: 'new', bytes: f.size, sha256: '', width: null, height: null, labelled: false };
    const size = await readPngSize(f.abs);
    if (size.width === null) {
      pb.status = 'error';
      pb.message = '不是有效的 PNG 文件';
    } else if (!id) {
      pb.status = 'unrecognized';
      pb.message = '无法识别背景 id（应为 adv_bkg_stage_NNNNNN 或数字）；在此填写 id 后可导入';
    }
    pb.width = size.width;
    pb.height = size.height;
    if (pb.status === 'new') {
      pb.sha256 = await H(f);
      pb.labelled = opts.labelled?.has(id!) ?? false;
      if (bgPaths.has(id!)) {
        pb.status = 'error';
        pb.message = `包内已有另一张背景使用 id「${id}」（${bgPaths.get(id!)}）`;
      } else {
        bgPaths.set(id!, f.rel);
        const oldHash = await fileHashOrNull(path.join(opts.assetRoot, 'backgrounds', `${id}.png`));
        if (oldHash !== null) pb.status = oldHash === pb.sha256 ? 'duplicate' : 'conflict';
      }
    }
    bgs.push(pb);
  }

  // media/ and manifest.json (native layout); never touched when absent
  const mediaItems: PreparedPlan['media'] = [];
  for (const f of all.filter((x) => x.rel.startsWith(mediaPrefix))) {
    const dest = f.rel.slice(mediaPrefix.length);
    if (!resolveInside(path.join(opts.assetRoot, 'media'), dest)) {
      skipped.push({ path: f.rel, reason: '路径不安全' });
      continue;
    }
    const old = await fs.stat(path.join(opts.assetRoot, 'media', dest)).catch(() => null);
    let status: ItemStatus = 'new';
    if (old) status = old.size === f.size && (await fileHashOrNull(path.join(opts.assetRoot, 'media', dest))) === (await H(f)) ? 'duplicate' : 'conflict';
    mediaItems.push({ src: f.rel, dest, bytes: f.size, status });
  }
  const mf = byLowerRel.get(`${prefix}manifest.json`);
  let manifest: PreparedPlan['manifest'] = null;
  if (mf) {
    const old = await fileHashOrNull(path.join(opts.assetRoot, 'manifest.json'));
    manifest = { src: mf.rel, status: old === null ? 'new' : old === (await H(mf)) ? 'duplicate' : 'conflict' };
  }
  const media: PlanMedia | null = mediaItems.length
    ? { files: mediaItems.length, bytes: mediaItems.reduce((n, m) => n + m.bytes, 0), new: mediaItems.filter((m) => m.status === 'new').length, duplicate: mediaItems.filter((m) => m.status === 'duplicate').length, conflict: mediaItems.filter((m) => m.status === 'conflict').length }
    : null;

  // optional openotes-pack.json: validated when present
  let pack: PlanPack | null = null;
  const packFile = byLowerRel.get(`${prefix}${PACK_FILE}`);
  if (packFile) {
    const problems: string[] = [];
    const parsed = PackSchema.safeParse(await fs.readFile(packFile.abs, 'utf8').then((t) => JSON.parse(t.replace(/^\uFEFF/, '')) as unknown, () => null));
    if (!parsed.success) problems.push(`${PACK_FILE} 格式不正确：${parsed.error.issues[0]?.message ?? '无法解析'}`);
    else {
      const d = parsed.data;
      const okModels = planModels.filter((m) => m.status !== 'error').length;
      if (okModels !== d.counts.models) problems.push(`模型数量与描述不符：描述 ${d.counts.models}，实际可用 ${okModels}`);
      if (bgs.length !== d.counts.backgrounds) problems.push(`背景数量与描述不符：描述 ${d.counts.backgrounds}，实际 ${bgs.length}`);
      if (mediaItems.length !== d.counts.media) problems.push(`媒体文件数量与描述不符：描述 ${d.counts.media}，实际 ${mediaItems.length}`);
      let verified = 0;
      for (const e of d.files ?? []) {
        if (e.path.includes('..') || e.path.startsWith('/')) {
          problems.push(`清单含不安全路径：${e.path}`);
          continue;
        }
        const f = byLowerRel.get(lc(`${prefix}${e.path}`));
        if (!f) problems.push(`缺少文件：${e.path}`);
        else if (f.size !== e.bytes) problems.push(`大小不符：${e.path}`);
        else if ((await H(f)) !== e.sha256) problems.push(`SHA-256 不符（文件已损坏或被改动）：${e.path}`);
        else verified++;
      }
      pack = { generatedAt: d.generatedAt, counts: d.counts, totalBytes: d.totalBytes, listed: d.files?.length ?? 0, verified, problems };
    }
    pack ??= { generatedAt: '', counts: { models: 0, backgrounds: 0, media: 0 }, totalBytes: 0, listed: 0, verified: 0, problems };
    for (const pr of pack.problems.slice(0, 50)) errors.push({ path: PACK_FILE, message: pr });
  }

  const importable = (s: ItemStatus) => s === 'new' || s === 'conflict';
  const fileCount = planModels.filter((m) => importable(m.status)).reduce((n, m) => n + m.files, 0) + bgs.filter((b) => importable(b.status)).length + mediaItems.filter((m) => importable(m.status)).length + (manifest && importable(manifest.status) ? 1 : 0);
  const totalBytes = planModels.filter((m) => importable(m.status)).reduce((n, m) => n + m.bytes, 0) + bgs.filter((b) => importable(b.status)).reduce((n, b) => n + b.bytes, 0) + mediaItems.filter((m) => importable(m.status)).reduce((n, m) => n + m.bytes, 0);
  if (planModels.length === 0 && bgs.length === 0 && mediaItems.length === 0) warnings.push('没有找到 *.model3.json 或可识别的 PNG 背景：请确认选择的是素材所在的文件夹/zip');
  for (const m of planModels) if (m.status === 'error') errors.push({ path: m.src, message: m.errors.join('；') });
  for (const b of bgs) {
    if (b.status === 'error') errors.push({ path: b.src, message: b.message ?? '' });
    if (b.status === 'unrecognized') skipped.push({ path: b.src, reason: b.message ?? '无法识别' });
  }
  return {
    plan: { planId, source, models: planModels, backgrounds: bgs, media, manifest: (manifest?.status as 'new' | 'duplicate' | 'conflict' | undefined) ?? null, pack, skipped, errors, warnings, fileCount, totalBytes },
    srcRoot,
    models,
    backgrounds: bgPaths,
    media: mediaItems,
    manifest,
  };
}
