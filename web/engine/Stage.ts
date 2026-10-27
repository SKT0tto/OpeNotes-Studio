/**
 * The stage: the only place where a RenderState touches Pixi / Live2D.
 * Layers: scene root [ background | actors (camera transform, depth sorted) ] -> fade rect -> transition overlay.
 */
import { AlphaFilter, BlurFilter, ColorMatrixFilter, Container, Graphics, Rectangle, type Application, type Filter } from 'pixi.js';
import { placeActor } from '@shared/staging/ground';
import { baseScale, screenToWorld, viewWorldHeight, worldToScreen, type BgInfo, type Pt, type Rect } from '@shared/staging/world';
import { lastBefore } from '@shared/timeline/sample';
import type { ActorRender, CompiledScene, RenderState } from '@shared/timeline/types';
import type { Live2DActor } from './Live2DActor';
import type { ModelLibrary } from './ModelLibrary';
import { BackgroundLayer } from './BackgroundLayer';
import { QualityGovernor } from './QualityGovernor';
import { Camera } from './Camera';
import { Transitions } from './Transitions';
import { OuterGlowFilter, ScreenFxFilter } from './fx/FxFilters';
import { MemoryEdgeLayer } from './fx/MemoryEdge';
import { EyelidLayer } from './fx/Eyelids';
import { DAZE_BLUR, DAZE_DESAT, DIM_LEVEL, MEMORY_BG_BLUR } from '@shared/timeline/fxParams';
import { rollCoverScale } from '@shared/staging/roll';
import { MEMORY_TONES } from '@shared/schema/project';

export const STAGE_H = 720;
/** Renderer resolution of the player canvas: 720 logical rows x 1.5 = 1080 real rows. */
export const STAGE_RES = 1.5;

const hexToRgb01 = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** What the stage needs to know about the scene on screen. */
export interface StageScene {
  bgAssetId: string;
  /** Every background the scene shows (start background and background-track keys); all are loaded before the scene is shown. */
  bgAssetIds: string[];
  bg: BgInfo;
  modelIds: string[];
  /** The costume each person starts the scene in: the models whose textures are uploaded ahead of time (a later costume loads on demand). */
  startModelIds: string[];
  /** Costume changes inside the scene, by time (absolute seconds): each costume's textures are uploaded shortly before its first appearance. */
  laterModels: Array<{ modelId: string; at: number }>;
  /** Motion names each model will play (warmed before the scene is shown). */
  motions: Record<string, string[]>;
  /** Expression names each model will show (loaded before the scene is shown, so a scene change never waits for a file). */
  expressions: Record<string, string[]>;
  /** Travel camera system: neighbours stay on screen under strong blur, so the stage culls off-screen actors and blurs at half resolution. */
  travel?: boolean;
}

export function stageSceneOf(s: CompiledScene): StageScene {
  const ids = new Set<string>();
  const start = new Set<string>();
  const later = new Map<string, number>();
  const motions: Record<string, Set<string>> = {};
  const expressions: Record<string, Set<string>> = {};
  for (const a of s.actors) {
    ids.add(a.initialModelId);
    start.add(a.initialModelId);
    for (const m of a.models) {
      ids.add(m.modelId);
      later.set(m.modelId, Math.min(later.get(m.modelId) ?? Infinity, m.at));
    }
    for (const ev of a.motions) {
      const id = lastBefore(a.models, ev.at)?.modelId ?? a.initialModelId;
      (motions[id] ??= new Set()).add(ev.name);
    }
    for (const ev of a.expressions) {
      if (ev.name === null) continue;
      const id = lastBefore(a.models, ev.at)?.modelId ?? a.initialModelId;
      (expressions[id] ??= new Set()).add(ev.name);
    }
  }
  const flat = (m: Record<string, Set<string>>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
  return {
    bgAssetId: s.bgAssetId,
    bgAssetIds: [...new Set(s.bgSegments.map((g) => g.assetId))],
    bg: s.bg,
    modelIds: [...ids],
    startModelIds: [...start],
    laterModels: [...later].filter(([id]) => !start.has(id)).map(([modelId, at]) => ({ modelId, at })).sort((x, y) => x.at - y.at),
    motions: flat(motions),
    expressions: flat(expressions),
    ...(s.cameraSystem === 'travel' ? { travel: true } : {}),
  };
}

/** A costume change is prepared this many seconds ahead (about two beats), and forgotten this long after it happened. */
const PREUPLOAD_AHEAD = 1.5;
const PREUPLOAD_KEEP = 0.5;

interface Slot {
  castId: string;
  wrapper: Container;
  alpha: AlphaFilter;
  blur: BlurFilter;
  tint: ColorMatrixFilter;
  glow: OuterGlowFilter;
  /** The wrapper's filter area, reused every frame (a new Rectangle per frame is garbage and gives the filter system a new object to look at). */
  area: Rectangle;
  /** Frames since this actor was last advanced while hidden. */
  hiddenFrames: number;
  actor: Live2DActor | null;
  eventKey: string;
  expression: string | null | undefined;
  /** The model was rebuilt in place (Core heap repair): restart its motion at the elapsed time instead of at 0. */
  resyncOnce?: boolean;
}

/** Logical filter-area sizes (width, height) that reach the texture pool buckets an actor's filter chain asks for. */
const WARM_AREAS: Array<[number, number]> = [[256, 512], [512, 512], [512, 768], [768, 1024], [1024, 1024], [512, 1400], [1280, 720]];

/** A hidden actor is advanced once in this many frames (about 15 Hz at 60 fps). */
const HIDDEN_EVERY = 4;

/** Ticker priorities that bracket the whole frame (the Pixi application renders at LOW = -25). */
const FRAME_FIRST = 1000;
const FRAME_LAST = -1000;

/** Share of the body box added around an actor's filter area so swaying hair is never clipped. */
const FILTER_PAD = 0.35;

export class Stage {
  readonly width: number;
  readonly height = STAGE_H;
  readonly sceneRoot = new Container();
  readonly camera: Camera;
  private readonly bgLayer: BackgroundLayer;
  /** Textures of the backgrounds of the prepared scenes (filled by `prepare`, read by `apply`). */
  private readonly bgTextures = new Map<string, import('pixi.js').Texture>();
  /** Backgrounds of scenes prepared ahead (the next scene) while the current one is on screen: kept, not released. */
  private readonly aheadBg = new Set<string>();
  /** Released backgrounds waiting until no sprite draws them any more (destroyed right after a frame that does not use them). */
  private doomed: Array<{ id: string; url: string; texture: import('pixi.js').Texture }> = [];
  get bgViewZoom(): number {
    return this.bgLayer.viewZoom;
  }
  private readonly actorLayer = new Container();
  private readonly fadeRect = new Graphics();
  /** The inner-voice dim: a black veil between the background and the actors, so only the background darkens. */
  private readonly dimRect = new Graphics();
  private readonly transitions: Transitions;
  private readonly screenFx: ScreenFxFilter;
  private readonly memoryEdge: MemoryEdgeLayer;
  private readonly eyelids: EyelidLayer;
  /** The daze blur of the scene root (created on first use: a project without the effect never builds it). */
  private dazeBlur: BlurFilter | null = null;
  private readonly slots = new Map<string, Slot>();
  private scene: StageScene | null = null;
  private lastPlacement = new Map<string, ReturnType<typeof placeActor>>();
  private lastBoxes = new Map<string, { head: Rect; body: Rect; opacity: number }>();
  private pending: Array<Promise<unknown>> = [];
  private readonly fxArea: Rectangle;

  constructor(
    readonly app: Application,
    readonly library: ModelLibrary,
    /** Window aspect (width / height): 16:9 in the editor; the play page can show the original's wider frame. Compositions stay proportional to the height. */
    readonly aspect: number = 16 / 9,
  ) {
    this.width = Math.round(this.height * aspect);
    this.fxArea = new Rectangle(0, 0, this.width, this.height);
    this.camera = new Camera({ width: this.width, height: this.height, ground: { horizonY: 0, floorY: 1 } }, this.height, aspect);
    this.bgLayer = new BackgroundLayer(this.width, this.height, app.renderer);
    this.actorLayer.sortableChildren = true;
    this.dimRect.rect(0, 0, this.width, this.height).fill(0x000000);
    this.dimRect.visible = false;
    this.sceneRoot.addChild(this.bgLayer, this.dimRect, this.actorLayer);
    this.sceneRoot.pivot.set(this.width / 2, this.height / 2);
    this.sceneRoot.position.set(this.width / 2, this.height / 2);
    this.screenFx = new ScreenFxFilter(aspect);
    this.fadeRect.rect(0, 0, this.width, this.height).fill(0xffffff);
    this.fadeRect.visible = false;
    this.transitions = new Transitions(app.renderer, this.width, this.height);
    this.memoryEdge = new MemoryEdgeLayer(this.width, this.height);
    this.eyelids = new EyelidLayer(this.width, this.height);
    app.stage.addChild(this.sceneRoot, this.memoryEdge.layer, this.eyelids.layer, this.fadeRect, this.transitions.layer);
    // Actors waiting off screen (opacity 0) are not rendered, so the engine would not advance them: keep them living.
    this.tickHidden = () => {
      if (!this.sceneRoot.visible) return;
      // Somebody who cannot be seen (fully transparent, or outside the view of a travel shot) is advanced every HIDDEN_EVERY-th frame with
      // the time of all of them, so the Core update (the largest cost per model) is paid a quarter as often. Travel scenes only: a
      // classic shot's physics must step exactly as before (`globalThis.__hiddenThrottle` overrides, for the pixel comparison).
      const throttle = (globalThis as { __hiddenThrottle?: boolean }).__hiddenThrottle ?? this.scene?.travel === true;
      for (const slot of this.slots.values()) {
        if (!slot.actor || slot.wrapper.visible) {
          slot.hiddenFrames = 0;
          continue;
        }
        if (throttle && ++slot.hiddenFrames < (this.lowQuality ? HIDDEN_EVERY * 2 : HIDDEN_EVERY)) continue;
        slot.hiddenFrames = 0;
        slot.actor.updateHidden();
      }
    };
    app.ticker.add(this.markFrameStart, undefined, FRAME_FIRST);
    app.ticker.add(this.tickHidden);
    app.ticker.add(this.markFrameEnd, undefined, FRAME_LAST);
    this.warmFilters();
    // A model rebuilt after a Core heap re-allocation takes the old instance's place at once (the player may be paused: no frame follows).
    this.offReload = library.onReload((fresh, old) => {
      if (!old) return;
      for (const slot of this.slots.values()) {
        if (slot.actor !== old) continue;
        fresh.model.position.copyFrom(old.model.position);
        fresh.model.scale.copyFrom(old.model.scale);
        this.swapModel(slot, fresh);
      }
    });
  }
  private readonly offReload: () => void;
  /**
   * Automatic fallback for slow machines, travel scenes only (a classic frame never changes): when the frames keep taking over their
   * budget in CPU work for a few seconds, blurs run at a quarter of the resolution and hidden actors are advanced at 7.5 Hz; it goes
   * back to normal after a longer spell of headroom (see `QualityGovernor`: the work time decides, never the frame interval, so a 30 fps
   * cap does not trigger it). A strongly blurred picture does not show the difference. `globalThis.__quality = 'low' | 'normal'` forces either.
   */
  get lowQuality(): boolean {
    return this.governor.low;
  }
  private readonly governor = new QualityGovernor();
  private frameStart = 0;
  /** First ticker listener of a frame: the clock for the frame's work time. */
  private readonly markFrameStart = (): void => {
    this.frameStart = performance.now();
  };
  /** Last ticker listener of a frame (after the render call): the frame's work time goes to the governor. */
  private readonly markFrameEnd = (): void => {
    const force = (globalThis as { __quality?: string }).__quality;
    const travel = this.scene?.travel === true;
    if (force) {
      this.governor.low = force === 'low' && travel;
      return;
    }
    this.governor.sample(performance.now() - this.frameStart, this.app.ticker.deltaMS, travel);
  };
  private readonly tickHidden: () => void;

  /**
   * Compile every filter program the stage uses and fill the filter texture pool for the sizes an actor's filter area takes, once, before
   * the first frame. Without it the first fade / blur / move of a session stalls for 20 - 40 ms on shader compilation and texture
   * allocation, right when the shot starts to move. Draws only into the (still empty) canvas, which is cleared afterwards.
   */
  private warmFilters(): void {
    const r = this.app.renderer;
    try {
      const holder = new Container();
      holder.addChild(new Graphics().rect(0, 0, 8, 8).fill(0xffffff));
      const blur = new BlurFilter({ strength: 6, quality: 4 });
      const blurHalf = new BlurFilter({ strength: 6, quality: 3 });
      blurHalf.resolution = 0.5;
      const tint = new ColorMatrixFilter();
      tint.brightness(0.7, false);
      const glow = new OuterGlowFilter();
      glow.set(8, 0.5);
      const chains: Filter[][] = [[tint, glow, new AlphaFilter({ alpha: 0.5 }), blur], [new AlphaFilter({ alpha: 0.5 }), blurHalf], [tint, new AlphaFilter({ alpha: 0.5 })]];
      for (const [w, h] of WARM_AREAS) {
        holder.filterArea = new Rectangle(0, 0, w, h);
        for (const chain of chains) {
          holder.filters = chain;
          r.render({ container: holder });
        }
      }
      holder.filters = null;
      holder.destroy({ children: true });
      blur.destroy();
      blurHalf.destroy();
      glow.destroy();
      tint.destroy();
      r.clear();
    } catch (e) {
      console.warn('filter warm-up skipped', e);
    }
  }

  get sceneInfo(): StageScene | null {
    return this.scene;
  }

  get transitionActive(): boolean {
    return this.transitions.hasSnapshot;
  }

  /** Hide / show the whole scene (used while a scene is being entered so half-set-up poses are never visible). */
  setSceneVisible(v: boolean): void {
    this.sceneRoot.visible = v;
  }

  /** Freeze the scene on screen (for a following transition). */
  captureSnapshot(): void {
    this.transitions.capture(this.sceneRoot);
  }

  /** Load the background texture and every model the scene may use (all costumes). */
  async prepare(scene: StageScene): Promise<void> {
    this.library.pin([...(this.scene?.modelIds ?? []), ...scene.modelIds]);
    if (scene !== this.scene) for (const id of scene.bgAssetIds) this.aheadBg.add(id);
    await Promise.all([
      ...scene.bgAssetIds.map(async (id) => void this.bgTextures.set(id, await this.library.backgroundTexture(id))),
      ...scene.modelIds.map(async (id) => {
        const actor = await this.library.acquire(id);
        await Promise.all([actor.preloadMotions(scene.motions[id] ?? []), actor.preloadExpressions(scene.expressions[id] ?? [])]);
      }),
    ]);
  }

  /** Switch to a prepared scene: clears actors, swaps the background. */
  async setScene(scene: StageScene): Promise<void> {
    await this.prepare(scene);
    this.library.pin(scene.modelIds);
    // Only the costumes the scene starts in are uploaded now; a costume worn later is uploaded a little ahead of its first appearance (`preuploadAhead`).
    for (const id of scene.startModelIds) this.library.loaded(id)?.preupload(this.app.renderer as never);
    this.upcoming = scene.laterModels.slice();
    for (const slot of this.slots.values()) this.dropSlot(slot);
    this.slots.clear();
    this.scene = scene;
    this.camera.bg = scene.bg;
    this.aheadBg.clear();
    this.releaseBackgrounds();
  }

  /** Costume changes of the scene on screen whose textures are not uploaded yet (by time). */
  private upcoming: Array<{ modelId: string; at: number }> = [];

  /**
   * Upload the textures of the next costume change that is within PREUPLOAD_AHEAD seconds - one texture per frame, so no frame carries a
   * whole costume. Called once per applied frame; a costume changed into after a jump is simply drawn the usual lazy way.
   */
  private preuploadAhead(t: number): void {
    const up = this.upcoming;
    while (up.length > 0 && up[0]!.at <= t - PREUPLOAD_KEEP) up.shift(); // already worn (or jumped over)
    for (let i = 0; i < up.length; i++) {
      const c = up[i]!;
      if (c.at - t > PREUPLOAD_AHEAD) break;
      const actor = this.library.loaded(c.modelId);
      if (!actor || actor.preupload(this.app.renderer as never, 1) === 0) {
        up.splice(i, 1);
        if (actor) return; // this frame's upload is spent
        i--;
        continue;
      }
      return;
    }
  }

  /** Load the backgrounds of a scene that is likely to come next (just the pictures; its models wait for the real prefetch). */
  async preloadBackgrounds(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.aheadBg.add(id);
    await Promise.all(ids.map(async (id) => void this.bgTextures.set(id, await this.library.backgroundTexture(id))));
  }

  /**
   * Free the GPU copy of every background that belongs neither to the scene on screen nor to the one prepared ahead (a 2048 x 1152
   * picture is about 9 MB; a long project otherwise keeps every picture it ever showed). The destroy waits until a frame was drawn
   * without the picture, so a sprite never samples a destroyed texture.
   */
  private releaseBackgrounds(): void {
    const keep = new Set([...(this.scene?.bgAssetIds ?? []), ...this.aheadBg]);
    for (const id of this.library.loadedBackgrounds()) {
      if (keep.has(id)) continue;
      const texture = this.bgTextures.get(id);
      const url = this.library.forgetBackground(id);
      this.bgTextures.delete(id);
      if (texture && url) this.doomed.push({ id, url, texture });
    }
  }

  private flushDoomed(): void {
    if (this.doomed.length === 0) return;
    const rest: typeof this.doomed = [];
    for (const d of this.doomed) {
      if (this.bgLayer.drawsTexture(d.texture)) rest.push(d);
      else if (this.library.loadedBackgrounds().includes(d.id)) continue; // wanted again meanwhile: the cache entry now belongs to the new load
      else this.library.unloadBackground(d.url);
    }
    this.doomed = rest;
  }

  private dropSlot(slot: Slot): void {
    slot.actor?.stopMotions();
    slot.actor?.setMouth(0);
    slot.actor?.override.setTarget({ headYaw: 0, headPitch: 0, bodyYaw: 0, gazeX: 0, gazeY: 0 }, 0);
    slot.wrapper.removeChildren();
    slot.wrapper.destroy();
  }

  private slotFor(castId: string): Slot {
    let s = this.slots.get(castId);
    if (!s) {
      const wrapper = new Container();
      const blur = new BlurFilter({ strength: 0, quality: 4 });
      s = { castId, wrapper, alpha: new AlphaFilter({ alpha: 1 }), blur, tint: new ColorMatrixFilter(), glow: new OuterGlowFilter(), area: new Rectangle(), hiddenFrames: 0, actor: null, eventKey: '', expression: undefined };
      this.actorLayer.addChild(wrapper);
      this.slots.set(castId, s);
    }
    return s;
  }

  /** Apply one frame. The scene must be set and its models prepared. */
  apply(state: RenderState): void {
    const scene = this.scene;
    if (!scene) throw new Error('Stage.apply before setScene');
    this.camera.set(state.camera);
    const lt = this.camera.layerTransform();
    this.actorLayer.scale.set(lt.scale);
    this.actorLayer.position.set(lt.x, lt.y);
    const px = this.height / 720;
    const bgState = state.background;
    const main = this.bgTextures.get(bgState.assetId);
    if (main) {
      const nx = bgState.next ? this.bgTextures.get(bgState.next.assetId) : undefined;
      this.bgLayer.apply(
        scene.bg, state.camera, bgState.blur * px + (state.fx.memory ?? 0) * MEMORY_BG_BLUR * this.height,
        { assetId: bgState.assetId, texture: main, framing: bgState.framing, src: bgState.src },
        bgState.next && nx ? { assetId: bgState.next.assetId, texture: nx, framing: bgState.next.framing, src: bgState.next.src, alpha: bgState.next.alpha } : undefined,
        scene.travel === true ? (this.lowQuality ? 0.25 : true) : false,
        // no cache on a rolled screen (the picture is clipped differently) or under the screen effects (they amplify the one-level rounding of the cache)
        state.fx.roll === 0 && state.fx.anxiety <= 0.002 && state.fx.glow <= 0.002 && (state.fx.memory ?? 0) <= 0.002 && (state.fx.daze ?? 0) <= 0.002 && !(globalThis as { __noBgCache?: boolean }).__noBgCache,
      );
    }

    const present = new Set(state.actors.map((a) => a.castId));
    for (const [id, slot] of this.slots) {
      if (!present.has(id)) {
        this.dropSlot(slot);
        this.slots.delete(id);
      }
    }
    for (const a of state.actors) this.applyActor(this.slotFor(a.castId), a, scene.bg, px, state);
    this.resyncMotions = false;

    this.fadeRect.visible = state.fade.alpha > 0.001;
    this.fadeRect.tint = state.fade.color === 'black' ? 0x000000 : 0xffffff;
    this.fadeRect.alpha = state.fade.alpha;

    this.applyScreenFx(state);
    if (state.transition) this.transitions.update(state.transition.kind, state.transition.progress, state.transition);
    else this.transitions.clear();
    this.flushDoomed();
    this.preuploadAhead(state.t);
  }

  /** Emotion effects: Dutch roll (scaled up so the corners stay covered), vignette / glow filter. */
  private applyScreenFx(state: RenderState): void {
    const { fx, ui } = state;
    const roll = fx.roll;
    this.sceneRoot.rotation = (roll * Math.PI) / 180;
    this.sceneRoot.scale.set(rollCoverScale(roll, this.width / this.height));
    const p = ui.fx;
    const memory = fx.memory ?? 0;
    this.memoryEdge.set(memory, fx.memoryEdge ?? 'fog');
    const dim = (fx.dim ?? 0) * DIM_LEVEL;
    this.dimRect.visible = dim > 0.001;
    this.dimRect.alpha = dim;
    const daze = fx.daze ?? 0;
    this.eyelids.set(fx.blink ?? 0);
    const on = fx.anxiety > 0.002 || fx.glow > 0.002 || memory > 0.002 || daze > 0.002;
    if (on) {
      this.screenFx.set({
        anxiety: fx.anxiety, desat: p.anxietyDesat, inset: p.anxietyInset, dark: p.anxietyDarkness,
        glow: fx.glow, lift: p.glowBlackLift, chroma: p.glowChroma, bloom: p.glowBloom,
        smoke: p.anxietySmoke, tint: hexToRgb01(p.anxietyTint), time: state.t * p.anxietySmokeSpeed,
        memory, tone: Math.max(0, MEMORY_TONES.indexOf(fx.memoryTone ?? 'cool')), dim: 0, sat: 1 - DAZE_DESAT * daze,
      });
      this.sceneRoot.filterArea = this.fxArea;
    }
    if (daze > 0.002) {
      // full-screen blur (the original's depth of field focused at 0.1 m); a mild blur needs no more than half the resolution
      const blur = (this.dazeBlur ??= new BlurFilter({ strength: 0, quality: 3 }));
      blur.strength = daze * DAZE_BLUR * this.height;
      blur.resolution = 0.5;
      this.sceneRoot.filters = [blur, this.screenFx];
    } else this.sceneRoot.filters = on ? [this.screenFx] : null;
  }

  private applyActor(slot: Slot, a: ActorRender, bg: BgInfo, px: number, state: RenderState): void {
    const next = this.library.loaded(a.modelId);
    if (next && slot.actor !== next) this.swapModel(slot, next);
    const actor = slot.actor;
    if (!actor) return;

    const pl = placeActor(this.library.calibrationSync(a.modelId), { slot: a.slot, depth: a.depth }, bg);
    this.lastPlacement.set(a.castId, pl);
    {
      // world boxes after the shot arrangement (scale about the head centre, then shift): what the editor's handles sit on
      const hc = pl.headCenter;
      const fit = (r: Rect): Rect => ({ x: hc.x + (r.x - hc.x) * a.shiftS + a.slideH * viewWorldHeight(bg) + a.shiftX, y: hc.y + (r.y - hc.y) * a.shiftS + a.shiftY, w: r.w * a.shiftS, h: r.h * a.shiftS });
      this.lastBoxes.set(a.castId, { head: fit(pl.headBox), body: fit(pl.bodyBox), opacity: a.opacity });
    }
    // Shot arrangement: scale about the head centre, then move (see solveShotDetailed); sx / sy also carry the slide-in.
    const k = pl.k * a.shiftS;
    const sx = a.slideH * viewWorldHeight(bg) + a.shiftX;
    actor.model.scale.set(k); // always positive: facing never comes from mirroring
    actor.model.position.set(pl.headCenter.x + (pl.pos.x - pl.headCenter.x) * a.shiftS + sx, pl.headCenter.y + (pl.pos.y - pl.headCenter.y) * a.shiftS + a.shiftY);
    slot.wrapper.zIndex = a.shiftZ > 0.5 ? 20000 + Math.round(a.shiftZ) : Math.round((1 - a.depth) * 10000);

    if (a.motion) {
      const key = `${a.motion.eventAt}|${a.motion.name}`;
      const resync = this.resyncMotions || slot.resyncOnce === true;
      if (key !== slot.eventKey || resync) {
        slot.resyncOnce = false;
        slot.eventKey = key;
        if (a.motion.loop) actor.setIdle(a.motion.name);
        // After a jump the motion must continue from where sequential playback would be; the physics catch-up
        // (settle) then advances model time by SETTLE seconds, which is taken off here.
        const offset = resync ? Math.max(0, a.motion.elapsed - (this.resyncMotions ? this.settleLead : 0)) : 0;
        this.pending.push(actor.playMotion(a.motion.name, { loop: a.motion.loop, offset, restart: resync }));
      }
    }
    if (a.expression !== slot.expression) {
      slot.expression = a.expression;
      this.pending.push(actor.setExpression(a.expression));
    }
    actor.override.setTarget({ headYaw: a.head, headPitch: a.headPitch ?? 0, bodyYaw: a.body, gazeX: a.gaze.x, gazeY: a.gaze.y }, 0);
    actor.setMouth(a.mouth);

    // Whole-actor alpha / blur through filters on the wrapper (composited first, then faded), never per-mesh alpha.
    slot.wrapper.visible = a.opacity > 0.002;
    const filters: Filter[] = [];
    if (a.tint < 0.999) {
      slot.tint.reset();
      slot.tint.brightness(a.tint, false);
      filters.push(slot.tint);
    }
    if (state.fx.anxiety > 0.01 && state.ui.fx.anxietyGlow > 0) {
      slot.glow.set(state.ui.fx.anxietyGlow * this.height * this.app.renderer.resolution * this.camera.pose.zoom * state.ui.fx.anxietyGlowScale, Math.min(1, state.fx.anxiety));
      filters.push(slot.glow);
    }
    if (a.opacity < 0.999) {
      slot.alpha.alpha = a.opacity;
      filters.push(slot.alpha);
    }
    if (a.blur * px > 0.05) {
      // travel: the blur is already in screen pixels (the same unit as the background's); classic scales a depth-of-field share with the zoom
      slot.blur.strength = this.scene?.travel ? a.blur * px : a.blur * px * this.camera.pose.zoom * 0.6;
      if (this.scene?.travel) {
        // a blurred picture needs no full resolution: a quarter of the pixels, and one pass less for a very strong blur
        slot.blur.resolution = this.lowQuality ? 0.25 : 0.5;
        slot.blur.quality = slot.blur.strength > 6 ? 3 : 4;
      }
      filters.push(slot.blur);
    }
    slot.wrapper.filters = filters.length > 0 ? filters : null;
    if (filters.length > 0) {
      const b = pl.bodyBox;
      const padX = b.w * FILTER_PAD;
      const padY = b.h * 0.1;
      const cx = pl.headCenter.x;
      const cy = pl.headCenter.y;
      slot.area.x = cx + (b.x - cx) * a.shiftS + sx - padX * a.shiftS;
      slot.area.y = cy + (b.y - cy) * a.shiftS + a.shiftY - padY * a.shiftS;
      slot.area.width = (b.w + padX * 2) * a.shiftS;
      slot.area.height = (b.h + padY * 2) * a.shiftS;
      slot.wrapper.filterArea = slot.area;
    }
    if (this.scene?.travel && slot.wrapper.visible) this.cullToView(slot, pl, a, sx, bg, filters.length > 0);
  }

  /**
   * Travel scenes keep the neighbours on stage, and with a close camera their bodies are far larger than the screen. An actor whose area
   * lies outside the view is not drawn at all (it keeps animating, see tickHidden); the filter area of the others is clipped to the view
   * (plus margin for the blur and the Dutch roll), so a blur only touches the pixels that can be seen.
   */
  private cullToView(slot: Slot, pl: ReturnType<typeof placeActor>, a: ActorRender, sx: number, bg: BgInfo, hasFilters: boolean): void {
    const b = pl.bodyBox;
    const cx = pl.headCenter.x;
    const cy = pl.headCenter.y;
    const padX = b.w * FILTER_PAD;
    const padY = b.h * 0.1;
    const x0 = cx + (b.x - cx) * a.shiftS + sx - padX * a.shiftS;
    const y0 = cy + (b.y - cy) * a.shiftS + a.shiftY - padY * a.shiftS;
    const x1 = x0 + (b.w + padX * 2) * a.shiftS;
    const y1 = y0 + (b.h + padY * 2) * a.shiftS;
    const cam = this.camera.pose;
    const s = baseScale(bg, this.height) * cam.zoom;
    const marginX = (this.width * 0.15) / s;
    const marginY = (this.height * 0.15) / s;
    const vx0 = cam.x - this.width / 2 / s - marginX;
    const vx1 = cam.x + this.width / 2 / s + marginX;
    const vy0 = cam.y - this.height / 2 / s - marginY;
    const vy1 = cam.y + this.height / 2 / s + marginY;
    const ix0 = Math.max(x0, vx0);
    const iy0 = Math.max(y0, vy0);
    const ix1 = Math.min(x1, vx1);
    const iy1 = Math.min(y1, vy1);
    if (ix1 <= ix0 || iy1 <= iy0) {
      slot.wrapper.visible = false;
      return;
    }
    if (hasFilters) {
      slot.area.x = ix0;
      slot.area.y = iy0;
      slot.area.width = ix1 - ix0;
      slot.area.height = iy1 - iy0;
      slot.wrapper.filterArea = slot.area;
    }
  }

  /** Atomic costume swap: the new model is already loaded, so there is never an empty frame. */
  private swapModel(slot: Slot, next: Live2DActor): void {
    const rebuilt = slot.actor?.id === next.id; // same model, new instance: the library repaired a Core heap re-allocation
    if (slot.actor) {
      slot.actor.stopMotions();
      slot.actor.setMouth(0);
      slot.actor.override.setTarget({ headYaw: 0, headPitch: 0, bodyYaw: 0, gazeX: 0, gazeY: 0 }, 0);
      slot.wrapper.removeChild(slot.actor.model);
    }
    next.dropPendingTime(); // time piled up while it was not on stage must not be applied in one step
    slot.wrapper.addChild(next.model);
    slot.actor = next;
    slot.eventKey = '';
    slot.expression = undefined;
    slot.resyncOnce = rebuilt;
    next.setIdle(null);
    if (rebuilt) next.settle(0.3);
  }

  private resyncMotions = false;
  private settleLead = 0;

  /**
   * The next `apply` restarts every motion at its elapsed time (seek / scene entry); `lead` is the model time that
   * `settle` will simulate afterwards.
   */
  resync(lead = 0): void {
    this.resyncMotions = true;
    this.settleLead = lead;
  }

  /** Resolves once motions / expressions started by the last `apply` calls are actually running. */
  async whenSettled(): Promise<void> {
    const p = this.pending;
    this.pending = [];
    await Promise.all(p);
  }

  /** Let physics catch up after a seek / scene entry so hair does not whip on the first visible frame. */
  settle(seconds = 0.5): void {
    for (const slot of this.slots.values()) slot.actor?.settle(seconds);
  }

  /** Head / body boxes of the people on screen, in stage pixels (0..width x 0..height), front-most last. */
  actorGeometry(): Array<{ castId: string; head: Rect; body: Rect; headCenter: Pt; depth: number }> {
    const bg = this.scene?.bg;
    if (!bg) return [];
    const cam = this.camera.pose;
    const pt = (p: Pt) => worldToScreen(bg, cam, this.height, p);
    const box = (r: Rect): Rect => {
      const a = pt({ x: r.x, y: r.y });
      const b = pt({ x: r.x + r.w, y: r.y + r.h });
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    };
    const out = [];
    for (const [castId, b] of this.lastBoxes) {
      if (!this.slots.has(castId) || b.opacity < 0.05) continue;
      const head = box(b.head);
      out.push({ castId, head, body: box(b.body), headCenter: { x: head.x + head.w / 2, y: head.y + head.h / 2 }, depth: this.lastPlacement.get(castId)?.depth ?? 0 });
    }
    return out.sort((x, y) => y.depth - x.depth);
  }

  /** Stage pixel -> world point under the current camera. */
  stageToWorld(p: Pt): Pt | null {
    const bg = this.scene?.bg;
    return bg ? screenToWorld(bg, this.camera.pose, this.height, p) : null;
  }

  actorPlacement(castId: string) {
    return this.lastPlacement.get(castId) ?? null;
  }

  /** What is really on screen right now (for tests): the scene root's visibility and the people attached to it. */
  probe(): { sceneVisible: boolean; people: string[]; hasBackground: boolean } {
    const people = [...this.slots.values()].filter((s) => s.actor && s.wrapper.visible && s.wrapper.parent && s.actor.model.parent === s.wrapper).map((s) => s.castId);
    return { sceneVisible: this.sceneRoot.visible, people, hasBackground: this.scene !== null };
  }

  actorFor(castId: string): Live2DActor | null {
    return this.slots.get(castId)?.actor ?? null;
  }

  destroy(): void {
    this.offReload();
    this.app.ticker.remove(this.tickHidden);
    this.app.ticker.remove(this.markFrameStart);
    this.app.ticker.remove(this.markFrameEnd);
    for (const slot of this.slots.values()) this.dropSlot(slot);
    this.slots.clear();
    this.transitions.clear();
    this.sceneRoot.destroy({ children: true });
    this.fadeRect.destroy();
    this.memoryEdge.destroy();
    this.eyelids.destroy();
    this.dazeBlur?.destroy();
    this.transitions.layer.destroy({ children: true });
  }
}
