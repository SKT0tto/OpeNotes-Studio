import fs from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { CalibrationSchema, MODEL_ID_RE } from '../../shared/schema/calibration';
import type { StudioConfig } from '../config';
import { readTextRetry, renameRetry } from '../util/fsRetry';

/** Per-model probe results (signs, head box), stored under data/calibration/. Never touches ASSET_ROOT. */
export function calibrationRoutes(config: StudioConfig): Router {
  const dir = path.join(config.dataDir, 'calibration');
  const fileFor = (id: string) => path.join(dir, `${id}.json`);
  const r = Router();

  r.get('/api/calibration/:modelId', async (req, res) => {
    const id = req.params.modelId;
    if (!MODEL_ID_RE.test(id)) return void res.status(400).json({ error: 'invalid model id' });
    try {
      res.json(JSON.parse(await readTextRetry(fileFor(id))));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return void res.json(null); // not calibrated yet (200 keeps the browser console clean)
      res.status(500).json({ error: `read failed: ${(e as Error).message}` });
    }
  });

  r.put('/api/calibration/:modelId', express.json({ limit: '64kb' }), async (req, res) => {
    const id = req.params.modelId;
    if (!MODEL_ID_RE.test(id)) return void res.status(400).json({ error: 'invalid model id' });
    const parsed = CalibrationSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.message });
    if (parsed.data.modelId !== id) return void res.status(400).json({ error: 'modelId mismatch' });
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${fileFor(id)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(parsed.data, null, 2));
    await renameRetry(tmp, fileFor(id));
    res.json(parsed.data);
  });

  return r;
}
