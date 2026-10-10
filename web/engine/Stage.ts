/**
 * The stage: the only place where a RenderState touches Pixi / Live2D.
 * Layers: scene root [ background | actors (camera transform, depth sorted) ] -> fade rect -> transition overlay.
 */
import { AlphaFilter, BlurFilter, ColorMatrixFilter, Container, Graphics, Rectangle, type Application, type Filter } from 'pixi.js';
import { placeActor } from '@shared/staging/ground';
import { screenToWorld, viewWorldHeight, worldToScreen, type BgInfo, type Pt, type Rect } from '@shared/staging/world';
import { lastBefore } from '@shared/timeline/sample';
import type { ActorRender, CompiledScene, RenderState } from '@shared/timeline/types';
import type { Live2DActor } from './Live2DActor';
import type { ModelLibrary } from './ModelLibrary';
import { BackgroundLayer } from './BackgroundLayer';
import { Camera } from './Camera';
import { Transitions } from './Transitions';
import { OuterGlowFilter, ScreenFxFilter } from './fx/FxFilters';
import { rollCoverScale } from '@shared/staging/roll';

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
  bg: BgInfo;
  modelIds: string[];
  /** Motion names each model will play (warmed before the scene is shown). */
  motions: Record<string, string[]>;
}

export function stageSceneOf(s: CompiledScene): StageScene {
  const ids = new Set<string>();
  const motions: Record<string, Set<string>> = {};
  for (const a of s.actors) {
    ids.add(a.initialModelId);
    a.models.forEach((m) => ids.add(m.modelId));
    for (const ev of a.motions) {
      const id = lastBefore(a.models, ev.at)?.modelId ?? a.initialModelId;
      (motions[id] ??= new Set()).add(ev.name);
    }
  }
  return {
    bgAssetId: s.bgAssetId,
    bg: s.bg,
    modelIds: [...ids],
    motions: Object.fromEntries(Object.entries(motions).map(([k, v]) => [k, [...v]])),
  };
}

interface Slot {
  castId: string;
  wrapper: Container;
  alpha: AlphaFilter;
  blur: BlurFilter;
  tint: ColorMatrixFilter;
  glow: OuterGlowFilter;
  actor: Live2DActor | null;
  eventKey: string;
  expression: string | null | undefined;
}

/** Share of the body box added around an actor's filter area so swaying hair is never clipped. */
const FILTER_PAD = 0.35;

export class Stage {
  readonly width: number;
  readonly height = STAGE_H;
  readonly sceneRoot = new Container();
  readonly camera: Camera;
  private readonly bgLayer: BackgroundLayer;
  get bgViewZoom(): number {
    return this.bgLayer.viewZoom;
  }
  private readonly actorLayer = new Container();
  private readonly fadeRect = new Graphics();
  private readonly transitions: Transitions;
  private readonly screenFx: ScreenFxFilter;
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
    this.bgLayer = new BackgroundLayer(this.width, this.height);
    this.actorLayer.sortableChildren = true;
    this.sceneRoot.addChild(this.bgLayer, this.actorLayer);
    this.sceneRoot.pivot.set(this.width / 2, this.height / 2);
    this.sceneRoot.position.set(this.width / 2, this.height / 2);
    this.screenFx = new ScreenFxFilter(aspect);
    this.fadeRect.rect(0, 0, this.width, this.height).fill(0xffffff);
    this.fadeRect.visible = false;
    this.transitions = new Transitions(app.renderer, this.width, this.height);
    app.stage.addChild(this.sceneRoot, this.fadeRect, this.transitions.layer);
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
    await Promise.all([
      this.library.backgroundTexture(scene.bgAssetId),
      ...scene.modelIds.map(async (id) => (await this.library.acquire(id)).preloadMotions(scene.motions[id] ?? [])),
    ]);
  }

  /** Switch to a prepared scene: clears actors, swaps the background. */
  async setScene(scene: StageScene): Promise<void> {
    await this.prepare(scene);
    this.library.pin(scene.modelIds);
    for (const slot of this.slots.values()) this.dropSlot(slot);
    this.slots.clear();
    this.scene = scene;
    this.bgLayer.setTexture(scene.bgAssetId, await this.library.backgroundTexture(scene.bgAssetId));
    this.camera.bg = scene.bg;
  }

  private dropSlot(slot: Slot): void {
    slot.actor?.stopMotions();
    slot.actor?.setMouth(0);
    slot.actor?.override.setTarget({ headYaw: 0, bodyYaw: 0, gazeX: 0, gazeY: 0 }, 0);
    slot.wrapper.removeChildren();
    slot.wrapper.destroy();
  }

  private slotFor(castId: string): Slot {
    let s = this.slots.get(castId);
    if (!s) {
      const wrapper = new Container();
      const blur = new BlurFilter({ strength: 0, quality: 4 });
      s = { castId, wrapper, alpha: new AlphaFilter({ alpha: 1 }), blur, tint: new ColorMatrixFilter(), glow: new OuterGlowFilter(), actor: null, eventKey: '', expression: undefined };
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
    this.bgLayer.apply(scene.bg, state.camera, state.background.framing, state.background.blur * px);

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
  }

  /** Emotion effects: Dutch roll (scaled up so the corners stay covered), vignette / glow filter. */
  private applyScreenFx(state: RenderState): void {
    const { fx, ui } = state;
    const roll = fx.roll;
    this.sceneRoot.rotation = (roll * Math.PI) / 180;
    this.sceneRoot.scale.set(rollCoverScale(roll, this.width / this.height));
    const p = ui.fx;
    const on = fx.anxiety > 0.002 || fx.glow > 0.002;
    if (on) {
      this.screenFx.set({
        anxiety: fx.anxiety, desat: p.anxietyDesat, inset: p.anxietyInset, dark: p.anxietyDarkness,
        glow: fx.glow, lift: p.glowBlackLift, chroma: p.glowChroma, bloom: p.glowBloom,
        smoke: p.anxietySmoke, tint: hexToRgb01(p.anxietyTint), time: state.t * p.anxietySmokeSpeed,
      });
      this.sceneRoot.filterArea = this.fxArea;
    }
    this.sceneRoot.filters = on ? [this.screenFx] : null;
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
    slot.wrapper.zIndex = Math.round((1 - a.depth) * 10000);

    if (a.motion) {
      const key = `${a.motion.eventAt}|${a.motion.name}`;
      if (key !== slot.eventKey || this.resyncMotions) {
        slot.eventKey = key;
        if (a.motion.loop) actor.setIdle(a.motion.name);
        // After a jump the motion must continue from where sequential playback would be; the physics catch-up
        // (settle) then advances model time by SETTLE seconds, which is taken off here.
        const offset = this.resyncMotions ? Math.max(0, a.motion.elapsed - this.settleLead) : 0;
        this.pending.push(actor.playMotion(a.motion.name, { loop: a.motion.loop, offset }));
      }
    }
    if (a.expression !== slot.expression) {
      slot.expression = a.expression;
      this.pending.push(actor.setExpression(a.expression));
    }
    actor.override.setTarget({ headYaw: a.head, bodyYaw: a.body, gazeX: a.gaze.x, gazeY: a.gaze.y }, 0);
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
      slot.blur.strength = a.blur * px * this.camera.pose.zoom * 0.6;
      filters.push(slot.blur);
    }
    slot.wrapper.filters = filters.length > 0 ? filters : null;
    if (filters.length > 0) {
      const b = pl.bodyBox;
      const padX = b.w * FILTER_PAD;
      const padY = b.h * 0.1;
      const cx = pl.headCenter.x;
      const cy = pl.headCenter.y;
      slot.wrapper.filterArea = new Rectangle(cx + (b.x - cx) * a.shiftS + sx - padX * a.shiftS, cy + (b.y - cy) * a.shiftS + a.shiftY - padY * a.shiftS, (b.w + padX * 2) * a.shiftS, (b.h + padY * 2) * a.shiftS);
    }
  }

  /** Atomic costume swap: the new model is already loaded, so there is never an empty frame. */
  private swapModel(slot: Slot, next: Live2DActor): void {
    if (slot.actor) {
      slot.actor.stopMotions();
      slot.actor.setMouth(0);
      slot.actor.override.setTarget({ headYaw: 0, bodyYaw: 0, gazeX: 0, gazeY: 0 }, 0);
      slot.wrapper.removeChild(slot.actor.model);
    }
    slot.wrapper.addChild(next.model);
    slot.actor = next;
    slot.eventKey = '';
    slot.expression = undefined;
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

  actorFor(castId: string): Live2DActor | null {
    return this.slots.get(castId)?.actor ?? null;
  }

  destroy(): void {
    for (const slot of this.slots.values()) this.dropSlot(slot);
    this.slots.clear();
    this.transitions.clear();
    this.sceneRoot.destroy({ children: true });
    this.fadeRect.destroy();
    this.transitions.layer.destroy({ children: true });
  }
}
