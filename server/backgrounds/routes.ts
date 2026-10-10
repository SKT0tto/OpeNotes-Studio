import fs from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { BACKGROUND_ID_RE, GroundOverrideSchema } from '../../shared/schema/ground';
import type { StudioConfig } from '../config';

/** Per-background ground line overrides (horizon / floor), stored under data/backgrounds/. Never touches ASSET_ROOT. */
export function backgroundRoutes(config: StudioConfig): Router {
  const dir = path.join(config.dataDir, 'backgrounds');
  const fileFor = (id: string) => path.join(dir, `${id}.json`);
  const r = Router();

  r.get('/api/backgrounds/:id/ground', async (req, res) => {
    const id = req.params.id;
    if (!BACKGROUND_ID_RE.test(id)) return void res.status(400).json({ error: 'invalid background id' });
    try {
      res.json(JSON.parse(await fs.readFile(fileFor(id), 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return void res.json(null); // no override: use the setting-based default
      res.status(500).json({ error: `read failed: ${(e as Error).message}` });
    }
  });

  r.put('/api/backgrounds/:id/ground', express.json({ limit: '4kb' }), async (req, res) => {
    const id = req.params.id;
    if (!BACKGROUND_ID_RE.test(id)) return void res.status(400).json({ error: 'invalid background id' });
    const parsed = GroundOverrideSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.message });
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${fileFor(id)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(parsed.data, null, 2));
    await fs.rename(tmp, fileFor(id));
    res.json(parsed.data);
  });

  r.delete('/api/backgrounds/:id/ground', async (req, res) => {
    const id = req.params.id;
    if (!BACKGROUND_ID_RE.test(id)) return void res.status(400).json({ error: 'invalid background id' });
    await fs.rm(fileFor(id), { force: true });
    res.json(null);
  });

  return r;
}
