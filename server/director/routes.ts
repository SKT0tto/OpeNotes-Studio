import express, { Router, type Response } from 'express';
import { z } from 'zod';
import type { CatalogService } from '../assets/indexer';
import type { LlmCache } from '../llm/cache';
import { runBreakdown, type DirectorDeps } from '../llm/director';
import { runScene, runScenes } from '../llm/sceneRunner';
import { SCOPE_NAMES } from '../../shared/director/scope';
import { ProjectSchema } from '../../shared/schema/project';
import { DirectorError } from '../llm/pipeline';
import { LlmError } from '../llm/provider';
import type { LlmSettings } from '../settings/store';
import { RuleProvider } from '../llm/ruleProvider';
import { directorPreferencesFor, type MemoryBackend } from '../agent/memoryStore';

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.|\[::1\]|192\.168\.|10\.)/i.test(url.trim());

/** Wire form of any director failure: `kind` for the UI, a safe message, optional problem list. */
function fail(res: Response, e: unknown): void {
  if (e instanceof DirectorError) return void res.status(422).json({ error: { kind: e.kind, message: e.message, problems: e.problems } });
  if (e instanceof LlmError) return void res.status(e.kind === 'not_configured' ? 503 : e.kind === 'bad_request' ? 400 : 502).json({ error: { kind: e.kind, message: e.message } });
  res.status(500).json({ error: { kind: 'server', message: (e as Error).message ?? String(e) } });
}

export interface DirectorRouteDeps {
  settings: LlmSettings;
  cache: LlmCache;
  catalog: CatalogService;
  /** The assistant's long-term memory: its active entries steer AI scene direction (not the rule director) when the user allows it. */
  memory?: MemoryBackend | undefined;
}

/** Resolves provider + catalog for one request; null when no AI is configured (the response is already sent). */
export async function directorDeps(d: DirectorRouteDeps, res: Response, signal: AbortSignal, refresh: boolean, engine?: 'rule'): Promise<(DirectorDeps & { catalogVersion: string; full: Awaited<ReturnType<CatalogService['get']>> }) | null> {
  if (engine === 'rule') {
    // the deterministic rule director: no key needed, no cache, answers are labelled `rule`
    const catalog = await d.catalog.get();
    return { provider: new RuleProvider(catalog), cache: null, catalog, full: catalog, catalogVersion: catalog.version, refresh, signal, splitLongLines: true };
  }
  const p = d.settings.provider();
  if (!p.provider) {
    res.status(503).json({ error: { kind: 'not_configured', message: p.message } });
    return null;
  }
  const catalog = await d.catalog.get();
  const eff = d.settings.effective();
  return {
    provider: p.provider, cache: d.cache, catalog, full: catalog, catalogVersion: catalog.version, refresh, signal, splitLongLines: true,
    ...(eff.provider === 'openai' && isLocal(eff.openai.baseUrl) ? { backgroundLimit: 60 } : {}),
  };
}

/** A rejected key / unreachable endpoint during real work must show up in the settings panel too (not "已配置" forever). */
function noteFailure(d: DirectorRouteDeps, e: unknown, engine?: 'rule'): void {
  if (engine === 'rule') return;
  if (e instanceof LlmError && (e.kind === 'auth' || e.kind === 'network' || e.kind === 'timeout')) d.settings.noteResult(false, e.message);
}

export const abortOnClose = (res: Response): AbortSignal => {
  const ctl = new AbortController();
  res.on('close', () => !res.writableEnded && ctl.abort());
  return ctl.signal;
};

export function directorRoutes(d: DirectorRouteDeps): Router {
  const r = Router();
  const json = express.json({ limit: '30mb' });

  r.post('/api/director/breakdown', json, async (req, res) => {
    const body = z.object({ text: z.string().min(1), title: z.string().optional(), refresh: z.boolean().optional(), engine: z.literal('rule').optional() }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: { kind: 'bad_request', message: '需要 text（小说文本）' } });
    try {
      const deps = await directorDeps(d, res, abortOnClose(res), body.data.refresh === true, body.data.engine);
      if (!deps) return;
      const genId = `g_${Date.now().toString(36)}`;
      const out = await runBreakdown(deps, body.data.text, body.data.title ?? '未命名项目', genId);
      if (body.data.engine !== 'rule') d.settings.noteResult(true);
      out.project.catalogVersion = deps.catalogVersion;
      res.json({ ...out, cached: out.runs.every((x) => x.cached) });
    } catch (e) {
      noteFailure(d, e, body.data.engine);
      fail(res, e);
    }
  });

  const ScopeList = z.array(z.enum(SCOPE_NAMES as unknown as [string, ...string[]])).default(['scene']);
  const SceneBody = z.object({
    project: z.unknown(), sceneId: z.string(), scopes: ScopeList, beatIds: z.array(z.string()).optional(), overwriteUser: z.boolean().optional(), refresh: z.boolean().optional(), engine: z.literal('rule').optional(), useMemories: z.boolean().optional(),
  });
  const parseProject = (v: unknown) => {
    const p = ProjectSchema.safeParse(v);
    return p.success ? p.data : null;
  };

  /** Single scene (or part of it: scopes / beatIds). The merged scene is returned; the client applies it as one undo step. */
  r.post('/api/director/scene', json, async (req, res) => {
    const body = SceneBody.safeParse(req.body);
    const project = body.success ? parseProject(body.data.project) : null;
    if (!body.success || !project) return void res.status(400).json({ error: { kind: 'bad_request', message: '需要合法的 project 与 sceneId' } });
    try {
      const deps = await directorDeps(d, res, abortOnClose(res), body.data.refresh === true, body.data.engine);
      if (!deps) return;
      if (body.data.engine !== 'rule' && body.data.useMemories !== false) deps.preferences = await directorPreferencesFor(d.memory, project.id);
      const result = await runScene(deps, { project, sceneId: body.data.sceneId, scopes: body.data.scopes as never, beatIds: body.data.beatIds, overwriteUser: body.data.overwriteUser }, `g_${Date.now().toString(36)}`);
      if (body.data.engine !== 'rule') d.settings.noteResult(true);
      res.json({ ...result, cached: result.runs.every((x) => x.cached) });
    } catch (e) {
      noteFailure(d, e, body.data.engine);
      fail(res, e);
    }
  });

  /** Several scenes, 2-3 at a time, with one Server-Sent Event per scene state change and a final `done` event. */
  r.post('/api/director/scenes', json, async (req, res) => {
    const body = z.object({ project: z.unknown(), sceneIds: z.array(z.string()).optional(), scopes: ScopeList, concurrency: z.number().int().min(1).max(4).optional(), overwriteUser: z.boolean().optional(), refresh: z.boolean().optional(), engine: z.literal('rule').optional(), useMemories: z.boolean().optional() }).safeParse(req.body);
    const project = body.success ? parseProject(body.data.project) : null;
    if (!body.success || !project) return void res.status(400).json({ error: { kind: 'bad_request', message: '需要合法的 project' } });
    try {
      const deps = await directorDeps(d, res, abortOnClose(res), body.data.refresh === true, body.data.engine);
      if (!deps) return;
      if (body.data.engine !== 'rule' && body.data.useMemories !== false) deps.preferences = await directorPreferencesFor(d.memory, project.id);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
      const ids = body.data.sceneIds ?? project.scenes.map((s) => s.id);
      const items = await runScenes(deps, project, ids, body.data.scopes as never, `g_${Date.now().toString(36)}`, body.data.concurrency ?? 3, (p) => send('progress', p), body.data.overwriteUser === true);
      if (body.data.engine !== 'rule') {
        const bad = items.find((i) => i.error?.kind === 'auth' || i.error?.kind === 'network');
        if (bad) d.settings.noteResult(false, bad.error!.message);
        else if (items.some((i) => i.result)) d.settings.noteResult(true);
      }
      send('done', { items });
      res.end();
    } catch (e) {
      if (res.headersSent) {
        res.write(`event: failed
data: ${JSON.stringify({ message: (e as Error).message })}

`);
        res.end();
      } else fail(res, e);
    }
  });
  return r;
}

export { fail as sendDirectorError };
