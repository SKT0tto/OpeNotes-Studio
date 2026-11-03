/**
 * Plugin loader. Scans `<install>/plugins/<id>/plugin.json`, imports each plugin's Node entry and mounts its router at `/api/plugins/<id>/`.
 * Built entry (`server.mjs`) first; under tsx (dev) a `src/server.ts` is imported instead when there is one. Anything that goes wrong in one plugin
 * is recorded on that plugin (`GET /api/plugins` shows it) and logged; it never reaches the studio.
 * `GET /plugins/<id>/web.js` (+ `web.css`) serves the browser entry. In dev the browser entry is the TypeScript source, served by vite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { Router, type ErrorRequestHandler } from 'express';
import type { JsonCallRequest, PluginInfo, PluginManifest, PluginRegister, PluginServerContext } from '../../shared/plugins/api';
import { LlmCache, generateCached } from '../llm/cache';
import { LlmError } from '../llm/provider';
import type { LlmSettings } from '../settings/store';
import type { VoiceFiles } from './voiceFiles';

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export interface PluginHostDeps {
  /** `<install>/plugins` */
  pluginsDir: string;
  /** `data/` */
  dataDir: string;
  llm: Pick<LlmSettings, 'provider'>;
  cache: LlmCache | null;
  voiceFiles: VoiceFiles;
  log(message: string): void;
  /** Prefer `src/*.ts` over built files (tsx / vite dev). */
  dev?: boolean | undefined;
}

export class PluginHost {
  /** Mounted once by the app; plugin routes are added to it as they load. */
  readonly router = Router();
  private readonly infos: PluginInfo[] = [];
  private readonly dirs = new Map<string, string>();

  constructor(private readonly deps: PluginHostDeps) {
    this.router.get('/api/plugins', (_req, res) => void res.json(this.infos));
    this.router.get('/plugins/:id/:file', (req, res) => {
      const dir = this.dirs.get(req.params.id);
      const file = req.params.file;
      // only the browser entry and its stylesheet: never server.mjs, never the plugin's data
      if (!dir || !/^web(\.[A-Za-z0-9_-]+)?\.(js|css|js\.map)$/.test(file)) return void res.status(404).end();
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) return void res.status(404).end();
      res.setHeader('cache-control', 'no-cache');
      res.sendFile(full);
    });
  }

  list(): PluginInfo[] {
    return this.infos;
  }

  /** Loads every plugin folder. Never throws. */
  async loadAll(): Promise<void> {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      return; // no plugins folder = no plugins
    }
    for (const name of names) {
      const dir = path.join(this.deps.pluginsDir, name);
      if (!fs.existsSync(path.join(dir, 'plugin.json'))) continue;
      await this.loadOne(dir, name);
    }
  }

  private async loadOne(dir: string, folder: string): Promise<void> {
    const log = this.deps.log;
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as PluginManifest;
      if (typeof manifest.id !== 'string' || !PLUGIN_ID.test(manifest.id)) throw new Error('plugin.json: "id" is missing or not a plain lowercase id');
      if (manifest.id !== folder) throw new Error(`plugin.json: id "${manifest.id}" does not match the folder name "${folder}"`);
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('plugin.json: "name" and "version" are required');
    } catch (e) {
      const msg = (e as Error).message;
      log(`plugin ${folder}: skipped (${msg})`);
      this.infos.push({ id: folder, name: folder, version: '', description: '', web: null, error: msg });
      return;
    }
    const info: PluginInfo = { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description ?? '', web: null };
    this.infos.push(info);
    this.dirs.set(manifest.id, dir);

    // browser entry
    const webFile = manifest.web ?? 'web.js';
    const src = path.join(dir, 'src', 'web.tsx');
    if (this.deps.dev && fs.existsSync(src)) info.web = `/@fs/${src.replace(/\\/g, '/')}`;
    else if (fs.existsSync(path.join(dir, webFile))) info.web = `/plugins/${manifest.id}/${webFile}`;

    // Node entry
    const builtFile = path.join(dir, manifest.server ?? 'server.mjs');
    const srcFile = path.join(dir, 'src', 'server.ts');
    const entry = this.deps.dev && fs.existsSync(srcFile) ? srcFile : fs.existsSync(builtFile) ? builtFile : null;
    if (!entry) {
      if (manifest.server && !info.web) info.error = `没有找到 ${manifest.server}`;
      return;
    }
    try {
      const mod = (await import(pathToFileURL(entry).href)) as { default?: PluginRegister };
      if (typeof mod.default !== 'function') throw new Error('server entry has no default export register(ctx)');
      const router = Router();
      await mod.default(this.context(manifest.id, router));
      const onError: ErrorRequestHandler = (err, _req, res, next) => {
        if (res.headersSent) return next(err);
        const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
        res.status(status).json({ error: (err as Error).message ?? String(err) });
      };
      router.use(onError);
      this.router.use(`/api/plugins/${manifest.id}`, router);
      log(`plugin ${manifest.id} ${manifest.version} loaded`);
    } catch (e) {
      info.error = `服务端加载失败：${(e as Error).message}`;
      log(`plugin ${manifest.id}: server entry failed (${(e as Error).message})`);
    }
  }

  private context(id: string, router: Router): PluginServerContext {
    const d = this.deps;
    router.use(express.json({ limit: '30mb' }));
    return {
      id,
      router,
      dataDir: path.join(d.dataDir, 'plugins', id),
      rootDataDir: d.dataDir,
      log: (m) => d.log(`[${id}] ${m}`),
      voice: { write: (p, n, b) => d.voiceFiles.write(p, n, b), read: (p, n) => d.voiceFiles.read(p, n), list: (p) => d.voiceFiles.list(p), remove: (p, n) => d.voiceFiles.remove(p, n) },
      llm: {
        available: () => {
          const p = d.llm.provider();
          return p.provider ? { ok: true } : { ok: false, message: p.message };
        },
        callJson: async <T,>(req: JsonCallRequest<T>) => {
          const p = d.llm.provider();
          if (!p.provider) throw new LlmError('not_configured', p.message);
          const r = await generateCached(p.provider, d.cache, req.promptVersion, { system: req.system, input: req.user, schema: req.schema, schemaName: req.schemaName, maxTokens: req.maxTokens, signal: req.signal }, req.refresh ? { refresh: true } : {});
          return { data: r.data, cached: r.cached };
        },
      },
    };
  }
}
