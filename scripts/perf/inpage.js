// Injected before any page script (page.addInitScript): GL call counters + live texture bytes, React commit counter
// (through the DevTools global hook, which production React also calls), DOM mutation counter.
(() => {
  const P = (window.__perfGl = { draws: 0, fb: 0, texUp: 0, texBytesLive: 0, texCount: 0, useProgram: 0, clears: 0, commits: 0, mutations: 0 });
  const sizes = new WeakMap();
  const bound = new Map();
  const bpp = (type) => (type === 0x1406 ? 16 : type === 0x140b || type === 0x8d61 ? 8 : 4);
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    const pr = C.prototype;
    for (const m of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const o = pr[m];
      if (!o) continue;
      pr[m] = function (...a) { P.draws++; return o.apply(this, a); };
    }
    const bfb = pr.bindFramebuffer;
    pr.bindFramebuffer = function (...a) { P.fb++; return bfb.apply(this, a); };
    const up = pr.useProgram;
    pr.useProgram = function (...a) { P.useProgram++; return up.apply(this, a); };
    const cl = pr.clear;
    pr.clear = function (...a) { P.clears++; return cl.apply(this, a); };
    const bt = pr.bindTexture;
    pr.bindTexture = function (target, tex) { bound.set(this, tex); return bt.call(this, target, tex); };
    const account = (gl, w, h, type) => {
      const tex = bound.get(gl);
      if (!tex || !w || !h) return;
      const bytes = w * h * bpp(type);
      const prev = sizes.get(tex) ?? 0;
      if (prev === 0) P.texCount++;
      P.texBytesLive += bytes - prev;
      sizes.set(tex, bytes);
    };
    const ti = pr.texImage2D;
    pr.texImage2D = function (...a) {
      P.texUp++;
      // (target, level, internalformat, width, height, border, format, type, src?) or (target, level, internalformat, format, type, source)
      if (a[1] === 0) {
        if (a.length === 6) { const s = a[5]; if (s) account(this, s.width ?? s.videoWidth, s.height ?? s.videoHeight, a[4]); }
        else if (a.length >= 8) account(this, a[3], a[4], a[7]);
      }
      return ti.apply(this, a);
    };
    const ts = pr.texStorage2D;
    if (ts) pr.texStorage2D = function (target, levels, fmt, w, h) { P.texUp++; account(this, w, h, 0x1401); return ts.call(this, target, levels, fmt, w, h); };
    const tsub = pr.texSubImage2D;
    pr.texSubImage2D = function (...a) { P.texUp++; return tsub.apply(this, a); };
    const dt = pr.deleteTexture;
    pr.deleteTexture = function (tex) {
      const s = sizes.get(tex);
      if (s) { P.texBytesLive -= s; P.texCount--; sizes.delete(tex); }
      return dt.call(this, tex);
    };
  }
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(), checkDCE() {}, inject() { return 1; },
    onCommitFiberRoot() { P.commits++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, setStrictMode() {},
  };
  addEventListener('DOMContentLoaded', () => new MutationObserver((l) => { P.mutations += l.length; }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }));
})();
