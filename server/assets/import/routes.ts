import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import express, { Router } from 'express';
import { z } from 'zod';
import { updateFileConfig, type StudioConfig } from '../../config';
import { userBgId, uploadBgName, isUserBg } from '../../../shared/catalog/uploadBg';
import { readPngSize, type CatalogService } from '../indexer';
import { applyPlan, type ImportReport } from './apply';
import { buildPlan, sha256File, type ImportPlan, type PlanOptions, type PreparedPlan } from './plan';
import { ProjectStore } from '../../projects/store';
import { backgroundUsage } from '../../projects/usage';
import { ZipSafetyError, extractZip, type ZipLimits } from './zip';

interface Session {
  id: string;
  source: string;
  srcRoot: string;
  /** temp dir to delete when done (extracted zip), if any */
  temp: string | null;
  packageName: string;
  at: number;
}

/** A background job (scan / plan / run). The browser polls it for progress and may cancel. */
interface Job {
  id: string;
  kind: 'scan' | 'plan' | 'run';
  status: 'running' | 'done' | 'error' | 'cancelled';
  phase: string;
  done: number;
  total: number;
  bytes: number;
  error?: string;
  plan?: ImportPlan;
  result?: { report: ImportReport; unlabelledBackgrounds: string[] };
  abort: AbortController;
  at: number;
}

async function isWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.write-test-${randomUUID().slice(0, 6)}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, 'x');
    await fs.rm(probe);
    return true;
  } catch {
    return false;
  }
}

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export interface ImportDeps {
  config: StudioConfig;
  catalog: CatalogService;
  /** ids with a label, and (optionally) the cached card-background names. */
  labelled: () => Promise<ReadonlySet<string>>;
  cardNames: () => Promise<ReadonlyMap<string, string>>;
}

export function importRoutes(deps: ImportDeps): Router {
  const { config } = deps;
  const r = Router();
  const sessions = new Map<string, Session>();
  const jobs = new Map<string, Job>();
  let running = false;
  const tmpRoot = () => path.join(config.dataDir, 'import-tmp');
  const limits = (): ZipLimits => ({ maxBytes: config.importMaxBytes, maxEntries: 50_000, maxPathLength: 240 });

  const dropSession = async (s: Session) => {
    sessions.delete(s.id);
    if (s.temp) await fs.rm(s.temp, { recursive: true, force: true }).catch(() => {});
  };
  const sweep = async () => {
    for (const s of [...sessions.values()]) if (Date.now() - s.at > SESSION_TTL_MS) await dropSession(s);
    for (const j of [...jobs.values()]) if (j.status !== 'running' && Date.now() - j.at > SESSION_TTL_MS) jobs.delete(j.id);
  };

  const planOptions = async (job: Job, ids?: Record<string, string>, packageName?: string): Promise<PlanOptions> => ({
    assetRoot: config.assetRoot,
    labelled: await deps.labelled(),
    cardNames: await deps.cardNames(),
    ...(ids ? { ids } : {}),
    ...(packageName ? { packageName } : {}),
    signal: job.abort.signal,
    onProgress: (p) => {
      job.phase = p.phase;
      job.done = p.done;
      job.total = p.total;
    },
  });

  const startJob = (kind: Job['kind'], work: (job: Job) => Promise<void>, onFail?: () => Promise<void>): Job => {
    const job: Job = { id: randomUUID(), kind, status: 'running', phase: '准备', done: 0, total: 0, bytes: 0, abort: new AbortController(), at: Date.now() };
    jobs.set(job.id, job);
    void work(job).then(
      () => {
        job.status = job.abort.signal.aborted ? 'cancelled' : 'done';
        job.at = Date.now();
      },
      async (e: unknown) => {
        job.status = job.abort.signal.aborted ? 'cancelled' : 'error';
        job.error = (e as Error).message;
        job.at = Date.now();
        await onFail?.();
      },
    );
    return job;
  };

  const replan = async (job: Job, s: Session, ids?: Record<string, string>): Promise<PreparedPlan> => {
    job.phase = '分析';
    const prepared = await buildPlan(s.srcRoot, s.id, s.source, await planOptions(job, ids, s.packageName));
    s.at = Date.now();
    job.plan = prepared.plan;
    return prepared;
  };

  r.get('/api/import/target', async (_req, res) => {
    res.json({ assetRoot: config.assetRoot, writable: await isWritable(config.assetRoot), fromEnv: Boolean(process.env.ASSET_ROOT?.trim()), maxBytes: config.importMaxBytes });
  });

  // choose another library folder: validated here, saved to studio.config.json, applied after a restart
  r.put('/api/import/target', express.json(), async (req, res) => {
    const p = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      res.status(400).json({ error: '请填写绝对路径' });
      return;
    }
    if (!(await isWritable(p))) {
      res.status(400).json({ error: '该目录无法创建或不可写' });
      return;
    }
    updateFileConfig(config.configFile, { assetRoot: p });
    res.json({ saved: true, restartRequired: true, envOverride: Boolean(process.env.ASSET_ROOT?.trim()) });
  });

  /** Extract (when a zip) and plan, as a job. */
  const scanJob = (source: string, make: (job: Job) => Promise<{ srcRoot: string; temp: string | null }>, packageName: string): Job => {
    let temp: string | null = null;
    return startJob(
      'scan',
      async (job) => {
        const made = await make(job);
        temp = made.temp;
        const s: Session = { id: job.id, source, srcRoot: made.srcRoot, temp: made.temp, packageName, at: Date.now() };
        sessions.set(job.id, s);
        await replan(job, s);
      },
      async () => {
        if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
        sessions.delete(temp ? path.basename(temp) : '');
      },
    );
  };

  const extractInto = (zipFile: string, temp: string, job: Job) => {
    job.phase = '解压';
    return extractZip(zipFile, temp, limits(), {
      signal: job.abort.signal,
      onProgress: (p) => {
        job.done = p.files;
        job.total = p.total;
        job.bytes = p.bytes;
      },
    });
  };

  r.post('/api/import/scan', express.json(), async (req, res) => {
    await sweep();
    const p = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      res.status(400).json({ error: '请填写文件夹或 .zip 文件的绝对路径' });
      return;
    }
    const st = await fs.stat(p).catch(() => null);
    if (!st) {
      res.status(400).json({ error: `找不到：${p}` });
      return;
    }
    const zipLike = st.isFile() && /\.zip$/i.test(p);
    if (st.isFile() && !zipLike) {
      res.status(400).json({ error: '请选择文件夹或 .zip 文件' });
      return;
    }
    const name = path.basename(p).replace(/\.zip$/i, '');
    const job = scanJob(
      p,
      async (j) => {
        if (!zipLike) return { srcRoot: p, temp: null };
        const temp = path.join(tmpRoot(), j.id);
        await extractInto(p, temp, j);
        return { srcRoot: temp, temp };
      },
      name,
    );
    res.json({ jobId: job.id });
  });

  // browser upload of a .zip (raw body streamed to disk; size-capped), then extracted + planned as a job
  r.post('/api/import/upload', async (req, res) => {
    await sweep();
    const id = randomUUID();
    const temp = path.join(tmpRoot(), id);
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'upload.zip')).replace(/\.zip$/i, '');
    try {
      await fs.mkdir(temp, { recursive: true });
      const zipFile = path.join(temp, 'upload.zip');
      let total = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          total += chunk.length;
          cb(total > config.importMaxBytes ? new ZipSafetyError(`上传超过大小上限 ${Math.round(config.importMaxBytes / 1024 ** 2)} MB`) : null, chunk);
        },
      });
      await pipeline(req, cap, createWriteStream(zipFile));
    } catch (e) {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
      res.status(e instanceof ZipSafetyError ? 400 : 500).json({ error: (e as Error).message });
      return;
    }
    const job = scanJob(
      `上传：${name}.zip`,
      async (j) => {
        const dest = path.join(temp, 'x');
        await extractInto(path.join(temp, 'upload.zip'), dest, j);
        await fs.rm(path.join(temp, 'upload.zip'), { force: true });
        return { srcRoot: dest, temp };
      },
      name,
    );
    res.json({ jobId: job.id });
  });

  // one picture from the browser (already re-encoded to PNG): planned and written through the normal import pipeline under a content-derived id
  r.post('/api/import/background', async (req, res) => {
    if (running) {
      res.status(409).json({ error: '已有导入正在进行，请稍后再试' });
      return;
    }
    running = true;
    const uuid = randomUUID();
    const temp = path.join(tmpRoot(), uuid);
    try {
      const cap0 = Math.min(config.importMaxBytes, 40 * 1024 ** 2);
      const srcRoot = path.join(temp, 'x');
      await fs.mkdir(srcRoot, { recursive: true });
      const file = path.join(srcRoot, 'upload.png');
      let total = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _e, cb) {
          total += chunk.length;
          cb(total > cap0 ? new ZipSafetyError(`图片超过大小上限 ${Math.round(cap0 / 1024 ** 2)} MB`) : null, chunk);
        },
      });
      try {
        await pipeline(req, cap, createWriteStream(file));
      } catch (e) {
        res.status(e instanceof ZipSafetyError ? 400 : 500).json({ error: (e as Error).message });
        return;
      }
      const size = await readPngSize(file);
      if (size.width === null || size.height === null) {
        res.status(400).json({ error: '不是有效的 PNG 图片' });
        return;
      }
      let filename = '';
      try {
        filename = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      } catch {
        /* keep empty */
      }
      const id = userBgId(await sha256File(file));
      const prepared = await buildPlan(srcRoot, uuid, '上传背景', { assetRoot: config.assetRoot, ids: { 'upload.png': id } });
      const pb = prepared.plan.backgrounds[0];
      if (!pb || (pb.status !== 'new' && pb.status !== 'duplicate')) {
        res.status(400).json({ error: pb?.message ?? '无法导入这张图片' });
        return;
      }
      if (pb.status === 'new') {
        const report = await applyPlan(prepared, config.assetRoot, { overwrite: false });
        if (report.errors.length > 0) {
          res.status(500).json({ error: report.errors[0]!.message });
          return;
        }
      }
      const name = uploadBgName(filename);
      const metaFile = path.join(config.assetRoot, 'backgrounds', `${id}.meta.json`);
      if (!(await fs.stat(metaFile).catch(() => null))) {
        await fs.writeFile(metaFile, JSON.stringify({ name, originalName: filename, uploadedAt: new Date().toISOString() }, null, 2));
      }
      await deps.catalog.refresh().catch(() => {});
      const meta = JSON.parse(await fs.readFile(metaFile, 'utf8').catch(() => '{}')) as { name?: unknown };
      res.json({ id, status: pb.status, name: typeof meta.name === 'string' ? meta.name : name, width: size.width, height: size.height });
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    } finally {
      running = false;
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  });

  // which saved projects still show this background (start background or a background-track key)
  r.get('/api/import/background/:id/usage', async (req, res) => {
    const id = req.params.id;
    if (!isUserBg(id)) {
      res.status(400).json({ error: '只能查询自己上传的背景' });
      return;
    }
    res.json({ projects: backgroundUsage(await new ProjectStore(path.join(config.dataDir, 'projects')).all(), id) });
  });

  r.delete('/api/import/background/:id', async (req, res) => {
    const id = req.params.id;
    if (!isUserBg(id)) {
      res.status(400).json({ error: '只能删除自己上传的背景' });
      return;
    }
    if (running) {
      res.status(409).json({ error: '已有导入正在进行，请稍后再试' });
      return;
    }
    const dir = path.join(config.assetRoot, 'backgrounds');
    if (!(await fs.stat(path.join(dir, `${id}.png`)).catch(() => null))) {
      res.status(404).json({ error: '找不到这张背景' });
      return;
    }
    await fs.rm(path.join(dir, `${id}.png`), { force: true });
    await fs.rm(path.join(dir, `${id}.meta.json`), { force: true });
    await deps.catalog.refresh().catch(() => {});
    res.json({ ok: true });
  });

  const Body = z.object({ planId: z.string(), ids: z.record(z.string(), z.string()).optional(), overwrite: z.boolean().optional() });

  r.post('/api/import/plan', express.json(), (req, res) => {
    const b = Body.safeParse(req.body);
    const s = b.success ? sessions.get(b.data.planId) : undefined;
    if (!b.success || !s) {
      res.status(404).json({ error: '导入会话已过期，请重新选择' });
      return;
    }
    const ids = b.data.ids;
    res.json({ jobId: startJob('plan', async (job) => void (await replan(job, s, ids))).id });
  });

  r.post('/api/import/run', express.json(), (req, res) => {
    const b = Body.safeParse(req.body);
    const s = b.success ? sessions.get(b.data.planId) : undefined;
    if (!b.success || !s) {
      res.status(404).json({ error: '导入会话已过期，请重新选择' });
      return;
    }
    if (running) {
      res.status(409).json({ error: '已有导入正在进行' });
      return;
    }
    running = true;
    const { ids, overwrite } = b.data;
    const job = startJob('run', async (j) => {
      try {
        const prepared = await replan(j, s, ids);
        const problems = prepared.plan.pack?.problems ?? [];
        if (problems.length > 0) throw new Error(`素材包描述文件校验未通过（${problems.length} 项），已拒绝导入：${problems[0]}`);
        j.phase = '写入';
        const report = await applyPlan(prepared, config.assetRoot, {
          overwrite: overwrite === true,
          signal: j.abort.signal,
          onProgress: (p) => {
            j.phase = p.phase;
            j.done = p.done;
            j.total = p.total;
          },
        });
        await deps.catalog.refresh().catch(() => {});
        const labelled = await deps.labelled();
        j.result = { report, unlabelledBackgrounds: report.imported.backgrounds.filter((id) => !labelled.has(id)) };
        await dropSession(s);
      } finally {
        running = false;
      }
    });
    res.json({ jobId: job.id });
  });

  r.get('/api/import/jobs/:id', (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) {
      res.status(404).json({ error: '任务不存在或已过期' });
      return;
    }
    res.json({ id: j.id, kind: j.kind, status: j.status, phase: j.phase, done: j.done, total: j.total, bytes: j.bytes, error: j.error, plan: j.status === 'done' ? j.plan : undefined, result: j.result });
  });

  // cancel: stops extraction / hashing / writing at the next file; a cancelled scan removes its temp files
  r.delete('/api/import/jobs/:id', async (req, res) => {
    const j = jobs.get(req.params.id);
    j?.abort.abort();
    const s = sessions.get(req.params.id);
    if (s && j?.kind === 'scan') await dropSession(s);
    res.json({ ok: true });
  });

  r.delete('/api/import/:planId', async (req, res) => {
    const s = sessions.get(req.params.planId);
    if (s) await dropSession(s);
    res.json({ ok: true });
  });

  return r;
}
