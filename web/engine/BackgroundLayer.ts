import { BlurFilter, Container, Sprite, type Texture } from 'pixi.js';
import { baseScale, bgView, type BgFraming, type BgInfo, type CameraPose } from '@shared/staging/world';

/**
 * Background as its own layer: it follows the camera with parallax (zoom^0.85) and is clamped so the viewport is
 * always covered. Blur (depth of field) is applied with the filter clipped to nothing, so the screen edges blur
 * with real background pixels instead of fading to transparent.
 */
export class BackgroundLayer extends Container {
  private readonly sprite = new Sprite();
  private readonly blur = new BlurFilter({ strength: 0, quality: 4 });
  private assetId: string | null = null;
  /** Effective background magnification of the last frame (debug / tests). */
  viewZoom = 1;

  constructor(
    private readonly viewportW: number,
    private readonly viewportH: number,
  ) {
    super();
    this.addChild(this.sprite);
  }

  get currentAsset(): string | null {
    return this.assetId;
  }

  setTexture(assetId: string, texture: Texture): void {
    this.assetId = assetId;
    this.sprite.texture = texture;
  }

  /** `blurPx` is in screen pixels. */
  apply(bg: BgInfo, cam: CameraPose, framing: BgFraming, blurPx: number): void {
    const v = bgView(bg, cam, framing, this.viewportW / this.viewportH);
    this.viewZoom = v.zoom;
    const s = baseScale(bg, this.viewportH) * v.zoom;
    this.sprite.scale.set(s);
    this.sprite.position.set(this.viewportW / 2 - v.cx * s, this.viewportH / 2 - v.cy * s);
    this.blur.strength = blurPx;
    this.sprite.filters = blurPx > 0.05 ? [this.blur] : null;
  }
}
