/**
 * The white edge of a memory, drawn on the screen layer (above the scene root, below the fade rectangle; the DOM dialogue stays above it):
 *  - fog: a procedural cloud-like white vignette (the look of the original's frame_fog; no game texture is used - the fog is a fragment
 *    shader on a screen quad, a static fbm of the screen position, nothing time dependent);
 *  - bands: two hard white strips at the top and the bottom (the original's letterbox_white).
 * Neither follows the camera nor the Dutch roll.
 */
import { Container, Geometry, Graphics, Mesh, Shader, UniformGroup } from 'pixi.js';
import {
  MEMORY_BAND_ALPHA, MEMORY_BAND_H, MEMORY_FOG_ALPHA_H, MEMORY_FOG_ALPHA_V, MEMORY_FOG_DEPTH_H, MEMORY_FOG_DEPTH_V, MEMORY_FOG_POWER, MEMORY_FOG_UNDULATION,
} from '@shared/timeline/fxParams';
import type { MemoryEdge } from '@shared/schema/project';

const FOG_VERTEX = `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUv;
void main(void) { vUv = aUV; gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const FOG_FRAGMENT = `
precision highp float;
in vec2 vUv;
out vec4 finalColor;
uniform float uStrength;
uniform float uAspect;
uniform vec4 uDepth;   // x: top/bottom depth, y: side depth, z: top/bottom alpha, w: side alpha
uniform vec2 uShape;   // x: falloff power, y: undulation (a multiplier of (n - 0.5) around 1)

float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return 0.5 * noise(p) + 0.3 * noise(p * 2.03 + 17.1) + 0.2 * noise(p * 4.1 + 41.7); }

void main(void) {
  float dv = min(vUv.y, 1.0 - vUv.y) / uDepth.x;
  float dh = min(vUv.x, 1.0 - vUv.x) / uDepth.y;
  if (dv >= 1.0 && dh >= 1.0) { finalColor = vec4(0.0); return; }
  float av = dv < 1.0 ? uDepth.z * pow(1.0 - smoothstep(0.0, 1.0, dv), uShape.x) : 0.0;
  float ah = dh < 1.0 ? uDepth.w * pow(1.0 - smoothstep(0.0, 1.0, dh), uShape.x) : 0.0;
  float a = max(av, ah) + 0.3 * av * ah;
  // static clouds: seeded noise of the screen position (never of time), stretched so the undulation is about +-40 % along the edge
  float n = smoothstep(0.28, 0.72, fbm(vUv * vec2(4.0 * uAspect, 4.0) + 3.7));
  a *= 1.0 + uShape.y * (n - 0.5);
  a = clamp(a * uStrength, 0.0, 1.0);
  finalColor = vec4(a, a, a, a);
}
`;

export class MemoryEdgeLayer {
  readonly layer = new Container();
  private readonly bands = new Graphics();
  private readonly fog: Mesh<Geometry, Shader>;
  private readonly fogUniforms: UniformGroup;

  constructor(width: number, height: number) {
    const bandH = MEMORY_BAND_H * height;
    this.bands.rect(0, 0, width, bandH).rect(0, height - bandH, width, bandH).fill(0xffffff);
    this.bands.visible = false;
    this.fogUniforms = new UniformGroup({
      uStrength: { value: 0, type: 'f32' },
      uAspect: { value: width / height, type: 'f32' },
      uDepth: { value: new Float32Array([MEMORY_FOG_DEPTH_V, MEMORY_FOG_DEPTH_H, MEMORY_FOG_ALPHA_V, MEMORY_FOG_ALPHA_H]), type: 'vec4<f32>' },
      uShape: { value: new Float32Array([MEMORY_FOG_POWER, MEMORY_FOG_UNDULATION]), type: 'vec2<f32>' },
    });
    const geometry = new Geometry({
      attributes: {
        aPosition: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]),
        aUV: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      },
      indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({ gl: { vertex: FOG_VERTEX, fragment: FOG_FRAGMENT, name: 'memory-fog' }, resources: { fogUniforms: this.fogUniforms } });
    this.fog = new Mesh({ geometry, shader });
    this.fog.visible = false;
    this.layer.addChild(this.fog, this.bands);
  }

  /** `strength` 0..1 of the memory; `edge` the style. Nothing is drawn (and nothing costs anything) at strength 0. */
  set(strength: number, edge: MemoryEdge): void {
    const on = strength > 0.002;
    const fog = on && (edge === 'fog' || edge === 'both');
    const bands = on && (edge === 'bands' || edge === 'both');
    this.fog.visible = fog;
    this.bands.visible = bands;
    if (fog) (this.fogUniforms.uniforms as { uStrength: number }).uStrength = strength;
    if (bands) this.bands.alpha = MEMORY_BAND_ALPHA * strength;
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}
