/**
 * Loaded-model cache for the stage: catalog + calibration access, shared Live2D actor instances (LRU, max 10),
 * and background textures. One actor instance exists per model id.
 */
import { Assets, type Texture, type Ticker } from 'pixi.js';
import type { Calibration } from '@shared/schema/calibration';
import type { BackgroundEntry, CompactCatalog, ModelEntry } from '@shared/schema/assets';
import type { CompileContext } from '@shared/timeline/types';
import type { GroundOverride } from '@shared/schema/ground';
import { fetchBackgroundGround, fetchCalibration, fetchCatalog, fetchModel, saveCalibration } from '../api';
import { Live2DActor, NEUTRAL_SIGNS } from './Live2DActor';
import { registerDebugActor } from './debugHooks';
import { probeModel } from './ModelProbe';
import { ensureRuntime } from './runtime';

export const MAX_CACHED_MODELS = 10;

type Runtime = Awaited<ReturnType<typeof ensureRuntime>>;

export class ModelLibrary {
  private catalogP: Promise<CompactCatalog> | null = null;
  private readonly entries = new Map<string, Promise<ModelEntry>>();
  private readonly cals = new Map<string, Calibration>();
  private readonly actors = new Map<string, Promise<Live2DActor>>();
  private readonly ready = new Map<string, Live2DActor>();
  private readonly unregister = new Map<string, () => void>();
  private readonly textures = new Map<string, Promise<Texture>>();
  private readonly grounds = new Map<string, Promise<GroundOverride | null>>();
  /** Model ids used by the scene on screen; never evicted. */
  private pinned = new Set<string>();

  constructor(
    private readonly rt: Runtime,
    private readonly ticker: Ticker,
  ) {}

  static async create(coreUrl: string, ticker: Ticker): Promise<ModelLibrary> {
    return new ModelLibrary(await ensureRuntime(coreUrl), ticker);
  }

  catalog(): Promise<CompactCatalog> {
    return (this.catalogP ??= fetchCatalog());
  }

  async background(id: string): Promise<BackgroundEntry> {
    const b = (await this.catalog()).backgrounds.find((x) => x.id === id);
    if (!b) throw new Error(`unknown background "${id}"`);
    return b;
  }

  model(id: string): Promise<ModelEntry> {
    let p = this.entries.get(id);
    if (!p) this.entries.set(id, (p = fetchModel(id)));
    return p;
  }

  async backgroundTexture(id: string): Promise<Texture> {
    let p = this.textures.get(id);
    if (!p) {
      const entry = await this.background(id);
      this.textures.set(id, (p = Assets.load<Texture>({ src: entry.url, parser: 'loadTextures' })));
    }
    return p;
  }

  ground(id: string): Promise<GroundOverride | null> {
    let p = this.grounds.get(id);
    if (!p) this.grounds.set(id, (p = fetchBackgroundGround(id)));
    return p;
  }

  /** Forget a cached ground override (after the lab saved a new one). */
  invalidateGround(id: string): void {
    this.grounds.delete(id);
  }

  calibrationSync(modelId: string): Calibration {
    const c = this.cals.get(modelId);
    if (!c) throw new Error(`model "${modelId}" is not calibrated yet`);
    return c;
  }

  /** Saved calibration, or probe the model once and persist the result. */
  async calibration(modelId: string): Promise<Calibration> {
    const have = this.cals.get(modelId);
    if (have) return have;
    let cal = await fetchCalibration(modelId);
    if (!cal) {
      const probing = await this.acquire(modelId);
      probing.model.update(16);
      probing.model.update(16);
      cal = await saveCalibration(probeModel(probing, modelId));
    }
    this.cals.set(modelId, cal);
    const actor = this.ready.get(modelId);
    if (actor) actor.override.signs = cal;
    return cal;
  }

  /** The shared actor for a model id (loads on first use). */
  acquire(modelId: string): Promise<Live2DActor> {
    let p = this.actors.get(modelId);
    if (!p) {
      p = (async () => {
        const [entry, saved] = await Promise.all([this.model(modelId), fetchCalibration(modelId)]);
        if (saved) this.cals.set(modelId, saved);
        const actor = await Live2DActor.load(this.rt, { id: modelId, modelUrl: entry.url, signs: saved ?? NEUTRAL_SIGNS, ticker: this.ticker });
        this.ready.set(modelId, actor);
        this.unregister.set(modelId, registerDebugActor(actor));
        this.evict();
        return actor;
      })();
      this.actors.set(modelId, p);
      p.catch(() => this.actors.delete(modelId));
    }
    return p;
  }

  /** Loaded instance, or null while it is still loading. */
  loaded(modelId: string): Live2DActor | null {
    return this.ready.get(modelId) ?? null;
  }

  pin(modelIds: Iterable<string>): void {
    this.pinned = new Set(modelIds);
  }

  private evict(): void {
    for (const id of [...this.ready.keys()]) {
      if (this.ready.size <= MAX_CACHED_MODELS) break;
      if (this.pinned.has(id)) continue;
      this.ready.get(id)!.destroy();
      this.ready.delete(id);
      this.actors.delete(id);
      this.unregister.get(id)?.();
      this.unregister.delete(id);
    }
  }

  /** Everything compile needs for a set of models / backgrounds (probes missing calibrations). */
  async compileContext(modelIds: Iterable<string>, backgroundIds: Iterable<string>): Promise<CompileContext> {
    const ctx: CompileContext = { models: {}, calibrations: {}, backgrounds: {} };
    await Promise.all([
      ...[...new Set(modelIds)].map(async (id) => {
        const [entry, cal] = await Promise.all([this.model(id), this.calibration(id)]);
        ctx.models[id] = { motions: entry.motions, expressions: entry.expressions.map((e) => e.name) };
        ctx.calibrations[id] = cal;
      }),
      ...[...new Set(backgroundIds)].map(async (id) => {
        const [b, g] = await Promise.all([this.background(id), this.ground(id)]);
        ctx.backgrounds[id] = { width: b.width ?? 2048, height: b.height ?? 1119, setting: b.setting, ...(g ? { ground: g } : {}) };
      }),
    ]);
    return ctx;
  }
}
