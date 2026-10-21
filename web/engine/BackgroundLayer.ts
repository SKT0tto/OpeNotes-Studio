import { BlurFilter, Container, RenderTexture, Sprite, type Renderer, type Texture } from 'pixi.js';
import { baseScale, bgView, type BgFraming, type BgInfo, type CameraPose } from '@shared/staging/world';

/** One picture to draw: its texture and own pixel size (it is fitted over the world of the scene, "cover"). */
export interface BgPicture {
  assetId: string;
  texture: Texture;
  framing: BgFraming;
  src: { width: number; height: number };
}

/** A still shot is drawn from the blur cache once its picture, placement and blur have stayed the same this many frames. */
const CACHE_AFTER = 2;

/**
 * Background as its own layer: it follows the camera with parallax (zoom^0.85) and is clamped so the viewport is
 * always covered. Blur (depth of field) is applied with the filter clipped to nothing, so the screen edges blur
 * with real background pixels instead of fading to transparent.
 *
 * P20: a scene may change its background. The world (camera, ground, people) stays that of the scene's base background; another picture
 * of another size is scaled to cover the same world rectangle, so nothing on stage moves when the picture changes. A second sprite
 * draws the incoming picture during a crossfade.
 */
export class BackgroundLayer extends Container {
  private readonly sprite = new Sprite();
  private readonly nextSprite = new Sprite();
  private readonly blur = new BlurFilter({ strength: 0, quality: 4 });
  private readonly blurNext = new BlurFilter({ strength: 0, quality: 4 });
  private readonly blurRes = this.blur.resolution;
  private assetId: string | null = null;
  /**
   * Blur cache (classic shots): a still shot shows the same blurred picture frame after frame, so once the picture, placement and blur
   * have stayed identical for CACHE_AFTER frames, the blurred result is rendered into a texture once and drawn as one plain sprite
   * (the eight full-screen blur passes are paid only when something changes). The picture of the cache is the same render the direct path
   * does, so its colours differ by at most one level of 8-bit rounding. Off while the screen is rolled (Dutch angle) or under a screen effect (the Stage decides), while two
   * pictures cross-fade, and in travel scenes (their blur is half resolution and changes all the time anyway).
   */
  private readonly renderer: Renderer | null;
  private cacheRoot: Container | null = null;
  private cacheSource: Sprite | null = null;
  private cacheTarget: RenderTexture | null = null;
  private cacheView: Sprite | null = null;
  private cacheValid = false;
  private stableFrames = 0;
  private readonly key = { tex: null as Texture | null, x: NaN, y: NaN, scale: NaN, blur: NaN, res: NaN as number | 'inherit', rr: NaN };
  /** Frames drawn from the cache / frames with a blur that could have been (debug / tests). */
  cacheStats = { hits: 0, renders: 0, frames: 0 };
  /** Effective background magnification of the last frame (debug / tests). */
  viewZoom = 1;

  constructor(
    private readonly viewportW: number,
    private readonly viewportH: number,
    renderer: Renderer | null = null,
  ) {
    super();
    this.renderer = renderer;
    if (import.meta.env.DEV) (globalThis as { __bgCache?: unknown }).__bgCache = this.cacheStats;
    this.sprite.anchor.set(0.5);
    this.nextSprite.anchor.set(0.5);
    this.nextSprite.visible = false;
    this.addChild(this.sprite, this.nextSprite);
  }

  /** Whether a sprite of this layer still points at the texture (it must not be destroyed then). */
  drawsTexture(t: Texture): boolean {
    return this.sprite.texture === t || this.nextSprite.texture === t;
  }

  get currentAsset(): string | null {
    return this.assetId;
  }

  /** Both pictures currently on screen (debug / tests). */
  get shown(): { main: string | null; next: string | null; nextAlpha: number } {
    return { main: this.assetId, next: this.nextSprite.visible ? ((this.nextSprite as unknown as { __asset?: string }).__asset ?? null) : null, nextAlpha: this.nextSprite.alpha };
  }

  /**
   * `blurPx` is in screen pixels. `world` is the scene's base background; `main` / `next` are the pictures to draw.
   * `halfResBlur` (travel scenes): the blur runs at half resolution; a strongly blurred picture needs no more.
   */
  apply(world: BgInfo, cam: CameraPose, blurPx: number, main: BgPicture, next?: BgPicture & { alpha: number }, halfResBlur: boolean | number = false, allowCache = true): void {
    this.blur.resolution = halfResBlur === false ? this.blurRes : halfResBlur === true ? 0.5 : halfResBlur;
    this.blurNext.resolution = this.blur.resolution;
    const v = bgView(world, cam, main.framing, this.viewportW / this.viewportH);
    this.viewZoom = v.zoom;
    const s = baseScale(world, this.viewportH) * v.zoom;
    this.place(this.sprite, main, world, v, s);
    this.assetId = main.assetId;
    this.sprite.filters = blurPx > 0.05 ? [this.setBlur(this.blur, blurPx)] : null;
    this.updateCache(blurPx > 0.05 && allowCache && !next && halfResBlur === false);
    if (next) {
      const vn = bgView(world, cam, next.framing, this.viewportW / this.viewportH);
      this.place(this.nextSprite, next, world, vn, baseScale(world, this.viewportH) * vn.zoom);
      this.nextSprite.alpha = next.alpha;
      this.nextSprite.visible = true;
      (this.nextSprite as unknown as { __asset?: string }).__asset = next.assetId;
      this.nextSprite.filters = blurPx > 0.05 ? [this.setBlur(this.blurNext, blurPx)] : null;
    } else this.nextSprite.visible = false;
  }

  /** Decide whether the picture is drawn from the blur cache this frame (and render the cache when it has just become due). */
  private updateCache(wanted: boolean): void {
    const r = this.renderer;
    if (!wanted || !r) {
      this.stableFrames = 0;
      this.cacheValid = false;
      this.sprite.visible = true;
      if (this.cacheView) this.cacheView.visible = false;
      return;
    }
    const k = this.key;
    const sp = this.sprite;
    const same = k.tex === sp.texture && k.x === sp.x && k.y === sp.y && k.scale === sp.scale.x && k.blur === this.blur.strength && k.res === this.blur.resolution && k.rr === r.resolution;
    this.cacheStats.frames++;
    if (!same) {
      k.tex = sp.texture; k.x = sp.x; k.y = sp.y; k.scale = sp.scale.x; k.blur = this.blur.strength; k.res = this.blur.resolution; k.rr = r.resolution;
      this.stableFrames = 0;
      this.cacheValid = false;
    } else this.stableFrames++;
    if (this.stableFrames < CACHE_AFTER) {
      sp.visible = true;
      if (this.cacheView) this.cacheView.visible = false;
      return;
    }
    if (!this.cacheValid) this.renderCache(r);
    else this.cacheStats.hits++;
    sp.visible = false;
    this.cacheView!.visible = true;
  }

  private renderCache(r: Renderer): void {
    if (!this.cacheTarget || this.cacheTarget.source.resolution !== r.resolution) {
      this.cacheTarget?.destroy(true);
      this.cacheTarget = RenderTexture.create({ width: this.viewportW, height: this.viewportH, resolution: r.resolution, antialias: false, scaleMode: 'nearest' });
      this.cacheRoot = new Container();
      this.cacheSource = new Sprite();
      this.cacheSource.anchor.set(0.5);
      this.cacheRoot.addChild(this.cacheSource);
      if (!this.cacheView) {
        this.cacheView = new Sprite();
        this.addChildAt(this.cacheView, 1);
      }
      this.cacheView.texture = this.cacheTarget;
    }
    const src = this.cacheSource!;
    src.texture = this.sprite.texture;
    src.position.copyFrom(this.sprite.position);
    src.scale.copyFrom(this.sprite.scale);
    src.filters = [this.blur];
    r.render({ container: this.cacheRoot!, target: this.cacheTarget, clear: true, clearColor: [0, 0, 0, 0] });
    this.cacheValid = true;
    this.cacheStats.renders++;
  }

  private setBlur(f: BlurFilter, px: number): BlurFilter {
    f.strength = px;
    return f;
  }

  private place(sp: Sprite, pic: BgPicture, world: BgInfo, v: { cx: number; cy: number; zoom: number }, s: number): void {
    if (sp.texture !== pic.texture) sp.texture = pic.texture;
    // "cover": world units per picture pixel so the picture fills the whole world rectangle (identical sizes give exactly 1)
    const k = Math.max(world.width / pic.src.width, world.height / pic.src.height);
    sp.scale.set(s * k);
    sp.position.set(this.viewportW / 2 + (world.width / 2 - v.cx) * s, this.viewportH / 2 + (world.height / 2 - v.cy) * s);
  }
}
