import type { ErrorRequestHandler, Router } from 'express';
import { z, ZodError } from 'zod';
import { ProjectSchema } from '../../../shared/schema/project';
import type { VoiceScope } from './schema';
import { SovitsError, testConnection } from './sovits';
import { VoiceError, type VoiceService } from './service';
import type { VoiceSettingsStore } from './store';

const ScopeSchema = z.union([
  z.object({ kind: z.literal('project') }),
  z.object({ kind: z.literal('scene'), sceneId: z.string().min(1) }),
  z.object({ kind: z.literal('beat'), sceneId: z.string().min(1), beatId: z.string().min(1) }),
]);

export const PREVIEW_TEXT = 'こんにちは、今日もよろしくお願いします。';

/** Mounted at `/api/plugins/gpt-sovits/`: settings, connection test, preview, jobs. */
export function voiceRoutes(r: Router, settings: VoiceSettingsStore, service: VoiceService): void {

  r.get('/settings', (_req, res) => void res.json(settings.read()));
  r.put('/settings', (req, res) => void res.json(settings.patch(req.body)));

  r.post('/test', async (req, res) => {
    const body = z.object({ endpoint: z.string().optional() }).safeParse(req.body ?? {});
    const ctl = new AbortController();
    res.on('close', () => ctl.abort());
    res.json(await testConnection(body.success && body.data.endpoint ? body.data.endpoint : settings.read().endpoint, ctl.signal));
  });

  r.post('/preview', async (req, res) => {
    const body = z.object({ characterKey: z.string().min(1), text: z.string().optional() }).safeParse(req.body);
    if (!body.success) throw new VoiceError(400, '需要 characterKey');
    const ctl = new AbortController();
    res.on('close', () => !res.writableEnded && ctl.abort());
    const wav = await service.preview(body.data.characterKey, body.data.text?.trim() || PREVIEW_TEXT, ctl.signal);
    res.type('audio/wav').send(Buffer.from(wav));
  });

  r.post('/jobs', (req, res) => {
    const body = z.object({ project: z.unknown(), scope: ScopeSchema, retranslate: z.boolean().optional(), force: z.boolean().optional() }).safeParse(req.body);
    const project = body.success ? ProjectSchema.safeParse(body.data.project) : null;
    if (!body.success || !project?.success) throw new VoiceError(400, '需要合法的 project 与 scope');
    const id = service.start(project.data, body.data.scope as VoiceScope, { retranslate: body.data.retranslate, force: body.data.force });
    res.status(201).json({ id });
  });
  r.get('/jobs/:id', (req, res) => {
    const v = service.view(req.params.id);
    if (!v) throw new VoiceError(404, '没有这个配音任务（服务重启后任务会丢失）');
    res.json(v);
  });
  r.post('/jobs/:id/cancel', (req, res) => {
    if (!service.view(req.params.id)) throw new VoiceError(404, '没有这个配音任务');
    service.cancel(req.params.id);
    res.json({ ok: true });
  });

  r.use(((err, _req, res, next) => {
    if (err instanceof VoiceError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof SovitsError) return void res.status(err.kind === 'aborted' ? 499 : 502).json({ error: err.message });
    if (err instanceof ZodError) return void res.status(400).json({ error: '配音设置格式不正确' });
    next(err);
  }) as ErrorRequestHandler);
}
