/**
 * The eyelid mask of the daze effect (the original's eyeblink frame): black lids that close from the top and the bottom, with a soft edge.
 * The feather is a 1 x 256 gradient texture drawn in code at start-up (no external resource); the lid body is a plain rectangle.
 */
import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { DAZE_LID_FEATHER } from '@shared/timeline/fxParams';

function featherTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  // opaque at the lid side (top), transparent at the open side; smoothstep so the edge has no visible kink
  for (let i = 0; i <= 16; i++) {
    const u = i / 16;
    const a = 1 - u * u * (3 - 2 * u);
    grad.addColorStop(u, `rgba(0,0,0,${a.toFixed(4)})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 256);
  return Texture.from(c);
}

export class EyelidLayer {
  readonly layer = new Container();
  private readonly texture = featherTexture();
  private readonly lids: Array<{ body: Graphics; feather: Sprite }>;

  constructor(private readonly width: number, private readonly height: number) {
    this.lids = [0, 1].map(() => {
      const body = new Graphics();
      const feather = new Sprite(this.texture);
      feather.width = width;
      feather.height = DAZE_LID_FEATHER * height;
      this.layer.addChild(body, feather);
      return { body, feather };
    });
    this.layer.visible = false;
  }

  /** `closed` 0..1: how far the lids have closed (1 = both halves meet). */
  set(closed: number): void {
    this.layer.visible = closed > 0.002;
    if (!this.layer.visible) return;
    const H = this.height;
    const f = DAZE_LID_FEATHER * H;
    const edge = (0.5 * H + f) * closed;
    const solid = Math.max(0, edge - f);
    const alpha = Math.min(1, edge / f);
    this.lids.forEach((lid, i) => {
      lid.body.clear();
      lid.body.rect(0, 0, this.width, solid).fill(0x000000);
      lid.feather.alpha = alpha;
      lid.feather.y = Math.max(0, edge - f);
      // the bottom lid is the top one mirrored
      if (i === 1) {
        lid.body.scale.y = -1;
        lid.body.y = H;
        lid.feather.scale.y = -Math.abs(lid.feather.scale.y);
        lid.feather.y = H - Math.max(0, edge - f);
      }
    });
  }

  destroy(): void {
    this.layer.destroy({ children: true });
    this.texture.destroy(true);
  }
}
