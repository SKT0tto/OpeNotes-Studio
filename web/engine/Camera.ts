import { ASPECT, baseScale, clampZoom, screenToWorld, worldToScreen, type BgInfo, type CameraPose, type Pt } from '@shared/staging/world';

/** 2D orthographic camera over world space (background pixels). Pure bookkeeping; no Pixi objects. */
export class Camera {
  pose: CameraPose = { x: 0, y: 0, zoom: 1 };

  constructor(
    public bg: BgInfo,
    readonly viewportH: number,
    private readonly aspect: number = ASPECT,
  ) {}

  get viewportW(): number {
    return this.viewportH * this.aspect;
  }

  set(pose: CameraPose): void {
    this.pose = { ...pose, zoom: clampZoom(pose.zoom) };
  }

  /** Pixels per world unit at the current zoom (actor layer scale). */
  get scale(): number {
    return baseScale(this.bg, this.viewportH) * this.pose.zoom;
  }

  /** Transform for the actor layer: world -> screen pixels. */
  layerTransform(): { scale: number; x: number; y: number } {
    const scale = this.scale;
    return { scale, x: this.viewportW / 2 - this.pose.x * scale, y: this.viewportH / 2 - this.pose.y * scale };
  }

  worldToScreen(p: Pt): Pt {
    return worldToScreen(this.bg, this.pose, this.viewportH, p);
  }

  screenToWorld(p: Pt): Pt {
    return screenToWorld(this.bg, this.pose, this.viewportH, p);
  }
}
