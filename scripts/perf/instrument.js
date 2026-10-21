// Installed once the player is ready (page.evaluate). Per Pixi frame it records: the frame interval, the CPU work of the whole ticker
// frame, time per ticker listener class (player = evaluate + Stage.apply + dialogue/HUD/React listeners; hidden = off-screen actor tick;
// automator = Live2D time accumulation; render = app.render), Live2D internal update / draw / bounds inside render, GL draw calls,
// framebuffer binds, filter passes, texture uploads, the GPU time of app.render (EXT_disjoint_timer_query_webgl2) and labels of what is
// on screen (bit 1 camera moving, 2 actor fade, 4 depth of field, 8 scene / background change, 16 actor walking, 32 player busy).
(() => {
  if (window.__perf) return { timer: window.__perf.timer };
  const S = window.__studio;
  const app = S.app;
  const ticker = app.ticker;
  const gl = app.renderer.gl;
  const G = window.__perfGl;
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const R = (window.__perf = { frames: [], rec: false, gpuPending: [], prev: null, lastScene: -1, sinceScene: 999, filterPush: 0, timer: !!tq });
  const cats = () => ({ player: 0, hidden: 0, automator: 0, render: 0, other: 0, l2dUpdate: 0, l2dDraw: 0, l2dBounds: 0 });
  R.acc = cats();
  const classify = (l) => {
    const s = String(l._fn);
    if (l._context && l._context.constructor && /Application/.test(l._context.constructor.name)) return 'render';
    if (s.includes('this.tick(')) return 'player';
    if (s.includes('sceneRoot.visible')) return 'hidden';
    if (s.includes('onTickerUpdate')) return 'automator';
    return 'other';
  };
  let frameStart = 0;
  let gpuQ = null;
  function startFn() {
    const now = performance.now();
    if (n++ % 30 === 0) { wrapListeners(); wrapModels(); }
    frameStart = now;
    R.interval = lastStart ? now - lastStart : 0;
    lastStart = now;
    base = { draws: G.draws, fb: G.fb, texUp: G.texUp, fp: R.filterPush, commits: G.commits, mut: G.mutations, prog: G.useProgram };
  }
  const wrapListeners = () => {
    for (let l = ticker._head && ticker._head.next; l; l = l.next) {
      if (l.__perf || l._fn === startFn || l._fn === endFn) continue;
      const cat = classify(l);
      const orig = l._fn;
      l.__perf = cat;
      l._fn = function (arg) {
        const t = performance.now();
        if (cat === 'render' && tq && R.rec && !gpuQ) { gpuQ = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, gpuQ); }
        try { return orig.call(this, arg); } finally {
          if (cat === 'render' && gpuQ) { gl.endQuery(tq.TIME_ELAPSED_EXT); R.gpuPending.push({ q: gpuQ, i: R.frames.length }); gpuQ = null; }
          R.acc[cat] += performance.now() - t;
        }
      };
      // ticker.remove(fn, ctx) must still find the listener by its original function
      l.match = function (fn, ctx = null) { return orig === fn && this._context === ctx; };
    }
  };
  const wrapModels = () => {
    const walk = (o) => {
      if (o.internalModel && !o.__perf) {
        o.__perf = true;
        const im = o.internalModel;
        const u = im.update;
        im.update = function (...a) { const t = performance.now(); try { return u.apply(this, a); } finally { R.acc.l2dUpdate += performance.now() - t; } };
        const d = im.draw;
        im.draw = function (...a) { const t = performance.now(); try { return d.apply(this, a); } finally { R.acc.l2dDraw += performance.now() - t; } };
        if (o.updateDrawableBounds) {
          const b = o.updateDrawableBounds;
          o.updateDrawableBounds = function (...a) { const t = performance.now(); try { return b.apply(this, a); } finally { R.acc.l2dBounds += performance.now() - t; } };
        }
      }
      for (const c of o.children ?? []) walk(c);
    };
    walk(app.stage);
  };
  const fsys = app.renderer.filter;
  if (fsys && fsys.push && !fsys.__perf) {
    const p = fsys.push;
    fsys.__perf = true;
    fsys.push = function (...a) { R.filterPush++; return p.apply(this, a); };
  }
  let base = { draws: 0, fb: 0, texUp: 0, fp: 0, commits: 0, mut: 0, prog: 0 };
  let lastStart = 0;
  let n = 0;
  function endFn() {
    const end = performance.now();
    while (R.gpuPending.length) {
      const g = R.gpuPending[0];
      if (!gl.getQueryParameter(g.q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(tq.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(g.q, gl.QUERY_RESULT);
      if (R.frames[g.i]) R.frames[g.i].gpu = disjoint ? -1 : ns / 1e6;
      gl.deleteQuery(g.q);
      R.gpuPending.shift();
    }
    const p = S.player;
    const s = p && p.state();
    let lab = 0;
    if (s) {
      const pv = R.prev;
      const cam = s.camera;
      if (pv && pv.sceneIndex === s.sceneIndex && (Math.abs(cam.x - pv.camera.x) + Math.abs(cam.y - pv.camera.y) > 0.01 || Math.abs(Math.log(cam.zoom / pv.camera.zoom)) > 1e-4)) lab |= 1;
      if (s.actors.some((a) => a.opacity > 0.002 && a.opacity < 0.998)) lab |= 2;
      if (s.background.blur > 0.05 || s.actors.some((a) => a.blur > 0.05)) lab |= 4;
      if (s.sceneIndex !== R.lastScene) { R.sinceScene = 0; R.lastScene = s.sceneIndex; }
      if (s.transition || s.background.next || R.sinceScene < 30 || (pv && pv.background.assetId !== s.background.assetId)) lab |= 8;
      if (pv && s.actors.some((a) => pv.actors.find((b) => b.castId === a.castId && (Math.abs(b.slot - a.slot) > 1e-4 || Math.abs(b.depth - a.depth) > 1e-4)))) lab |= 16;
      R.sinceScene++;
      R.prev = s;
    }
    if (p && p.busy()) lab |= 32;
    if (R.rec) {
      const a = R.acc;
      R.frames.push({
        at: frameStart, iv: R.interval, work: end - frameStart, player: a.player, hidden: a.hidden, automator: a.automator, render: a.render,
        l2dU: a.l2dUpdate, l2dD: a.l2dDraw, l2dB: a.l2dBounds, draws: G.draws - base.draws, fb: G.fb - base.fb, fp: R.filterPush - base.fp,
        tex: G.texUp - base.texUp, commits: G.commits - base.commits, mut: G.mutations - base.mut, prog: G.useProgram - base.prog, gpu: null, lab, t: s ? s.t : 0, sc: s ? s.sceneIndex : -1,
      });
    }
    R.acc = cats();
  }
  ticker.add(startFn, null, 1e9);
  ticker.add(endFn, null, -1e9);
  wrapListeners();
  wrapModels();
  R.raf = [];
  let lr = 0;
  const loop = (t) => { if (R.rec) R.raf.push(lr ? t - lr : 0); lr = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  R.start = () => { R.frames = []; R.raf = []; R.rec = true; R.commits0 = G.commits; R.mut0 = G.mutations; R.t0 = performance.now(); };
  R.stop = () => { R.rec = false; return { frames: R.frames, raf: R.raf, commitsTotal: G.commits - R.commits0, mutationsTotal: G.mutations - R.mut0, wall: performance.now() - R.t0 }; };
  return { timer: !!tq };
})();
