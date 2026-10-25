import { beforeAll, describe, expect, it } from 'vitest';
import { loadSandbox, runInSandbox, sandboxState } from '../../server/agent/sandbox';
import { SCRIPT_LIMITS, snapshotOf } from '../../shared/agent/script';
import { directedProject } from './helpers/directorFlow';

const P = directedProject();
const snap = snapshotOf(P);
const run = (code: string) => runInSandbox(code, snap, () => JSON.stringify({ rows: [] }));
const value = (code: string): unknown => { const r = run(code); if (!r.ok) throw new Error(r.error); return r.result; };

beforeAll(async () => { expect(await loadSandbox()).toBe(true); });

describe('script sandbox: what a script can see', () => {
  it('runs a script on the read-only snapshot and returns plain JSON', () => {
    expect(value('return project.scenes.length')).toBe(P.scenes.length);
    expect(value('return scenes().map(s => s.id)')).toEqual(P.scenes.map((s) => s.id));
    expect(value('return beats(3).length')).toBe(P.scenes[2]!.beats.length);
    expect(value('return beats("s_3")[2].speaker')).toBe('长崎爽世');
    expect(value('return visible(beats(3)[0].beatId).length')).toBe(5);
    expect(value('return op.setShot("s_3b_15", {type: "cu"})')).toEqual({ op: 'shot_set', sceneId: 's_3', beatId: 's_3b_15', set: { type: 'cu' } });
    expect(value('return query({}).length')).toBe(0); // the host answered with the canned reply of this test
  });

  it('console.log is captured (and bounded) for the model to read', () => {
    const r = run('for (let i = 0; i < 50; i++) console.log("line", i, {a: 1}); return []');
    expect(r.logs).toHaveLength(40);
    expect(r.logs[0]).toBe('line 0 {"a":1}');
    // one long line (a whole scene) is kept up to the character budget, then cut with a note
    const long = run('console.log("x".repeat(5000)); console.log("y".repeat(5000)); console.log("z"); return []');
    expect(long.logs[0]).toHaveLength(5000);
    expect(long.logs[1]).toContain('已截断');
    expect(long.logs.join('').length).toBeLessThan(6100);
    // op.setShot takes the set_shot words for the cut style
    expect(value('return op.setShot("s_3b_15", { flow: "cut" })')).toEqual({ op: 'shot_set', sceneId: 's_3', beatId: 's_3b_15', set: { transition: 'cut' } });
    expect(value('return op.setShot("s_3b_15", { flow: "move" }).set')).toEqual({ transition: 'travel' });
  });

  it('the snapshot is frozen: a script cannot change the project it reads', () => {
    expect(run('project.title = "x"; return []').error).toContain('read-only');
    expect(run('project.scenes[0].beats[0].text = "x"; return []').ok).toBe(false);
    expect(run('project.scenes.push({}); return []').ok).toBe(false);
  });

  it('errors come back as results: syntax, thrown, no return, not serialisable', () => {
    expect(run('this is not javascript').error).toContain('SyntaxError');
    expect(run('throw new Error("boom")').error).toContain('boom');
    expect(run('const x = 1;').error).toContain('没有 return');
    expect(run('return () => 1').error).toContain('不能序列化');
    expect(run('const a = {}; a.a = a; return a').ok).toBe(false);
    expect(run('return op.setShot("nope", {})').error).toContain('没有这个 beatId');
    expect(run('return beats(99)').error).toContain('没有第 99 场');
  });
});

describe('script sandbox: security (nothing of the host is reachable)', () => {
  const probes = [
    'typeof process', 'typeof require', 'typeof module', 'typeof exports', 'typeof Buffer', 'typeof fetch', 'typeof XMLHttpRequest', 'typeof WebSocket',
    'typeof setTimeout', 'typeof setInterval', 'typeof setImmediate', 'typeof queueMicrotask', 'typeof __dirname', 'typeof global', 'typeof window', 'typeof document',
    'typeof WebAssembly', 'typeof __data', 'typeof __query', 'typeof __log', 'typeof importScripts', 'typeof std', 'typeof os', 'typeof scriptArgs',
  ];
  it.each(probes)('%s is undefined', (expr) => {
    expect(value(`return ${expr}`)).toBe('undefined');
  });

  it('constructor / eval / globalThis tricks only ever reach the sandbox\'s own world', () => {
    const tricks = [
      'return globalThis.constructor.constructor("return typeof process")()',
      'return eval("typeof process")',
      'return new Function("return typeof require")()',
      'return Object.getPrototypeOf(function* () {}).constructor("yield typeof process")().next().value',
      'return typeof new Function("return this")().process',
      'return typeof globalThis.process + typeof globalThis.require + typeof globalThis.fetch',
      'return Object.getOwnPropertyNames(globalThis).filter(n => /^(process|require|fs|child_process|net|http|__)/.test(n))',
      'return [].constructor.constructor("return typeof process")()',
    ];
    const out = tricks.map((t) => value(t));
    expect(out).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefinedundefinedundefined', [], 'undefined']);
  });

  it('there are no file, network, process or module APIs to call', () => {
    expect(run('return require("fs").readFileSync("C:/Windows/win.ini", "utf8")').error).toMatch(/'require' is not defined/);
    expect(run('return process.env.OPENAI_API_KEY').error).toMatch(/'process' is not defined/);
    expect(run('return fetch("http://127.0.0.1:5274/api/health")').error).toMatch(/'fetch' is not defined/);
    expect(run('return process.exit(1)').ok).toBe(false);
    // there is no module loader and no job queue pump: a dynamic import never resolves to anything, and `await` is not even legal in the body
    expect(value('let r = "pending"; import("node:fs").then(() => { r = "loaded"; }).catch(() => { r = "blocked"; }); return r')).toBe('pending');
    expect(run('const m = await import("node:fs"); return []').error).toContain('SyntaxError');
  });

  it('a script cannot leave anything behind for the next one (fresh interpreter per run) or on the host', () => {
    expect(run('Object.prototype.polluted = 1; Array.prototype.x = 2; globalThis.leak = "x"; return []').ok).toBe(true);
    expect(value('return [typeof ({}).polluted, typeof [].x, typeof globalThis.leak]')).toEqual(['undefined', 'undefined', 'undefined']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).x).toBeUndefined();
  });

  it('the host bridge only takes strings: the query callback gets JSON text, never an object', () => {
    let seen: unknown;
    const r = runInSandbox('return query({speaker: "x"}).length', snap, (arg) => { seen = arg; return JSON.stringify({ rows: [{}, {}] }); });
    expect(r.result).toBe(2);
    expect(typeof seen).toBe('string');
    expect(JSON.parse(seen as string)).toEqual({ speaker: 'x' });
    expect(runInSandbox('return query({})', snap, () => JSON.stringify({ error: ['坏条件'] })).error).toContain('坏条件');
  });
});

describe('script sandbox: limits', () => {
  it('an infinite loop is interrupted at the CPU limit and the host carries on', () => {
    const t0 = Date.now();
    const r = run('while (true) {}');
    const ms = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('timeout');
    expect(ms).toBeGreaterThanOrEqual(SCRIPT_LIMITS.cpuMs - 100);
    expect(ms).toBeLessThan(SCRIPT_LIMITS.cpuMs + 2500);
    expect(value('return 1 + 1')).toBe(2);
  });

  it('runaway recursion and a busy promise/async loop end as errors, not a crash', () => {
    expect(run('function f() { return f() + 1 } return f()').ok).toBe(false);
    expect(run('for (let i = 0; i < 1e12; i++) {} return []').failure).toBe('timeout');
  });

  it('a memory blow-up hits the memory limit (the host process is untouched)', () => {
    const before = process.memoryUsage().rss;
    const r = run('const a = []; for (;;) a.push("x".repeat(1000000)); ');
    expect(r.ok).toBe(false);
    expect(['memory', 'timeout']).toContain(r.failure);
    if (r.failure === 'memory') expect(r.error).toMatch(/memory/i);
    // 64 MB of interpreter memory, not gigabytes
    expect(process.memoryUsage().rss - before).toBeLessThan(200 * 1024 * 1024);
    expect(value('return "alive"')).toBe('alive');
    expect(run('return new Array(1e9).fill(0).length').ok).toBe(false);
    expect(run('return "x".repeat(2e9).length').ok).toBe(false);
  });

  it('too large an output is refused', () => {
    const r = run('return ["x".repeat(500000)]');
    expect(r.ok).toBe(false);
    expect(r.failure).toBe('output');
  });

  it('runs that cannot be torn down (stack overflow with a full heap) never leave the sandbox out of memory for good', async () => {
    const overflow = 'var a = []; for (var i = 0; i < 200000; i++) a.push({ i: i, s: "x" + i }); function f(n) { return f(n + 1) + 1 } f(0)';
    const normal = 'var a = []; for (var i = 0; i < 300000; i++) a.push({ i: i }); return [a.length]';
    await loadSandbox();
    for (let i = 0; i < 6; i++) {
      expect(run(overflow).ok).toBe(false);
      expect(sandboxState().ready).toBe(true); // the spare took over at once
      expect(value(normal)).toEqual([300000]);
      await loadSandbox(); // refills the spare (the agent loop does this at the start of every turn; it is also already loading)
    }
  }, 60_000);
});

describe('script sandbox: helpers forgive the usual slips', () => {
  it('beats() takes a scenes() entry or a row, and says what it wants when given nothing', () => {
    expect(value('return beats(scenes()[2]).length')).toBe(P.scenes[2]!.beats.length);
    expect(value('return beats(beats(3)[0]).length')).toBe(P.scenes[2]!.beats.length);
    expect(run('return beats(scenes()[0].sceneId)').error).toContain('要给出场景');
  });
});
