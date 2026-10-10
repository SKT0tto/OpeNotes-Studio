import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import pkg from '../package.json';
import { assetRoutes, probeAssetRoot } from './assets/routes';
import { CatalogService } from './assets/indexer';
import { backgroundRoutes } from './backgrounds/routes';
import { calibrationRoutes } from './calibration/routes';
import { projectRoutes } from './projects/routes';
import type { StudioConfig } from './config';
import { FixtureProvider } from './llm/fixtureProvider';
import { LlmCache } from './llm/cache';
import { directorRoutes } from './director/routes';
import { llmRoutes } from './llm/routes';
import { LlmSettings } from './settings/store';
import { DEFAULT_LABELS_FILE, LabelStore, labelRoutes, readLabelFile } from './assets/labels';
import { importRoutes } from './assets/import/routes';
import { HaneokaSource } from './assets/sources/haneoka';
import { sourceRoutes } from './assets/sources/routes';
import { SetupStore, setupRoutes } from './setup/routes';

export interface AppHandle {
  app: Express;
  catalog: CatalogService;
  llm: LlmSettings;
  llmCache: LlmCache;
}

export interface AppExtras {
  env?: Record<string, string | undefined>;
  /** Injected in tests (mock fetch for the providers). */
  fetch?: typeof fetch;
  /** `.env` to re-read on every LLM request (hot reload); `base` is the process environment from before `.env` was loaded. */
  dotEnv?: { file: string; base: Record<string, string | undefined> };
}

export function createApp(config: StudioConfig, log: (msg: string) => void = () => {}, extras: AppExtras = {}): AppHandle {
  const env = extras.env ?? process.env;
  const app = express();
  const labelsFile = path.resolve(env.LABELS_FILE ?? DEFAULT_LABELS_FILE);
  const catalog = new CatalogService({
    labelsFile,
    assetRoot: config.assetRoot,
    audioRoots: config.audioRoots,
    cacheFile: path.join(config.dataDir, 'index', 'catalog.json'),
    log,
  });

  app.disable('x-powered-by');

  app.get('/api/health', async (_req, res) => {
    const [assetRoot, audioRoots] = await Promise.all([
      probeAssetRoot(config.assetRoot),
      Promise.all(config.audioRoots.map((p) => fs.promises.access(p).then(() => ({ path: p, ok: true }), () => ({ path: p, ok: false })))),
    ]);
    res.json({
      ok: true,
      version: pkg.version,
      assetRoot,
      audioRoots,
      cubismCoreUrl: config.cubismCoreUrl,
      catalog: catalog.status,
    });
  });

  // The recorded-response provider exists only in test mode; a production server never offers it.
  const fixtureDir = path.resolve(env.LLM_FIXTURE_DIR ?? path.join('tests', 'fixtures', 'llm'));
  const llm = new LlmSettings({
    file: path.resolve(env.LLM_SETTINGS_FILE ?? path.join(config.dataDir, 'settings.local.json')),
    env,
    fixtureProvider: env.NODE_ENV === 'test' ? () => fixtureSingleton(fixtureDir) : undefined,
    ...(extras.fetch ? { fetch: extras.fetch } : {}),
    ...(extras.dotEnv ? { dotEnv: extras.dotEnv } : {}),
  });
  const llmCache = new LlmCache(path.join(config.dataDir, 'llm-cache'));
  app.use(llmRoutes(llm));
  app.use(directorRoutes({ settings: llm, cache: llmCache, catalog }));

  const setupStore = new SetupStore(path.resolve(env.SETUP_FILE ?? path.join(config.dataDir, 'setup.local.json')));
  const haneoka = new HaneokaSource({
    cacheFile: path.join(config.dataDir, 'sources', 'haneoka', 'cache.json'),
    version: pkg.version,
    ...(env.HANEOKA_BASE_URL ? { baseUrl: env.HANEOKA_BASE_URL } : {}),
    ...(extras.fetch ? { fetch: extras.fetch } : {}),
  });
  const labelled = async () => new Set(Object.keys((await readLabelFile(labelsFile).catch(() => null))?.labels ?? {}));
  app.use(setupRoutes(config, setupStore, extras.fetch));
  app.use(sourceRoutes({ source: haneoka, store: setupStore, catalog, labels: () => readLabelFile(labelsFile) }));
  app.use(importRoutes({
    config, catalog, labelled,
    cardNames: async () => new Map((await haneoka.readCache())?.cards.flatMap((c) => (c.stem ? [[c.stem, c.id] as [string, string]] : [])) ?? []),
  }));
  app.use(labelRoutes(new LabelStore(labelsFile), catalog));
  app.use(assetRoutes(config, catalog));
  app.use(calibrationRoutes(config));
  app.use(backgroundRoutes(config));
  app.use(projectRoutes(config));

  const webDist = path.resolve('dist', 'web');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  return { app, catalog, llm, llmCache };
}

let fixture: FixtureProvider | null = null;
function fixtureSingleton(dir: string): FixtureProvider {
  if (!fixture || fixture.dir !== dir) fixture = new FixtureProvider(dir);
  return fixture;
}
