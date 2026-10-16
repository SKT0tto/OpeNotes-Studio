import { BlurFilter, Container, Sprite, type Texture } from 'pixi.js';
import { baseScale, bgView, type BgFraming, type BgInfo, type CameraPose } from '@shared/staging/world';

/** One picture to draw: its texture and own pixel size (it is fitted over the world of the scene, "cover"). */
export interface BgPicture {
  assetId: string;
  texture: Texture;
  framing: BgFraming;
  src: { width: number; height: number };
}

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
  /** Effective background magnification of the last frame (debug / tests). */
  viewZoom = 1;

  constructor(
    private readonly viewportW: number,
    private readonly viewportH: number,
  ) {
    super();
    this.sprite.anchor.set(0.5);
    this.nextSprite.anchor.set(0.5);
    this.nextSprite.visible = false;
    this.addChild(this.sprite, this.nextSprite);
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
  apply(world: BgInfo, cam: CameraPose, blurPx: number, main: BgPicture, next?: BgPicture & { alpha: number }, halfResBlur = false): void {
    this.blur.resolution = halfResBlur ? 0.5 : this.blurRes;
    this.blurNext.resolution = this.blur.resolution;
    const v = bgView(world, cam, main.framing, this.viewportW / this.viewportH);
    this.viewZoom = v.zoom;
    const s = baseScale(world, this.viewportH) * v.zoom;
    this.place(this.sprite, main, world, v, s);
    this.assetId = main.assetId;
    this.sprite.filters = blurPx > 0.05 ? [this.setBlur(this.blur, blurPx)] : null;
    if (next) {
      const vn = bgView(world, cam, next.framing, this.viewportW / this.viewportH);
      this.place(this.nextSprite, next, world, vn, baseScale(world, this.viewportH) * vn.zoom);
      this.nextSprite.alpha = next.alpha;
      this.nextSprite.visible = true;
      (this.nextSprite as unknown as { __asset?: string }).__asset = next.assetId;
      this.nextSprite.filters = blurPx > 0.05 ? [this.setBlur(this.blurNext, blurPx)] : null;
    } else this.nextSprite.visible = false;
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
