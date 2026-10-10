/**
 * Emotion effects as GLSL filters (STYLE_REFERENCE section 6): a full-screen filter for the smoky anxiety vignette
 * (edge darkening + desaturation) and the memory glow (black lift, radial RGB split, soft bloom), and an outer-glow
 * filter that gives actors a soft white rim during the anxiety vignette.
 */
import { Filter, GlProgram } from 'pixi.js';

const VERTEX = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void) { return aPosition * (uOutputFrame.zw * uInputSize.zw); }
void main(void) { gl_Position = filterVertexPosition(); vTextureCoord = filterTextureCoord(); }
`;

const SCREEN_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uAnxiety;
uniform float uDesat;
uniform float uInset;
uniform float uDark;
uniform float uGlow;
uniform float uLift;
uniform float uChroma;
uniform float uBloom;
uniform float uAspect;
uniform float uSmoke;
uniform float uTime;
uniform vec3 uTint;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return 0.55 * noise(p) + 0.3 * noise(p * 2.1 + 3.7) + 0.15 * noise(p * 4.3 + 8.1); }

void main(void) {
  vec2 uv = vTextureCoord;
  vec2 c = uv - 0.5;
  vec2 dir = c * 2.0;
  float r = length(dir);
  vec2 off = vec2(uChroma / uAspect, uChroma) * dir * r * uGlow;
  vec4 base = texture(uTexture, uv);
  vec3 col = vec3(texture(uTexture, uv + off).r, base.g, texture(uTexture, uv - off).b);
  float a = base.a;

  if (uGlow > 0.001) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float ang = float(i) * 0.7853982;
      vec2 d = vec2(cos(ang) / uAspect, sin(ang)) * 0.012;
      acc += max(texture(uTexture, uv + d).rgb - 0.55, 0.0) + max(texture(uTexture, uv + d * 2.2).rgb - 0.55, 0.0);
    }
    col += acc / 16.0 * uBloom * uGlow;
    col += (1.0 - col) * uLift * uGlow;
  }

  if (uAnxiety > 0.001) {
    // Smoky vignette: an irregular rim whose edge and density come from slowly drifting fbm clouds, tinted grey, heavier in the corners.
    vec2 q = uv * vec2(3.0 * uAspect, 3.0);
    float n1 = fbm(q + vec2(uTime * 0.9, -uTime * 0.5) + 11.0);
    float n2 = fbm(q * 2.3 - vec2(uTime * 0.6, uTime * 0.8) + 23.0);
    float n3 = noise(q * 5.1 + vec2(uTime * 0.4, uTime * 0.3));
    float smoke = clamp(0.5 * n1 + 0.35 * n2 + 0.15 * n3, 0.0, 1.0);
    float width = uInset * uAspect * (0.45 + 1.1 * smoke);
    float mx = 1.0 - smoothstep(0.0, width, min(uv.x, 1.0 - uv.x) * uAspect);
    float my = 1.0 - smoothstep(0.0, width, min(uv.y, 1.0 - uv.y));
    float m = clamp(max(mx, my) + 0.6 * mx * my, 0.0, 1.0);
    col *= 1.0 - uDark * m * uAnxiety * (0.55 + 0.45 * smoke);
    float g = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(g), uDesat * uAnxiety);
    float fog = clamp(m * (0.25 + 0.95 * smoke) * uSmoke * uAnxiety, 0.0, 1.0);
    col = mix(col, uTint * (0.35 + 1.3 * smoke), fog);
  }
  finalColor = vec4(col, a);
}
`;

export interface ScreenFx {
  anxiety: number;
  desat: number;
  inset: number;
  dark: number;
  glow: number;
  lift: number;
  chroma: number;
  bloom: number;
  /** Smoke texture strength 0..1, grey fog colour (rgb 0..1) and the project time that drives its drift. */
  smoke: number;
  tint: [number, number, number];
  time: number;
}

export class ScreenFxFilter extends Filter {
  constructor(aspect: number) {
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: SCREEN_FRAGMENT, name: 'screen-fx' }),
      resources: {
        fx: {
          uAnxiety: { value: 0, type: 'f32' }, uDesat: { value: 0, type: 'f32' }, uInset: { value: 0, type: 'f32' }, uDark: { value: 0, type: 'f32' },
          uGlow: { value: 0, type: 'f32' }, uLift: { value: 0, type: 'f32' }, uChroma: { value: 0, type: 'f32' }, uBloom: { value: 0, type: 'f32' },
          uAspect: { value: aspect, type: 'f32' }, uSmoke: { value: 0, type: 'f32' }, uTime: { value: 0, type: 'f32' }, uTint: { value: new Float32Array([0.5, 0.5, 0.5]), type: 'vec3<f32>' },
        },
      },
    });
  }

  set(v: ScreenFx): void {
    const u = (this.resources.fx as { uniforms: Record<string, number> }).uniforms;
    u.uAnxiety = v.anxiety; u.uDesat = v.desat; u.uInset = v.inset; u.uDark = v.dark;
    u.uGlow = v.glow; u.uLift = v.lift; u.uChroma = v.chroma; u.uBloom = v.bloom;
    u.uSmoke = v.smoke; u.uTime = v.time;
    (u as unknown as Record<string, Float32Array>).uTint!.set(v.tint);
  }
}

const GLOW_FRAGMENT = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform float uRadius;
uniform float uStrength;

void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);
  float acc = 0.0;
  for (int i = 0; i < 12; i++) {
    float ang = float(i) * 0.5235988;
    vec2 d = vec2(cos(ang), sin(ang)) * uInputSize.zw;
    acc += texture(uTexture, vTextureCoord + d * uRadius).a + texture(uTexture, vTextureCoord + d * uRadius * 0.5).a;
  }
  float halo = clamp(acc / 24.0 * 1.6, 0.0, 1.0) * uStrength;
  float a = c.a + (1.0 - c.a) * halo;
  finalColor = vec4(c.rgb + vec3(1.0) * (1.0 - c.a) * halo, a);
}
`;

/** Soft white rim around an actor; `radius` in filter pixels. */
export class OuterGlowFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex: VERTEX, fragment: GLOW_FRAGMENT, name: 'outer-glow' }),
      resources: { glow: { uRadius: { value: 4, type: 'f32' }, uStrength: { value: 0, type: 'f32' } } },
      padding: 12,
    });
  }

  set(radiusPx: number, strength: number): void {
    const u = (this.resources.glow as { uniforms: Record<string, number> }).uniforms;
    u.uRadius = radiusPx;
    u.uStrength = strength;
    this.padding = Math.ceil(radiusPx) + 2;
  }
}
