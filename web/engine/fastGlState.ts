/**
 * The Live2D engine brackets every model draw with a full GL state save / restore (`gl.getParameter` x ~20, `getVertexAttrib` x 4,
 * `isEnabled` x 5, plus two more reads in `draw`). Those reads are synchronous calls into the GPU process wrapper and cost 0.75 - 2.6 ms
 * a frame with five models on stage.
 *
 * Inside this app the state around a Live2D draw is known: Pixi calls `geometry.resetState()` (default VAO bound), `shader.resetState()`
 * and `texture.resetState()` right before the model and `state.resetState()` / `texture.resetState()` right after it, so everything the
 * engine would restore is rebuilt by Pixi anyway. What is left is the default VAO's attribute / buffer bindings, the colour mask and the
 * active texture unit, which the engine always leaves at the same values; those are restored from constants. The bound framebuffer
 * (different inside a filter pass) is tracked from `bindFramebuffer` instead of being read back.
 *
 * `window.__fastGlStateCheck = true` (dev tools) keeps the engine's own reads and counts how often they disagree with the assumptions.
 */
import type { CubismInternalModel } from 'untitled-pixi-live2d-engine/cubism';

type Gl = WebGL2RenderingContext;
interface Profile {
  gl: Gl | null;
  save(): void;
  restore(): void;
  _lastVertexAttribArrayEnabled: boolean[];
  _lastArrayBufferBinding: unknown;
  _lastElementArrayBufferBinding: unknown;
  _lastProgram: unknown;
  _lastActiveTexture: number;
  _lastColorMask: boolean[];
  _lastScissorTest: boolean;
  _lastStencilTest: boolean;
  _lastDepthTest: boolean;
  _lastCullFace: boolean;
}
interface InternalWithRenderer {
  renderer: { _rendererProfile?: Profile };
  draw(gl: Gl): void;
}

interface GlTrack {
  fbo: WebGLFramebuffer | null;
  /** Between `draw` entry and exit: `getParameter` answers the two reads the engine makes there from the tracker. */
  inDraw: boolean;
}
const tracks = new WeakMap<Gl, GlTrack>();

/** Dev check: how often the engine's own reads disagreed with the assumed state (see the file comment). */
export const fastGlStateMismatch: Record<string, number> = ((globalThis as { __fastGlStateMismatch?: Record<string, number> }).__fastGlStateMismatch ??= {});

function trackFor(gl: Gl): GlTrack {
  let t = tracks.get(gl);
  if (t) return t;
  const track: GlTrack = { fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null, inDraw: false };
  tracks.set(gl, track);
  const bind = gl.bindFramebuffer;
  gl.bindFramebuffer = function (this: Gl, target: number, fbo: WebGLFramebuffer | null) {
    if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) track.fbo = fbo;
    return bind.call(this, target, fbo);
  };
  const get = gl.getParameter;
  gl.getParameter = function (this: Gl, pname: number) {
    if (track.inDraw) {
      if (pname === gl.FRAMEBUFFER_BINDING) return track.fbo;
      if (pname === gl.CULL_FACE_MODE) return gl.BACK; // only the engine's own draw changes it, and it puts it back
    }
    return get.call(this, pname);
  } as typeof gl.getParameter;
  t = track;
  return t;
}

const hit = (k: string) => (fastGlStateMismatch[k] = (fastGlStateMismatch[k] ?? 0) + 1);

/** Replace the engine's per-draw GL state save / restore of one model (idempotent). */
export function installFastGlState(internal: CubismInternalModel): void {
  const im = internal as unknown as InternalWithRenderer;
  const profile = im.renderer?._rendererProfile;
  if (!profile || (profile as unknown as { __fast?: boolean }).__fast) return;
  (profile as unknown as { __fast?: boolean }).__fast = true;
  const realSave = profile.save.bind(profile);
  profile.save = () => {
    if ((globalThis as { __fastGlStateCheck?: boolean }).__fastGlStateCheck) {
      // verification mode: the engine's real reads, compared with what restore() assumes
      realSave();
      const p = profile;
      for (let i = 0; i < 4; i++) if (p._lastVertexAttribArrayEnabled[i]) hit(`attrib${i}Enabled`);
      if (p._lastArrayBufferBinding !== null) hit('arrayBuffer');
      if (p._lastElementArrayBufferBinding !== null) hit('elementBuffer');
      if (p._lastProgram !== null) hit('program');
      if (p._lastActiveTexture !== p.gl!.TEXTURE0) hit('activeTexture');
      if (!p._lastColorMask.every(Boolean)) hit('colorMask');
      if (p._lastScissorTest) hit('scissor');
      if (p._lastStencilTest) hit('stencil');
      if (p._lastDepthTest) hit('depth');
      if (p._lastCullFace) hit('cull');
      const gl = p.gl!;
      const t = tracks.get(gl);
      if (t && gl.getParameter(gl.FRAMEBUFFER_BINDING) !== t.fbo) hit('fbo');
    }
  };
  profile.restore = () => {
    const gl = profile.gl;
    if (!gl) return;
    gl.disableVertexAttribArray(0);
    gl.disableVertexAttribArray(1);
    gl.disableVertexAttribArray(2);
    gl.disableVertexAttribArray(3);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.colorMask(true, true, true, true);
    gl.activeTexture(gl.TEXTURE0);
  };
  const draw = im.draw.bind(im);
  im.draw = (gl: Gl) => {
    const track = trackFor(gl);
    track.inDraw = true;
    try {
      draw(gl);
    } finally {
      track.inDraw = false;
    }
  };
}
