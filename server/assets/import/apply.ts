import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImportPlan, PreparedPlan } from './plan';

export interface ImportReport {
  imported: { models: string[]; backgrounds: string[] };
  skipped: Array<{ id: string; kind: 'model' | 'background' | 'media'; reason: string }>;
  errors: Array<{ id: string; message: string }>;
  bytes: number;
  files: number;
  /** Counts for the summary line. */
  totals: { models: number; backgrounds: number; motions: number; expressions: number; media: number };
  manifest: boolean;
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i < 6 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) await new Promise((r) => setTimeout(r, 80 * (i + 1)));
      else throw e;
    }
  }
}

/** Replace `dest` with `staged` (an existing `dest` is moved aside first and removed on success). */
async function swapIn(staged: string, dest: string, trash: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const exists = await fs.stat(dest).then(() => true, () => false);
  if (exists) await retry(() => fs.rename(dest, path.join(trash, `${path.basename(dest)}-${randomUUID().slice(0, 6)}`)));
  await retry(() => fs.rename(staged, dest));
}

/**
 * Write the planned items under `assetRoot`: stage in `<assetRoot>/.import-tmp/<uuid>/`, then move each model
 * directory / background file into place. The user's original files are never modified.
 */
export async function applyPlan(prepared: PreparedPlan, assetRoot: string, opts: { overwrite: boolean; onProgress?: (p: { phase: string; done: number; total: number }) => void; signal?: AbortSignal }): Promise<ImportReport> {
  const plan: ImportPlan = prepared.plan;
  const report: ImportReport = { imported: { models: [], backgrounds: [] }, skipped: [], errors: [], bytes: 0, files: 0, totals: { models: 0, backgrounds: 0, motions: 0, expressions: 0, media: 0 }, manifest: false };
  const total = plan.models.length + plan.backgrounds.length + prepared.media.length;
  let done = 0;
  const tick = () => {
    if (opts.signal?.aborted) throw new Error('已取消');
    opts.onProgress?.({ phase: '写入', done: ++done, total });
  };
  const stage = path.join(assetRoot, '.import-tmp', randomUUID());
  await fs.mkdir(stage, { recursive: true });
  await fs.mkdir(path.join(assetRoot, 'models'), { recursive: true });
  await fs.mkdir(path.join(assetRoot, 'backgrounds'), { recursive: true });
  const trash = path.join(stage, '_old');
  await fs.mkdir(trash);

  try {
    for (const m of plan.models) {
      tick();
      if (m.status === 'duplicate') report.skipped.push({ id: m.id, kind: 'model', reason: '内容相同，已在素材库中' });
      else if (m.status === 'conflict' && !opts.overwrite) report.skipped.push({ id: m.id, kind: 'model', reason: 'id 已存在且内容不同；未选择覆盖，已跳过' });
      else if (m.status === 'error') report.skipped.push({ id: m.id, kind: 'model', reason: `有错误：${m.errors.join('；')}` });
      else {
        try {
          const pm = prepared.models.get(m.src)!;
          const dir = path.join(stage, 'models', m.id);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, 'model3.json'), pm.model3);
          for (const f of pm.files) {
            await fs.mkdir(path.dirname(path.join(dir, f.dest)), { recursive: true });
            await fs.copyFile(path.join(prepared.srcRoot, f.src), path.join(dir, f.dest));
          }
          await swapIn(dir, path.join(assetRoot, 'models', m.id), trash);
          report.imported.models.push(m.id);
          report.files += m.files;
          report.bytes += m.bytes;
          report.totals.motions += m.motions;
          report.totals.expressions += m.expressions;
        } catch (e) {
          report.errors.push({ id: m.id, message: (e as Error).message });
        }
      }
    }
    for (const b of plan.backgrounds) {
      tick();
      if (b.status === 'duplicate') report.skipped.push({ id: b.id, kind: 'background', reason: '内容相同，已在素材库中' });
      else if (b.status === 'conflict' && !opts.overwrite) report.skipped.push({ id: b.id, kind: 'background', reason: 'id 已存在且内容不同；未选择覆盖，已跳过' });
      else if (b.status === 'unrecognized') report.skipped.push({ id: b.src, kind: 'background', reason: b.message ?? '无法识别' });
      else if (b.status === 'error') report.skipped.push({ id: b.id || b.src, kind: 'background', reason: b.message ?? '有错误' });
      else {
        try {
          const tmp = path.join(stage, 'backgrounds', `${b.id}.png`);
          await fs.mkdir(path.dirname(tmp), { recursive: true });
          await fs.copyFile(path.join(prepared.srcRoot, b.src), tmp);
          await swapIn(tmp, path.join(assetRoot, 'backgrounds', `${b.id}.png`), trash);
          report.imported.backgrounds.push(b.id);
          report.files++;
          report.bytes += b.bytes;
        } catch (e) {
          report.errors.push({ id: b.id, message: (e as Error).message });
        }
      }
    }
    for (const m of prepared.media) {
      tick();
      if (m.status === 'duplicate') continue;
      if (m.status === 'conflict' && !opts.overwrite) {
        report.skipped.push({ id: m.dest, kind: 'media', reason: '已存在且内容不同；未选择覆盖，已跳过' });
        continue;
      }
      try {
        const dest = path.join(assetRoot, 'media', m.dest);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const tmp = path.join(stage, 'media', m.dest);
        await fs.mkdir(path.dirname(tmp), { recursive: true });
        await fs.copyFile(path.join(prepared.srcRoot, m.src), tmp);
        await swapIn(tmp, dest, trash);
        report.totals.media++;
        report.files++;
        report.bytes += m.bytes;
      } catch (e) {
        report.errors.push({ id: m.dest, message: (e as Error).message });
      }
    }
    const mf = prepared.manifest;
    if (mf && (mf.status === 'new' || (mf.status === 'conflict' && opts.overwrite))) {
      try {
        await fs.copyFile(path.join(prepared.srcRoot, mf.src), path.join(assetRoot, 'manifest.json'));
        report.manifest = true;
        report.files++;
      } catch (e) {
        report.errors.push({ id: 'manifest.json', message: (e as Error).message });
      }
    } else if (mf?.status === 'conflict') report.skipped.push({ id: 'manifest.json', kind: 'media', reason: '已存在且内容不同；未选择覆盖，已跳过' });
  } finally {
    await fs.rm(path.join(assetRoot, '.import-tmp', path.basename(stage)), { recursive: true, force: true }).catch(() => {});
    await fs.rmdir(path.join(assetRoot, '.import-tmp')).catch(() => {});
  }
  report.totals.models = report.imported.models.length;
  report.totals.backgrounds = report.imported.backgrounds.length;
  return report;
}
