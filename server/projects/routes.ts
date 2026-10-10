import express, { Router, type ErrorRequestHandler } from 'express';
import type { StudioConfig } from '../config';
import path from 'node:path';
import { ProjectStore, StoreError } from './store';

/** `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/:id` (PUT needs `If-Match` = the ETag of the last GET/PUT). */
export function projectRoutes(config: StudioConfig): Router {
  const store = new ProjectStore(path.join(config.dataDir, 'projects'));
  const r = Router();
  const json = express.json({ limit: '30mb' });

  r.get('/api/projects', async (_req, res) => void res.json(await store.list()));
  r.get('/api/projects/:id', async (req, res) => {
    const { project, etag } = await store.get(req.params.id);
    res.setHeader('ETag', `"${etag}"`).json(project);
  });
  r.post('/api/projects', json, async (req, res) => {
    const { project, etag } = await store.create(req.body);
    res.status(201).setHeader('ETag', `"${etag}"`).json(project);
  });
  r.put('/api/projects/:id', json, async (req, res) => {
    const { project, etag } = await store.save(req.params.id, req.body, req.header('If-Match'));
    res.setHeader('ETag', `"${etag}"`).json(project);
  });
  r.delete('/api/projects/:id', async (req, res) => {
    await store.remove(req.params.id);
    res.status(204).end();
  });

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (err instanceof StoreError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof SyntaxError && 'body' in err) return void res.status(400).json({ error: 'request body is not valid JSON' });
    next(err);
  };
  r.use(onError);
  return r;
}
