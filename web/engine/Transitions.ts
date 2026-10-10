import { Container, Graphics, Rectangle, Sprite, Texture, type Renderer } from 'pixi.js';

export type TransitionKind = 'cut' | 'fade_black' | 'fade_white' | 'crossfade' | 'wipe' | 'dip_black' | 'scene_black';

/** Seconds into the lead-in and the lead-in's phases (used by the black changes). */
export interface TransitionTimes {
  seconds: number;
  pause: number;
  out: number;
}

/**
 * Scene transitions. The OLD scene is frozen into a texture (a flattened snapshot of the composited stage), the
 * NEW scene renders live underneath, and only the snapshot sprite / a flat colour rectangle is animated. That way
 * no layer of the old scene can show through wrongly and nothing of the old scene lingers afterwards.
 */
export class Transitions {
  readonly layer = new Container();
  private snapshot: Texture | null = null;
  private readonly old = new Sprite();
  private readonly oldMask = new Graphics();
  private readonly colour = new Graphics();

  constructor(
    private readonly renderer: Renderer,
    private readonly w: number,
    private readonly h: number,
  ) {
    this.layer.addChild(this.old, this.oldMask, this.colour);
    this.old.visible = false;
    this.colour.rect(0, 0, w, h).fill(0xffffff);
    this.colour.visible = false;
  }

  get hasSnapshot(): boolean {
    return this.snapshot !== null;
  }

  /** Freeze `source` (the scene root, without overlays) as it looks right now. */
  capture(source: Container): void {
    this.clear();
    this.snapshot = this.renderer.generateTexture({ target: source, frame: new Rectangle(0, 0, this.w, this.h), resolution: this.renderer.resolution });
    this.old.texture = this.snapshot;
  }

  /** Pose the overlay for `progress` (0..1) of `kind`. Without a snapshot only colour fades show. */
  update(kind: TransitionKind, progress: number, times?: TransitionTimes): void {
    const p = Math.min(1, Math.max(0, progress));
    this.old.mask = null;
    this.old.visible = false;
    this.colour.visible = false;
    const snap = this.snapshot !== null;
    if (kind === 'crossfade' && snap) {
      this.old.visible = true;
      this.old.alpha = 1 - p;
    } else if (kind === 'wipe' && snap) {
      this.old.visible = true;
      this.old.alpha = 1;
      this.oldMask.clear().rect(p * this.w, 0, this.w, this.h).fill(0xffffff);
      this.old.mask = this.oldMask;
    } else if ((kind === 'scene_black' || kind === 'dip_black') && times) {
      // old picture stays (pause), fades to black (out), then stays black (hold) until the fade-in of the content takes over.
      this.colour.visible = true;
      this.colour.tint = 0x000000;
      const into = times.seconds - times.pause;
      this.old.visible = snap && into < times.out;
      this.old.alpha = 1;
      this.colour.alpha = !snap ? 1 : into <= 0 ? 0 : times.out > 0 ? Math.min(1, into / times.out) : 1;
    } else if (kind === 'fade_black' || kind === 'fade_white') {
      this.old.visible = snap && p < 0.5;
      this.old.alpha = 1;
      this.colour.visible = true;
      this.colour.tint = kind === 'fade_black' ? 0x000000 : 0xffffff;
      // With a snapshot: old -> colour -> new. Without one (first scene / seek) only the fade-in from the colour is meaningful.
      this.colour.alpha = !snap ? 1 - p : p < 0.5 ? p * 2 : (1 - p) * 2;
    }
  }

  /** Remove the overlay and release the snapshot texture. */
  clear(): void {
    this.old.visible = false;
    this.old.mask = null;
    this.colour.visible = false;
    if (this.snapshot) {
      this.old.texture = Texture.EMPTY;
      this.snapshot.destroy(true);
      this.snapshot = null;
    }
  }
}
