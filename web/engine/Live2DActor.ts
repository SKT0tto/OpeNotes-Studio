import type { Ticker } from 'pixi.js';
import type { CubismInternalModel, Live2DModel } from 'untitled-pixi-live2d-engine/cubism';
import type { AxisSigns } from '@shared/schema/calibration';
import { ParamOverride, type ParamAccess } from './ParamOverride';
import { idleNameOf } from '@shared/timeline/motionMap';
import type { ensureRuntime } from './runtime';

type Runtime = Awaited<ReturnType<typeof ensureRuntime>>;

export interface ParamInfo {
  id: string;
  index: number;
  min: number;
  max: number;
  default: number;
}

/** The slice of the Cubism core model we touch that the public typings do not expose. */
interface CoreInternals {
  _model: { parameters: { ids: string[]; values?: { buffer: ArrayBufferLike } }; drawables?: { vertexPositions?: Array<{ buffer: ArrayBufferLike } | undefined> } };
}

/** Creation counter: tells which actor was created last (see shared/cubismHeap). */
let creationSeq = 0;

const BREATH_DEPTH = 0.05;
export const NEUTRAL_SIGNS: AxisSigns = { headSign: 1, bodySign: 1, eyeSign: 1 };

export interface ActorOptions {
  /** Stable id used by debug hooks. */
  id: string;
  modelUrl: string;
  signs?: AxisSigns;
  ticker?: Ticker;
}

export class Live2DActor {
  readonly id: string;
  /** Creation order among all actors of this page. */
  readonly seq = ++creationSeq;
  /** Motion / expression names fetched ahead of time (carried over when the actor is rebuilt after a heap re-allocation). */
  readonly preloadedMotions = new Set<string>();
  readonly preloadedExpressions = new Set<string>();
  /** The Pixi container to place on a stage. Never flip it (scale.x must stay > 0). */
  readonly model: Live2DModel;
  readonly internal: CubismInternalModel;
  readonly override: ParamOverride;
  readonly params: ParamInfo[];
  private readonly indexById = new Map<string, number>();
  /** Parameter values captured right before the core model update: motion + expression + override + physics. */
  private readonly applied: Float64Array;
  private idleName: string | null = null;
  private mouth = 0;
  private readonly mouthIndex: number;
  private motionToken = 0;
  /** `playMotion` calls that are still loading: while any is pending the queue is allowed to be empty. */
  private inflight = 0;
  private aliveAfter = 0;
  private lastNow = 0;

  private constructor(
    private readonly rt: Runtime,
    id: string,
    model: Live2DModel,
    signs: AxisSigns,
  ) {
    this.id = id;
    this.model = model;
    this.internal = model.internalModel as CubismInternalModel;
    const core = this.internal.coreModel;
    const ids = (core as unknown as CoreInternals)._model.parameters.ids;
    this.params = ids.map((pid, index) => ({
      id: pid,
      index,
      min: core.getParameterMinimumValue(index),
      max: core.getParameterMaximumValue(index),
      default: core.getParameterDefaultValue(index),
    }));
    this.params.forEach((p) => this.indexById.set(p.id, p.index));
    this.mouthIndex = this.indexById.get('ParamMouthOpenY') ?? -1;
    this.applied = new Float64Array(this.params.length);

    const access: ParamAccess = {
      indexOf: (pid) => this.indexById.get(pid) ?? -1,
      get: (i) => core.getParameterValueByIndex(i),
      set: (i, v) => core.setParameterValueByIndex(i, v),
      min: (i) => this.params[i]!.min,
      max: (i) => this.params[i]!.max,
    };
    this.override = new ParamOverride(access, signs);
    this.hook();
  }

  static async load(rt: Runtime, opts: ActorOptions): Promise<Live2DActor> {
    const model = await rt.Live2DModel.from(opts.modelUrl, {
      autoFocus: false,
      autoHitTest: false,
      // The SDK sample breath sways the head by +-7.5 degrees on ParamAngleX, which would fight the facing
      // overlay; keep ParamBreath (chest) and only a hint of head sway.
      breathDepth: BREATH_DEPTH,
      ...(opts.ticker ? { ticker: opts.ticker } : {}),
    });
    return new Live2DActor(rt, opts.id, model, opts.signs ?? NEUTRAL_SIGNS);
  }

  /**
   * Replace the engine's focus step (runs after saveParameters + expressions, before breath and
   * physics) with our overlay, and snapshot the final values just before the core update.
   */
  private hook(): void {
    const im = this.internal;
    const core = im.coreModel;
    const update = im.update.bind(im);
    im.update = (dt, now) => {
      this.lastNow = now;
      this.override.step(dt / 1000);
      update(dt, now);
      this.keepAlive(now);
    };
    im.updateFocus = () => {
      this.override.apply();
      this.applyMouth();
    };
    im.on('beforeModelUpdate', () => {
      for (let i = 0; i < this.applied.length; i++) this.applied[i] = core.getParameterValueByIndex(i);
    });
  }

  /**
   * Nobody on stage is ever frozen: when the motion queue has run dry (a one-shot finished before the timeline's next event,
   * a start was refused, a model without a compiled idle) the actor's idle loop starts again on the next frame. Only for a
   * model that is on stage and not in the middle of starting something.
   */
  private keepAlive(now: number): void {
    if (!this.model.parent || this.inflight > 0 || now < this.aliveAfter || !this.internal.motionManager.isFinished()) return;
    this.aliveAfter = now + 250; // a model whose idle cannot start is retried a few times a second, not every frame
    const idle = this.idleName ?? idleNameOf(this.motionNames);
    if (idle) void this.playMotion(idle, { loop: true });
  }

  /** Pseudo lip-sync: mouth opening (0..1 of the parameter range) held until changed; 0 leaves the motion alone. */
  setMouth(v: number): void {
    this.mouth = Math.min(1, Math.max(0, v));
  }

  private applyMouth(): void {
    if (this.mouth <= 0 || this.mouthIndex < 0) return;
    const p = this.params[this.mouthIndex]!;
    const core = this.internal.coreModel;
    core.setParameterValueByIndex(this.mouthIndex, Math.max(core.getParameterValueByIndex(this.mouthIndex), p.min + (p.max - p.min) * this.mouth));
  }

  /** Run `seconds` of model time in small steps (physics settles after a seek / swap). */
  settle(seconds: number, stepMs = 33): void {
    for (let t = 0; t < seconds * 1000; t += stepMs) this.model.update(stepMs);
  }

  /**
   * The engine only advances a model while it is rendered (`model.update` just accumulates time). A hidden actor keeps
   * living through this, so physics and motions never jump by a whole backlog on the first visible frame.
   */
  updateHidden(): void {
    const dt = this.model.deltaTime;
    if (dt === 0) return;
    this.model.deltaTime = 0;
    this.internal.update(dt, this.model.elapsedTime);
  }

  /** Forget model time accumulated while the actor was not on stage (it must not be applied in one step later). */
  dropPendingTime(): void {
    this.model.deltaTime = 0;
  }

  /** Final value the renderer used last frame (includes the overlay). */
  appliedValue(id: string): number | null {
    const i = this.indexById.get(id);
    return i === undefined ? null : this.applied[i]!;
  }

  /** Motion + saved-state value (what the parameter returns to once the overlay is zero). */
  baseValue(id: string): number | null {
    const i = this.indexById.get(id);
    return i === undefined ? null : this.internal.coreModel.getParameterValueByIndex(i);
  }

  hasParam(id: string): boolean {
    return this.indexById.has(id);
  }

  /** Motion keys exactly as in model3.json. */
  get motionNames(): string[] {
    return Object.keys(this.internal.motionManager.definitions);
  }

  /** True while the motion queue still has a running motion (a finished queue means the model is only breathing / blinking). */
  get motionRunning(): boolean {
    return !this.internal.motionManager.isFinished();
  }

  get expressionNames(): string[] {
    return (this.internal.motionManager.expressionManager?.definitions ?? []).map((d) => (d as { Name: string }).Name);
  }

  /** The motion that returns after a one-shot motion finishes (looped). */
  setIdle(name: string | null): void {
    this.idleName = name;
  }

  /**
   * Play a motion; a new call force-interrupts and cross-fades from the previous one.
   * One-shots fall back to the idle motion when they finish.
   */
  async playMotion(name: string, opts: { loop?: boolean; returnToIdle?: boolean; offset?: number; restart?: boolean } = {}): Promise<boolean> {
    const token = ++this.motionToken;
    const loop = opts.loop ?? false;
    const back = opts.returnToIdle ?? true;
    this.inflight++;
    try {
      // Start part-way through (seek): the engine begins a motion at (now - offsetTime). The motion object is cached
      // and shared, so the offset is always written, 0 included.
      const mm = this.internal.motionManager;
      const motion = await mm.loadMotion(name, 0);
      if (token !== this.motionToken) return false;
      if (motion) {
        const offset = Math.max(0, opts.offset ?? 0);
        const cycle = loop ? motion.getLoopDuration() : motion.getDuration();
        motion.setOffsetTime(cycle > 0 ? (loop ? offset % cycle : Math.min(offset, cycle)) : 0);
      }
      // The engine refuses to "start" the motion that is already current, which would leave a seek at the old position.
      if (opts.restart && (mm.state.currentGroup === name || mm.state.reservedGroup === name)) mm.stopAllMotions();
      return await this.model.motion(name, 0, this.rt.MotionPriority.FORCE, {
        loop,
        onFinish: () => {
          if (token === this.motionToken && !loop && back && this.idleName && this.idleName !== name) {
            void this.playMotion(this.idleName, { loop: true });
          }
        },
      });
    } finally {
      this.inflight--;
    }
  }

  /** Play `name` as the looping idle (and remember it for fallbacks). */
  async playIdle(name: string): Promise<boolean> {
    this.idleName = name;
    return this.playMotion(name, { loop: true });
  }

  /** Fetch + parse motion files ahead of time so the first play has no delay. */
  async preloadMotions(names: readonly string[]): Promise<void> {
    names.forEach((n) => this.preloadedMotions.add(n));
    await Promise.all(names.map((n) => this.internal.motionManager.loadMotion(n, 0)));
  }

  /** Fetch + parse expression files ahead of time (a scene change must not wait for a file while the stage is hidden). */
  async preloadExpressions(names: readonly string[]): Promise<void> {
    names.forEach((n) => this.preloadedExpressions.add(n));
    const em = this.internal.motionManager.expressionManager as unknown as { getExpressionIndex(n: string): number; loadExpression(i: number): Promise<unknown> } | undefined;
    if (!em) return;
    await Promise.all(
      names.map(async (n) => {
        const i = em.getExpressionIndex(n);
        if (i >= 0) await em.loadExpression(i).catch(() => undefined);
      }),
    );
  }

  /**
   * The Core heap view this model was created on. Models created before a heap re-allocation keep the old one and render frozen;
   * identity is compared by the library (staleModelIds).
   */
  heapToken(): ArrayBufferLike | null {
    const m = (this.internal.coreModel as unknown as CoreInternals)._model;
    return m.drawables?.vertexPositions?.[0]?.buffer ?? m.parameters.values?.buffer ?? null;
  }

  /** Sampled sum of the Core's output vertices: changes whenever the model's rendered shape changes (debug / tests). */
  vertexHash(): number {
    const core = this.internal.coreModel;
    let h = 0;
    const n = core.getDrawableCount();
    for (let d = 0; d < n; d += 3) {
      const v = core.getDrawableVertices(d);
      for (let i = 0; i < v.length; i += 7) h += v[i]!;
    }
    return h;
  }

  stopMotions(): void {
    this.motionToken++;
    this.internal.motionManager.stopAllMotions();
  }

  async setExpression(name: string | null): Promise<boolean> {
    if (name === null) {
      this.internal.motionManager.expressionManager?.resetExpression();
      return true;
    }
    return this.model.expression(name);
  }

  get lastFrameTime(): number {
    return this.lastNow;
  }

  destroy(): void {
    this.motionToken++;
    this.model.parent?.removeChild(this.model);
    this.model.destroy({ children: true, texture: true });
  }
}
