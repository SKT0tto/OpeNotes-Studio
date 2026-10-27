import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import type { CatalogService } from '../assets/indexer';
import { directorDeps, abortOnClose } from '../director/routes';
import type { LlmCache } from '../llm/cache';
import { errorBody } from '../llm/routes';
import { LlmError } from '../llm/provider';
import type { LlmSettings } from '../settings/store';
import { MAX_FRAMES, type CaptureRequest, type CapturedFrame } from '../../shared/agent/frames';
import { AgentOpSchema } from '../../shared/agent/ops';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import { runAgentTurn, type FrameSource } from './loop';
import { directorPreferencesFor, memoryIfOn, type MemoryBackend } from './memoryStore';

export interface AgentRouteDeps {
  settings: LlmSettings;
  cache: LlmCache;
  catalog: CatalogService;
  /** Long-term memory of the assistant (absent = the assistant has no memory tools). */
  memory?: MemoryBackend | undefined;
}

/** A picture: a base64 data URL of a web image format (≤ ~6 MB), with a short label. */
const Picture = z.object({ dataUrl: z.string().max(8_000_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,/), label: z.string().max(80).default('') });
const FramesBody = z.object({ frames: z.array(Picture).max(MAX_FRAMES).optional(), error: z.string().max(400).optional() });
/** How long the server waits for the browser to render frames. */
export const CAPTURE_TIMEOUT_MS = 60_000;

const Body = z.object({
  project: z.unknown(),
  selection: z.object({ sceneId: z.string().nullable().optional(), beatId: z.string().nullable().optional(), castId: z.string().nullable().optional(), beatIds: z.array(z.string()).max(300).optional() }).default({}),
  instruction: z.string().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string(), revert: z.array(AgentOpSchema).max(2000).optional() })).max(40).optional(),
  attachments: z.array(Picture).max(MAX_FRAMES).optional(),
  canCapture: z.boolean().optional(),
  limits: z.object({ maxSteps: z.number().int().min(1).max(100).optional(), wallMs: z.number().int().min(1000).max(30 * 60_000).optional(), maxOps: z.number().int().min(1).max(1000).optional() }).optional(),
});

/** `POST /api/agent/turn`: one agent turn as a Server-Sent-Events stream (status / tool / op / usage / ask, then proposal + done, or failed). */
export function agentRoutes(d: AgentRouteDeps): Router {
  const r = Router();
  const running = new Set<string>();
  /** Capture requests sent to a browser and not answered yet. */
  const waiting = new Map<string, (r: { frames?: CapturedFrame[]; error?: string }) => void>();
  r.post('/api/agent/frames/:reqId', express.json({ limit: '60mb' }), (req, res) => {
    const done = waiting.get(req.params.reqId);
    const body = FramesBody.safeParse(req.body);
    if (!done) return void res.status(404).json({ error: { kind: 'not_found', message: '这个截图请求已经结束' } });
    if (!body.success) return void res.status(400).json({ error: { kind: 'bad_request', message: '截图格式不对' } });
    done(body.data);
    res.json({ ok: true });
  });
  r.post('/api/agent/turn', express.json({ limit: '30mb' }), async (req, res) => {
    const body = Body.safeParse(req.body);
    const project = body.success ? ProjectSchema.safeParse(body.data.project) : null;
    if (!body.success || !project?.success) return void res.status(400).json({ error: { kind: 'bad_request', message: '需要合法的 project 和 instruction' } });
    const pid = project.data.id;
    if (running.has(pid)) return void res.status(409).json({ error: { kind: 'busy', message: '这个项目上一条指令还在处理中' } });
    const signal = abortOnClose(res);
    const deps = await directorDeps({ settings: d.settings, cache: d.cache, catalog: d.catalog }, res, signal, false);
    if (!deps) return;
    if (!deps.provider.chatTools && deps.provider.id === 'rule') return void res.status(503).json({ error: { kind: 'not_configured', message: '助手需要 AI 模型（规则生成不支持）' } });
    running.add(pid);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: string, data: unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      // the eyes: the browser renders frames for capture_frames over this stream; pictures go to the main model or a separate vision model
      const vision = await d.settings.vision(deps.provider, signal).catch(() => null);
      const frames: FrameSource | undefined = body.data.canCapture ? {
        capture: (proj: Project, creq: CaptureRequest, sig?: AbortSignal) => new Promise<CapturedFrame[]>((resolve, reject) => {
          const reqId = randomUUID();
          const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error('浏览器没有回应截图请求')); }, CAPTURE_TIMEOUT_MS);
          sig?.addEventListener('abort', () => { clearTimeout(timer); waiting.delete(reqId); reject(new Error('已取消')); });
          waiting.set(reqId, (a) => { clearTimeout(timer); waiting.delete(reqId); if (a.frames?.length) resolve(a.frames.map((f) => ({ label: f.label, dataUrl: f.dataUrl }))); else reject(new Error(a.error ?? '没有截到画面')); });
          send('capture', { reqId, project: proj, req: creq });
        }),
      } : undefined;
      // the memory system is experimental and can be switched off: then no memory tools, no prompt block, no director preferences
      const memory = await memoryIfOn(d.memory);
      const preferences = await directorPreferencesFor(memory, pid);
      const result = await runAgentTurn({ provider: deps.provider, catalog: deps.catalog, director: preferences ? { ...deps, preferences } : deps, signal, emit: (e) => send(e.type, e), frames, vision, ...(memory ? { memory } : {}) }, {
        project: project.data, selection: body.data.selection, instruction: body.data.instruction, history: body.data.history, attachments: body.data.attachments, limits: body.data.limits,
      });
      d.settings.noteResult(true);
      send('proposal', { ...result, model: `${deps.provider.id}:${deps.provider.model}` });
      send('done', {});
    } catch (e) {
      if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'network' || e.kind === 'timeout')) d.settings.noteResult(false, e.message);
      send('failed', errorBody(e));
    } finally {
      running.delete(pid);
      res.end();
    }
  });
  return r;
}
