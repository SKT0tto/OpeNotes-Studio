import express, { Router } from 'express';
import { ZodError } from 'zod';
import type { LlmSettings } from '../settings/store';
import { LlmError } from './provider';

/** Wire form of a failure: `kind` for the UI, a message that never contains a key. */
export const errorBody = (e: unknown) =>
  e instanceof LlmError ? { kind: e.kind, message: e.message } : { kind: 'server', message: (e as Error).message ?? String(e) };

/** `GET/PUT /api/llm/settings` (masked keys only) and `POST /api/llm/test` (always HTTP 200; `ok:false` carries the reason). */
export function llmRoutes(settings: LlmSettings): Router {
  const r = Router();
  r.get('/api/llm/settings', (_req, res) => void res.json(settings.view()));
  r.put('/api/llm/settings', express.json({ limit: '16kb' }), (req, res) => {
    try {
      res.json(settings.patch(req.body));
    } catch (e) {
      if (e instanceof ZodError) return void res.status(400).json({ error: '设置格式不正确' });
      throw e;
    }
  });
  r.post('/api/llm/test', async (_req, res) => {
    const p = settings.provider();
    if (!p.provider) return void res.json({ ok: false, error: { kind: 'not_configured', message: p.message } });
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());
    try {
      const t = await p.provider.test(ctl.signal);
      res.json({ ok: true, provider: p.provider.id, model: t.model, latencyMs: t.latencyMs });
    } catch (e) {
      res.json({ ok: false, provider: p.provider.id, model: p.provider.model, error: errorBody(e) });
    }
  });
  return r;
}
