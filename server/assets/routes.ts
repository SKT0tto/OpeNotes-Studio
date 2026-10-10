import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Response } from 'express';
import { toCompactCatalog } from '../../shared/schema/assets';
import type { StudioConfig } from '../config';
import { resolveInside } from '../util/safePath';
import type { CatalogService } from './indexer';

const CACHE_CONTROL = 'public, max-age=3600';

/** Stream a file from a read-only root. Range requests are handled by `sendFile`. */
async function sendFromRoot(root: string, rel: string, res: Response): Promise<void> {
  const abs = resolveInside(root, rel);
  if (!abs) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isFile()) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.sendFile(abs, { dotfiles: 'allow', headers: { 'Cache-Control': CACHE_CONTROL } }, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: 'read failed' });
  });
}

/** Express 5 wildcard params arrive as string[] segments. */
function wildcardPath(param: unknown): string {
  return Array.isArray(param) ? param.join('/') : String(param ?? '');
}

export function assetRoutes(config: StudioConfig, catalog: CatalogService): Router {
  const r = Router();

  r.get('/api/catalog', async (_req, res) => {
    try {
      res.json(toCompactCatalog(await catalog.get()));
    } catch (e) {
      res.status(500).json({ error: `indexing failed: ${(e as Error).message}` });
    }
  });

  r.get('/api/catalog/models/:id', async (req, res) => {
    try {
      const model = (await catalog.get()).models.find((m) => m.id === req.params.id);
      if (!model) {
        res.status(404).json({ error: 'unknown model' });
        return;
      }
      res.json(model);
    } catch (e) {
      res.status(500).json({ error: `indexing failed: ${(e as Error).message}` });
    }
  });

  r.get('/assets/*splat', (req, res, next) => {
    sendFromRoot(config.assetRoot, wildcardPath((req.params as Record<string, unknown>).splat), res).catch(next);
  });

  r.get('/audio/:index/*splat', (req, res, next) => {
    const root = config.audioRoots[Number(req.params.index)];
    if (!root) {
      res.status(404).json({ error: 'unknown audio root' });
      return;
    }
    sendFromRoot(root, wildcardPath((req.params as Record<string, unknown>).splat), res).catch(next);
  });

  return r;
}

/** Cheap directory-level probe used by /api/health. */
export async function probeAssetRoot(assetRoot: string) {
  try {
    const [models, bgs] = await Promise.all([
      fs.readdir(path.join(assetRoot, 'models'), { withFileTypes: true }),
      fs.readdir(path.join(assetRoot, 'backgrounds')),
    ]);
    return {
      ok: true as const,
      path: assetRoot,
      models: models.filter((d) => d.isDirectory()).length,
      backgrounds: bgs.filter((f) => f.toLowerCase().endsWith('.png')).length,
    };
  } catch (e) {
    return { ok: false as const, path: assetRoot, error: `${(e as NodeJS.ErrnoException).code ?? 'ERROR'}: ${(e as Error).message}` };
  }
}
