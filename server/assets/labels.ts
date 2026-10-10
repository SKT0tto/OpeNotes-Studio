import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import { BgLabelPatchSchema, BgLabelSchema, LabelFileSchema, LabelRulesSchema, emptyLabelFile, type BgLabel, type LabelFile } from '../../shared/schema/assetLabels';
import type { CatalogService } from './indexer';

export const DEFAULT_LABELS_FILE = path.resolve('asset-labels', 'backgrounds.json');

/** Reads the label file (missing = empty). Throws on invalid content so a broken file is never silently ignored. */
export async function readLabelFile(file: string): Promise<LabelFile> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyLabelFile();
    throw e;
  }
  return LabelFileSchema.parse(JSON.parse(raw));
}

/** Serialised, atomic read-modify-write of the label file. */
export class LabelStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}

  read(): Promise<LabelFile> {
    return readLabelFile(this.file);
  }

  /** Apply `fn` to the current file and persist the result (validated). */
  update(fn: (f: LabelFile) => void): Promise<LabelFile> {
    const run = async () => {
      const f = await this.read();
      fn(f);
      const out = LabelFileSchema.parse(f);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(out, null, 1) + '\n');
      // Windows refuses to replace a file another reader (the indexer) has open for a moment: retry briefly
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmp, this.file);
          break;
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 40) {
            await fs.rm(tmp, { force: true });
            throw e;
          }
          await new Promise((r) => setTimeout(r, 10 + attempt * 5));
        }
      }
      return out;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

const stamp = (l: BgLabel): BgLabel => ({ ...l, source: 'user', updatedAt: new Date().toISOString().slice(0, 10) });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

export function labelRoutes(store: LabelStore, catalog: CatalogService): Router {
  const r = Router();
  const json = express.json({ limit: '2mb' });
  const bad = (res: express.Response, msg: string) => void res.status(400).json({ error: msg });

  r.get('/api/asset-labels/backgrounds/stats', async (_req, res) => {
    try {
      const cat = await catalog.get();
      const stats = { total: cat.backgrounds.length, confidence: { confirmed: 0, likely: 0, unknown: 0, unlabelled: 0 }, unknown: 0, stage: 0, bands: {} as Record<string, number> };
      for (const b of cat.backgrounds) {
        const l = b.labels;
        if (!l) { stats.confidence.unlabelled++; continue; }
        stats.confidence[l.confidence]++;
        if (l.bands.length === 0) stats.unknown++;
        if (l.stage) stats.stage++;
        for (const k of l.bands) stats.bands[k] = (stats.bands[k] ?? 0) + 1;
      }
      res.json({ ...stats, rules: cat.labelRules });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Replace one label (or create it). */
  r.put('/api/asset-labels/backgrounds/:id', json, async (req, res) => {
    const p = BgLabelSchema.omit({ source: true, updatedAt: true }).safeParse(req.body);
    if (!p.success) return bad(res, issues(p.error));
    try {
      const id = String(req.params.id);
      await store.update((f) => { f.labels[id] = stamp({ ...p.data, source: 'user' }); });
      await catalog.relabel();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Merge `patch` into many labels: { ids, patch }. Unlabelled ids need a complete patch. */
  r.patch('/api/asset-labels/backgrounds', json, async (req, res) => {
    const p = z.object({ ids: z.array(z.string()).min(1).max(500), patch: BgLabelPatchSchema }).safeParse(req.body);
    if (!p.success) return bad(res, issues(p.error));
    try {
      await store.update((f) => {
        for (const id of p.data.ids) f.labels[id] = stamp(BgLabelSchema.parse({ ...(f.labels[id] ?? {}), ...p.data.patch }));
      });
      await catalog.relabel();
      res.json({ ok: true, count: p.data.ids.length });
    } catch (e) {
      if (e instanceof z.ZodError) return bad(res, issues(e));
      res.status(500).json({ error: (e as Error).message });
    }
  });

  r.put('/api/asset-labels/rules', json, async (req, res) => {
    const p = LabelRulesSchema.safeParse(req.body);
    if (!p.success) return bad(res, '规则无效');
    try {
      await store.update((f) => { f.rules = p.data; });
      await catalog.relabel();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  return r;
}
