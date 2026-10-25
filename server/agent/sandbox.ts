/**
 * The script sandbox of `run_script`: QuickJS compiled to WebAssembly (quickjs-emscripten, MIT). The script runs inside an interpreter
 * that has NO host objects: no filesystem, network, process, require / import, timers or host globals exist in it, so there is nothing to
 * escape to (Node's `vm` module is deliberately not used: it is not a security boundary). The only bridges are two host functions that
 * take and return plain strings (`__query`, `__log`); everything else is JSON copied in at the start.
 *
 * Limits per run: CPU about 2 s (an interrupt handler with a deadline), 64 MB of interpreter memory, a stack limit, and a cap on the
 * size of what the script returns. The interpreter is created for the run and disposed afterwards.
 *
 * The WASM module is loaded once (`loadSandbox`, async; a spare is kept ready) and runs are synchronous afterwards. A run whose interpreter
 * cannot be torn down cleanly retires its module (its memory would leak for good) and the spare takes over.
 */
import { RELEASE_SYNC, newQuickJSWASMModule, newVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from 'quickjs-emscripten';
import { SCRIPT_LIMITS, type ScriptRun, type ScriptRunner, type ScriptSnapshot } from '../../shared/agent/script';

let mod: QuickJSWASMModule | null = null;
/** A second module loaded ahead of time, so that a poisoned one can be replaced at once (runs are synchronous). */
let spare: QuickJSWASMModule | null = null;
let loading: Promise<boolean> | null = null;
/**
 * Set when an interpreter could not be torn down cleanly (QuickJS asserts in JS_FreeRuntime after some stack overflows, and the WASM build
 * then aborts): the memory of that run is never given back, and a few such runs would leave every later script "out of memory". A
 * poisoned module is never used again: the spare takes over immediately and a new spare (fresh WebAssembly memory) loads in the background.
 */
let poisoned = false;

/**
 * The interpreter's own memory counter (`setMemoryLimit`) is not a byte limit in the WASM build (a 1 MB string counts as a few bytes), so
 * the real cap is the WebAssembly memory itself: it may never grow beyond `MAX_PAGES` (64 KiB each). An allocation that does not fit fails
 * inside the interpreter as "out of memory", and nothing else in the process is affected.
 */
const INITIAL_PAGES = 256; // 16 MB
const MAX_PAGES = Math.ceil((SCRIPT_LIMITS.memoryBytes + 32 * 1024 * 1024) / 65536); // the script's 64 MB + the interpreter's own 32 MB

const freshModule = () => newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: MAX_PAGES }) }));

/** Load the WASM module and its spare (idempotent; refills after a replacement). Resolves false when it cannot be loaded, so the caller can leave run_script out. */
export function loadSandbox(): Promise<boolean> {
  if (mod && spare) return Promise.resolve(true);
  loading ??= (async () => {
    try {
      mod ??= await freshModule();
      spare ??= await freshModule();
      poisoned = false;
      return true;
    } catch {
      return mod !== null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Drop the module after a run that could not be cleaned up: the spare takes over, a new spare loads in the background. */
function poison(): void {
  poisoned = true;
  mod = spare;
  spare = null;
  void loadSandbox();
}

/** For tests: whether a module is ready, and whether the last replacement is still being refilled. */
export const sandboxState = (): { ready: boolean; poisoned: boolean } => ({ ready: mod !== null, poisoned });

/** The JavaScript the script runs against: read-only data and op constructors. It only builds plain objects. */
const PRELUDE = String.raw`
(function (g) {
  var D = JSON.parse(g.__data); delete g.__data;
  var hostQuery = g.__query; delete g.__query;
  var hostLog = g.__log; delete g.__log;
  var freeze = function (o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(function (k) { freeze(o[k]); }); } return o; };
  var project = freeze(D.project);
  var rows = D.rows, byBeat = {}, beatObj = {}, newScene = {};
  rows.forEach(function (r) { byBeat[r.beatId] = r; });
  project.scenes.forEach(function (s) { s.beats.forEach(function (b) { beatObj[b.id] = b; }); });
  var copy = function (r) { return JSON.parse(JSON.stringify(r)); };
  var sceneOf = function (beatId) {
    if (byBeat[beatId]) return byBeat[beatId].sceneId;
    if (newScene[beatId]) return newScene[beatId];
    throw new Error('没有这个 beatId：' + beatId);
  };
  var sceneIdOf = function (s) {
    if (s && typeof s === 'object') s = s.id || s.sceneId; // a scenes() entry or a beat row
    if (s === undefined || s === null) throw new Error('要给出场景：第几场（数字）或场景 id，例如 beats(2) / beats("s_2") / beats(scenes()[0].id)');
    if (typeof s === 'number') { var x = D.scenes[s - 1]; if (!x) throw new Error('没有第 ' + s + ' 场'); return x.id; }
    var hit = D.scenes.filter(function (q) { return q.id === s; })[0];
    if (!hit) throw new Error('没有这个场景：' + s);
    return hit.id;
  };
  var strip = function (o) { var out = {}; Object.keys(o).forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; }); return out; };
  var withReason = function (o, reason) { if (reason) o.reason = String(reason).slice(0, 200); return o; };
  var nSeq = 0;
  var round3 = function (v) { return Math.round(v * 1000) / 1000; };
  var op = {
    raw: function (o) { return o; },
    setShot: function (beatId, set, reason) {
      var s = Object.assign({}, set);
      // the set_shot tool says flow (auto|cut|move|glide); the op field is transition
      if (s.flow !== undefined) { if (s.transition === undefined) s.transition = s.flow === 'auto' ? null : s.flow === 'move' ? 'travel' : s.flow; delete s.flow; }
      return withReason({ op: 'shot_set', sceneId: sceneOf(beatId), beatId: beatId, set: s }, reason);
    },
    setBeat: function (beatId, set, reason) { return withReason({ op: 'beat_set', sceneId: sceneOf(beatId), beatId: beatId, set: set }, reason); },
    setEmotion: function (beatId, emotion, reason) { return withReason({ op: 'beat_set', sceneId: sceneOf(beatId), beatId: beatId, set: { emotion: emotion } }, reason); },
    setTiming: function (beatIds, set, reason) {
      var ids = [].concat(beatIds);
      if (ids.length === 0) throw new Error('setTiming 需要至少一个 beatId');
      var sc = sceneOf(ids[0]);
      ids.forEach(function (id) { if (sceneOf(id) !== sc) throw new Error('setTiming 的句子必须在同一个场景'); });
      var mapped = {};
      Object.keys(set).forEach(function (k) { mapped[k.indexOf('.') >= 0 ? k : 'rhythm.' + k] = set[k]; });
      return withReason({ op: 'timing', sceneId: sc, beatIds: ids, set: mapped }, reason);
    },
    clearTiming: function (beatIds, reason) {
      var ids = [].concat(beatIds);
      return withReason({ op: 'timing', sceneId: sceneOf(ids[0]), beatIds: ids, set: {}, clear: true }, reason);
    },
    nudge: function (beatId, castId, dxSteps, dySteps, reason) {
      var b = beatObj[beatId];
      var cur = (b && b.shot.offsets && b.shot.offsets[castId]) || { x: 0, y: 0 };
      var clamp = function (v) { return Math.max(-2, Math.min(2, v)); };
      return withReason({ op: 'shot_offset', sceneId: sceneOf(beatId), beatId: beatId, castId: castId, offset: { x: clamp(round3(cur.x + (dxSteps || 0) * 0.04)), y: clamp(round3(cur.y + (dySteps || 0) * 0.04)) } }, reason);
    },
    setFx: function (fromBeatId, toBeatId, fx, extra, reason) {
      return withReason(strip(Object.assign({ op: 'fx_range', sceneId: sceneOf(fromBeatId), fromBeatId: fromBeatId, toBeatId: toBeatId || fromBeatId, fx: fx }, extra || {})), reason);
    },
    insertBeat: function (afterBeatId, beat, sceneId, reason) {
      var sc = afterBeatId ? sceneOf(afterBeatId) : sceneIdOf(sceneId);
      var ref = '$new' + (++nSeq);
      newScene[ref] = sc;
      var b = { kind: beat.kind || (beat.speakerId ? 'dialogue' : 'narration'), text: beat.text || '' };
      if (beat.speakerId) b.speakerId = beat.speakerId;
      if (beat.emotion) b.emotion = beat.emotion;
      return withReason({ op: 'beat_insert', sceneId: sc, afterBeatId: afterBeatId || null, newId: ref, beat: b }, reason);
    },
    deleteBeat: function (beatId, reason) { return withReason({ op: 'beat_delete', sceneId: sceneOf(beatId), beatId: beatId }, reason); },
    moveBeat: function (beatId, afterBeatId, reason) { return withReason({ op: 'beat_move', sceneId: sceneOf(beatId), beatId: beatId, afterBeatId: afterBeatId || null }, reason); }
  };
  g.project = project;
  g.op = op;
  g.scenes = function () { return copy(D.scenes); };
  g.cast = function () { return copy(D.cast); };
  g.beats = function (scene) { var id = sceneIdOf(scene); return copy(rows.filter(function (r) { return r.sceneId === id; })); };
  g.beat = function (id) { if (!byBeat[id]) throw new Error('没有这个 beatId：' + id); return copy(byBeat[id]); };
  g.visible = function (id) { if (!byBeat[id]) throw new Error('没有这个 beatId：' + id); return byBeat[id].visible.slice(); };
  g.query = function (filter) {
    if (filter !== undefined && (filter === null || typeof filter !== 'object' || Array.isArray(filter))) throw new Error('query(filter) 需要一个条件对象（写法同 query_beats 的 filter），例如 query({ speaker: "灯", kind: "dialogue" })');
    var res = JSON.parse(hostQuery(JSON.stringify(filter || {})));
    if (res.error) throw new Error('query 过滤条件有误：' + [].concat(res.error).join('；'));
    return res.rows;
  };
  var fmt = function (a) { return typeof a === 'string' ? a : JSON.stringify(a); };
  g.console = { log: function () { hostLog([].slice.call(arguments).map(fmt).join(' ')); } };
  g.console.warn = g.console.error = g.console.info = g.console.log;
})(globalThis);
`;

/**
 * console.log output for the model: at most 40 lines and 6000 characters in all (a line may be long: models print a whole scene as one
 * line, and cutting it at a few hundred characters made them re-run the script just to see the rest).
 */
const LOG_LINES = 40;
const LOG_CHARS = 6000;
const limitLogs = (logs: string[], line: string) => {
  const used = logs.reduce((n, l) => n + l.length, 0);
  if (logs.length >= LOG_LINES || used >= LOG_CHARS) return;
  const room = LOG_CHARS - used;
  logs.push(line.length > room ? `${line.slice(0, room)}…（输出太长，已截断）` : line);
};

function describeError(vm: QuickJSContext, h: QuickJSHandle): string {
  const e = vm.dump(h) as { name?: string; message?: string } | string | null;
  if (e && typeof e === 'object') return `${e.name ?? 'Error'}: ${e.message ?? ''}`.trim();
  return String(e);
}

/** Run one script. Never throws: every failure is a `ScriptRun` with `ok: false`. */
export const runInSandbox: ScriptRunner = (code: string, snapshot: ScriptSnapshot, queryFn: (filterJson: string) => string): ScriptRun => {
  const t0 = Date.now();
  const logs: string[] = [];
  if (!mod) return { ok: false, error: poisoned ? '脚本沙箱正在重启（上一个脚本没能正常清理），请稍后再试或换别的办法' : '脚本沙箱没有加载', logs, ms: 0, failure: 'error' };
  const runtime = mod.newRuntime();
  let vm: QuickJSContext | null = null;
  const deadline = t0 + SCRIPT_LIMITS.cpuMs;
  try {
    runtime.setMemoryLimit(SCRIPT_LIMITS.memoryBytes);
    runtime.setMaxStackSize(SCRIPT_LIMITS.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    vm = runtime.newContext();
    const ctx = vm;
    const setString = (name: string, value: string) => { const h = ctx.newString(value); ctx.setProp(ctx.global, name, h); h.dispose(); };
    setString('__data', JSON.stringify({ project: snapshot.project, rows: snapshot.rows, scenes: snapshot.scenes, cast: snapshot.cast }));
    const q = ctx.newFunction('__query', (arg) => ctx.newString(queryFn(ctx.getString(arg))));
    ctx.setProp(ctx.global, '__query', q);
    q.dispose();
    const lg = ctx.newFunction('__log', (arg) => { limitLogs(logs, ctx.getString(arg)); return ctx.undefined; });
    ctx.setProp(ctx.global, '__log', lg);
    lg.dispose();

    const pre = ctx.evalCode(PRELUDE, 'prelude.js');
    if (pre.error) { const m = describeError(ctx, pre.error); pre.error.dispose(); return fail(m); }
    pre.value.dispose();

    const wrapped = `(function () {\n  var __r = (function () {\n"use strict";\n${code}\n  })();\n  if (__r === undefined) throw new Error('脚本没有 return 任何值（要 return 一个 op 数组）');\n  var __s = JSON.stringify(__r);\n  if (__s === undefined) throw new Error('脚本返回的值不能序列化成 JSON（不要 return 函数）');\n  return __s;\n})()`;
    const res = ctx.evalCode(wrapped, 'script.js');
    if (res.error) { const m = describeError(ctx, res.error); res.error.dispose(); return fail(m); }
    const text = ctx.getString(res.value);
    res.value.dispose();
    if (text.length > SCRIPT_LIMITS.outputBytes) return { ok: false, error: '脚本返回的内容太大', logs, ms: Date.now() - t0, failure: 'output' };
    let result: unknown;
    try { result = JSON.parse(text); } catch { return { ok: false, error: '脚本返回的不是可序列化的 JSON', logs, ms: Date.now() - t0, failure: 'error' }; }
    return { ok: true, result, logs, ms: Date.now() - t0 };
  } catch (e) {
    return fail((e as Error).message || String(e));
  } finally {
    // a failed teardown (QuickJS asserts / the WASM build aborts) leaks that run's memory for good: never use this module again
    let clean = true;
    try { vm?.dispose(); } catch { clean = false; }
    try { runtime.dispose(); } catch { clean = false; }
    if (!clean) poison();
  }

  function fail(message: string): ScriptRun {
    const over = Date.now() > deadline;
    const memory = /out of memory|memory/i.test(message);
    return {
      ok: false, logs, ms: Date.now() - t0,
      failure: over && /interrupt/i.test(message) ? 'timeout' : memory ? 'memory' : /interrupt/i.test(message) ? 'timeout' : 'error',
      error: message,
    };
  }
};
