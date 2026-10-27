/** `/api/memories`: the memory manager of the assistant panel (list / add / edit / switch / delete, and the director switch). */
import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { visibleMemories } from '../../shared/agent/memory';
import { MemoryError, type MemoryStore } from './memoryStore';

function fail(res: Response, e: unknown): void {
  if (e instanceof MemoryError) return void res.status(e.status).json({ error: { kind: e.status === 404 ? 'not_found' : 'bad_request', message: e.message } });
  if (e instanceof z.ZodError) return void res.status(400).json({ error: { kind: 'bad_request', message: e.issues[0]?.message ?? '格式不对' } });
  res.status(500).json({ error: { kind: 'server', message: (e as Error).message } });
}

export function memoryRoutes(store: MemoryStore): Router {
  const r = Router();
  const json = express.json({ limit: '64kb' });
  r.get('/api/memories', async (req, res) => {
    try {
      const f = await store.read();
      const pid = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
      res.json({ enabled: f.enabled, memories: pid ? visibleMemories(f.memories, pid) : f.memories });
    } catch (e) { fail(res, e); }
  });
  r.post('/api/memories', json, async (req, res) => {
    try { res.json({ memory: await store.add(req.body) }); } catch (e) { fail(res, e); }
  });
  r.patch('/api/memories/:id', json, async (req, res) => {
    try { res.json({ memory: await store.update(req.params.id, req.body) }); } catch (e) { fail(res, e); }
  });
  r.delete('/api/memories/:id', async (req, res) => {
    try { res.json({ memory: await store.remove(req.params.id) }); } catch (e) { fail(res, e); }
  });
  r.put('/api/memories-enabled', json, async (req, res) => {
    const b = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: { kind: 'bad_request', message: '需要 on' } });
    try { res.json({ enabled: await store.setEnabled(b.data.on) }); } catch (e) { fail(res, e); }
  });
  return r;
}
