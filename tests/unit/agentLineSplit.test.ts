/**
 * S6: the assistant's long-line ops. The server decides from the user's own words whether a line may be cut (`asksForLineSplit`) or shown in
 * full (`asksForDialogExpand`); `split_line` / `dialog_expand` (and `edit_structure split`) are refused otherwise, also through batch_edit and
 * run_script. A split is one undo step, exactly revertible; locked / hand-made lines ask the user. All lines of text are original.
 */
import express from 'express';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogService } from '../../server/assets/indexer';
import { directorRoutes } from '../../server/director/routes';
import { LlmCache } from '../../server/llm/cache';
import { LlmError, zeroUsage, type LlmProvider } from '../../server/llm/provider';
import { loadSandbox, runInSandbox } from '../../server/agent/sandbox';
import { LlmSettings } from '../../server/settings/store';
import { AGENT_SYSTEM } from '../../server/agent/prompt';
import { applyOp } from '../../shared/agent/apply';
import { asksForDialogExpand, asksForLineSplit, requestFlags } from '../../shared/agent/asks';
import { checkOp, DIALOG_EXPAND_NOT_ASKED, LINE_SPLIT_NOT_ASKED } from '../../shared/agent/check';
import { liveForbidden } from '../../shared/agent/ops';
import { planReplay, replayInto } from '../../shared/agent/replay';
import { revertOps } from '../../shared/agent/revert';
import { newLongLines } from '../../shared/agent/verify';
import { clone } from '../../shared/project/mutate';
import { call, makeEnv, sceneOf } from './helpers/agentEnv';
import { cat, directedProject } from './helpers/directorFlow';
import { fitsDialog } from '../../shared/style/dialogLayout';
import { resolveStyle } from '../../shared/style/ournotes';

type Ans = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const LONG = '我跟你说，这次的合宿我已经全部安排好了！民宿、电车票、练习的时间表，连每天晚上吃什么都写好了！……不过，钱的事我还没跟大家商量。';
const PA = '我跟你说，这次的合宿我已经全部安排好了！民宿、电车票、练习的时间表，连每天晚上吃什么都写好了！';
const PB = '……不过，钱的事我还没跟大家商量。';

/** The directed example with one over-long line (the 2nd beat of scene 3). */
function withLong() {
  const p = clone(directedProject());
  const b = p.scenes[2]!.beats[1]!;
  b.text = LONG;
  return { p, id: b.id };
}
const ASK = { lineSplit: true, dialogExpand: false };
const ASK_ALL = { lineSplit: true, dialogExpand: true };
const err = (r: unknown) => JSON.stringify((r as Ans).错误 ?? null);

describe('asksForLineSplit / asksForDialogExpand', () => {
  it.each([
    '这句太长了，帮我拆一下', '把第3句拆开', '把这句断开', '分成两句', '拆成几句吧', '把它分成三段', '切成两句', '这句放不下，修一下', '过长的台词都处理一下',
    '超出对话框的那几句帮我整理', '用户的指令：拆分一下这句', '给它断句',
  ])('split: %s', (t) => expect(asksForLineSplit(t)).toBe(true));
  it.each([
    '把第3句改成特写', '这句台词加个停顿', '台词太长了，改短一点', '台词太长了，换成特写', '把台词里的“拆开”改成“打开”', '把所有台词的情绪改成 sad',
    '这句台词的字幕大一点', '把这两个人分成两组站位', '', '灯的台词说完后黑场', '这一场的台词全部加个停顿',
  ])('not split: %s', (t) => expect(asksForLineSplit(t)).toBe(false));
  it.each([
    '展开显示这句', '把这句台词展开', '显示全部文字', '完整显示这句话', '多显示几行', '显示三行', '超出屏幕也行', '超出对话框也没关系', '这句不要拆，全部显示出来', '三行也可以',
  ])('expand: %s', (t) => expect(asksForDialogExpand(t)).toBe(true));
  it.each([
    '把第3句改成特写', '展开讲讲这个场景', '显示全部角色', '这句台词太长了', '拆开这句', '把台词改成“显示全部”', '', '情绪改成 sad',
  ])('not expand: %s', (t) => expect(asksForDialogExpand(t)).toBe(false));
  it('a short 好 after the assistant asked 要不要拆 / 展开 counts; without that question it does not', () => {
    const hist = [{ role: 'user', content: '第3句有点长' }, { role: 'assistant', content: '这句有 3 行，放不下。要不要把它拆开？' }];
    expect(requestFlags('要', hist)).toEqual({ lineSplit: true, dialogExpand: false });
    expect(requestFlags('好的', [{ role: 'assistant', content: '要不要展开显示？' }])).toEqual({ lineSplit: false, dialogExpand: true });
    expect(requestFlags('好', [{ role: 'assistant', content: '已把第3句改成特写。' }])).toEqual({ lineSplit: false, dialogExpand: false });
    expect(requestFlags('要', [])).toEqual({ lineSplit: false, dialogExpand: false });
  });
});

describe('split_line', () => {
  it('is refused when the user did not ask, and the error says so', () => {
    const { p, id } = withLong();
    const env = makeEnv(p);
    expect(err(call(env, 'split_line', { beatId: id, pieces: [PA, PB] }))).toContain(LINE_SPLIT_NOT_ASKED);
    expect(sceneOf(env).beats.find((b) => b.id === id)!.text).toBe(LONG);
    // the at-a-character split is a cut too
    expect(err(call(env, 'edit_structure', { action: 'split', beatId: sceneOf(env).beats[3]!.id, at: 1 }))).toContain('没有要求');
  });
  it('cuts the line into same-speaker beats with splitFrom, held shots and the emotions given', () => {
    const { p, id } = withLong();
    const env = makeEnv(p);
    env.asks = ASK;
    const s = sceneOf(env);
    const n = s.beats.length;
    const head = s.beats.find((b) => b.id === id)!;
    const shot = { type: head.shot.type, focus: [...head.shot.focus] };
    const r = call(env, 'split_line', { beatId: id, pieces: [PA, PB], emotions: ['happy', 'sad'], reason: '先兴奋后担心' }) as Ans;
    expect(r.错误).toBeUndefined();
    expect(s.beats).toHaveLength(n + 1);
    const i = s.beats.findIndex((b) => b.id === id);
    const [a, b] = [s.beats[i]!, s.beats[i + 1]!];
    expect([a.text, b.text, a.emotion, b.emotion]).toEqual([PA, PB, 'happy', 'sad']);
    expect([b.splitFrom, b.speakerId, b.kind, b.cutIn, b.shot.move, b.shot.type, b.shot.focus]).toEqual([id, head.speakerId, head.kind, 'cut', 'static', shot.type, shot.focus]);
    expect(a.splitFrom).toBeUndefined();
    expect(b.meta).toMatchObject({ source: 'ai', locked: false });
    expect(env.applied).toHaveLength(1);
    for (const x of [a, b]) expect(fitsDialog(x.text, resolveStyle(p.style, s.style).values.dialog, x.variant).over).toBe(false);
    const ids = sceneOf(env).beats.map((x) => x.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
  it('refuses pieces that do not concatenate to the text, pieces that are still too long, and a line that already fits', () => {
    const { p, id } = withLong();
    const env = makeEnv(p);
    env.asks = ASK;
    expect(err(call(env, 'split_line', { beatId: id, pieces: [PA, '……不过，钱的事我还没跟大家商量吧。'] }))).toContain('拼接后与原文不同');
    expect(err(call(env, 'split_line', { beatId: id, pieces: [PA, PB.slice(0, 5)] }))).toContain('漏了');
    const twice = sceneOf(env).beats[2]!;
    twice.text = LONG + LONG;
    expect(err(call(env, 'split_line', { beatId: twice.id, pieces: [LONG.slice(0, 5), (LONG + LONG).slice(5)] }))).toMatch(/超出|行/);
    const short = sceneOf(env).beats[0]!;
    expect(err(call(env, 'split_line', { beatId: short.id, pieces: [short.text.slice(0, 2), short.text.slice(2)] }))).not.toBe('null');
    expect(env.applied).toHaveLength(0);
  });
  it('a locked line goes to the user (needs_unlock); a hand-made one asks to overwrite', () => {
    const { p, id } = withLong();
    p.scenes[2]!.beats[1]!.meta.locked = true;
    const env = makeEnv(p);
    env.asks = ASK;
    const r = call(env, 'split_line', { beatId: id, pieces: [PA, PB] }) as Ans;
    expect(r.待用户确认).toHaveLength(1);
    expect(env.pending).toHaveLength(1);
    expect(sceneOf(env).beats.find((b) => b.id === id)!.text).toBe(LONG);
    const q = withLong();
    q.p.scenes[2]!.beats[1]!.meta.source = 'user';
    const env2 = makeEnv(q.p);
    env2.asks = ASK;
    expect((call(env2, 'split_line', { beatId: q.id, pieces: [PA, PB] }) as Ans).待用户确认).toHaveLength(1);
  });
  it('is one undo step when replayed, and revertOps takes the project back exactly', () => {
    const { p, id } = withLong();
    const env = makeEnv(p);
    env.asks = ASK;
    call(env, 'split_line', { beatId: id, pieces: [PA, PB], emotions: ['happy', 'sad'] });
    const ops = env.applied.map((x) => x.op);
    expect(ops.map((o) => o.op)).toEqual(['beat_split_pieces']);
    const plan = planReplay(p, ops.map((op, k) => ({ id: k, op })), { genId: 'g', now: 1 });
    expect(plan.accepted).toHaveLength(1);
    const replayed = clone(p);
    replayInto(replayed, plan, { genId: 'g', now: 1 });
    expect(replayed.scenes[2]!.beats.map((b) => [b.id, b.text])).toEqual(env.sandbox.scenes[2]!.beats.map((b) => [b.id, b.text]));
    const back = clone(env.sandbox);
    for (const op of revertOps(p, env.sandbox)) {
      const r = checkOp(back, op, { allowLineSplit: true, allowDialogExpand: true });
      expect(r.status, JSON.stringify(r.problems)).not.toBe('invalid');
      applyOp(back, r.op, { genId: 'r', now: 2 });
    }
    expect(back.scenes[2]!.beats.map((b) => [b.id, b.text, b.emotion])).toEqual(p.scenes[2]!.beats.map((b) => [b.id, b.text, b.emotion]));
  });
  it('keys inside the line follow the piece they fall in; fixed durations are shared by length', () => {
    const { p, id } = withLong();
    const sc = p.scenes[2]!;
    sc.beats[1]!.duration = { mode: 'fixed', seconds: 6 };
    const track = sc.tracks.find((t) => t.channel === 'expression')!;
    track.keys.push({ id: 'k_late', at: { beatId: id, offset: 5 }, value: { name: null }, duration: 0, ease: 'inOutQuad', meta: { source: 'ai', locked: false } } as never);
    const env = makeEnv(p);
    env.asks = ASK;
    call(env, 'split_line', { beatId: id, pieces: [PA, PB] });
    const s = sceneOf(env);
    const [a, b] = [s.beats[1]!, s.beats[2]!];
    expect(a.duration.mode).toBe('fixed');
    expect(a.duration.seconds + b.duration.seconds).toBeCloseTo(6, 5);
    const moved = (s.tracks as unknown as Array<{ keys: Array<{ id: string; at: { beatId: string; offset: number } }> }>).flatMap((t) => t.keys).find((k) => k.id === 'k_late')!;
    expect(moved.at.beatId).toBe(b.id);
    expect(moved.at.offset).toBeLessThan(5);
  });
});

describe('dialog_expand', () => {
  it('is refused unless the user asked; works when asked; on=false clears; a line that fits is refused', () => {
    const { p, id } = withLong();
    const env = makeEnv(p);
    expect(err(call(env, 'dialog_expand', { beatId: id }))).toContain(DIALOG_EXPAND_NOT_ASKED);
    env.asks = ASK; // asking to split is not asking to expand
    expect(err(call(env, 'dialog_expand', { beatId: id }))).not.toBe('null');
    env.asks = ASK_ALL;
    expect(err(call(env, 'dialog_expand', { beatId: id }))).toBe('null');
    expect(sceneOf(env).beats.find((b) => b.id === id)!.overflow).toBe('expand');
    expect(err(call(env, 'dialog_expand', { beatId: id, on: false }))).toBe('null');
    expect(sceneOf(env).beats.find((b) => b.id === id)!.overflow).toBeUndefined();
    expect(err(call(env, 'dialog_expand', { beatId: sceneOf(env).beats[0]!.id }))).not.toBe('null');
  });
  it('batch_edit and run_script cannot get around it', async () => {
    await loadSandbox();
    const { p, id } = withLong();
    const env = makeEnv(p);
    env.scriptRunner = runInSandbox;
    // neither tool is even offered to batch_edit, and its edit_structure only deletes
    expect(JSON.stringify(call(env, 'batch_edit', { tool: 'dialog_expand', args: { on: true }, target: { beatIds: [id] } }))).toContain('错误');
    expect(JSON.stringify(call(env, 'batch_edit', { tool: 'edit_structure', args: { action: 'split', at: 3 }, target: { beatIds: [id] } }))).toContain('只支持');
    expect(JSON.stringify(call(env, 'batch_edit', { op: { op: 'dialog_expand', on: true }, target: { beatIds: [id] } }))).toMatch(/不支持|错误/);
    expect(JSON.stringify(call(env, 'batch_edit', { tool: 'split_line', args: { pieces: [PA, PB] }, target: { beatIds: [id] } }))).toContain('错误');
    const code = `return [op.raw({ op: 'dialog_expand', sceneId: ${JSON.stringify(p.scenes[2]!.id)}, beatId: ${JSON.stringify(id)}, on: true }), op.raw({ op: 'beat_split_pieces', sceneId: ${JSON.stringify(p.scenes[2]!.id)}, beatId: ${JSON.stringify(id)}, pieces: [{ text: ${JSON.stringify(PA)} }, { text: ${JSON.stringify(PB)} }], newIds: ['zz_1'] })];`;
    expect(JSON.stringify(call(env, 'run_script', { description: 't', code }))).toContain('用户');
    expect(env.applied).toHaveLength(0);
    expect(sceneOf(env).beats.find((b) => b.id === id)!.overflow).toBeUndefined();
    // with the user's words it goes through
    env.asks = ASK_ALL;
    const ok = call(env, 'run_script', { description: 't', code: `return [op.raw({ op: 'dialog_expand', sceneId: ${JSON.stringify(p.scenes[2]!.id)}, beatId: ${JSON.stringify(id)}, on: true })];` });
    expect(JSON.stringify(ok)).not.toContain('"错误"');
    expect(sceneOf(env).beats.find((b) => b.id === id)!.overflow).toBe('expand');
  });
  it('an op that sets expand while the user did not ask is invalid at checkOp; replay trusts the server', () => {
    const { p, id } = withLong();
    const raw = { op: 'dialog_expand', sceneId: p.scenes[2]!.id, beatId: id, on: true };
    expect(checkOp(p, raw, { catalog: cat }).status).toBe('invalid');
    expect(checkOp(p, raw, { catalog: cat, allowDialogExpand: true }).status).toBe('ok');
    expect(planReplay(p, [{ id: 1, op: raw as never }], { genId: 'g', now: 1 }).accepted).toHaveLength(1);
  });
  it('an expanded line needs a confirmation to be split', () => {
    const { p, id } = withLong();
    p.scenes[2]!.beats[1]!.overflow = 'expand';
    const r = checkOp(p, { op: 'beat_split_pieces', sceneId: p.scenes[2]!.id, beatId: id, pieces: [{ text: PA }, { text: PB }], newIds: ['x_9'] }, { allowLineSplit: true });
    expect(r.status).toBe('needs_confirm');
  });
  it('both ops are forbidden in live mode', () => {
    expect(liveForbidden({ op: 'dialog_expand', sceneId: 's', beatId: 'b', on: true })).toBe(true);
    expect(liveForbidden({ op: 'beat_split_pieces', sceneId: 's', beatId: 'b', pieces: [{ text: 'a' }, { text: 'b' }], newIds: ['c'] })).toBe(true);
  });
});

describe('seeing long lines', () => {
  it('get_scene flags them, get_beat says so, query_beats filters by lines / overflow / expanded', () => {
    const { p, id } = withLong();
    const env = makeEnv(p);
    expect(String(call(env, 'get_scene', { sceneId: p.scenes[2]!.id }))).toMatch(/超长:\d\/2行/);
    expect(String(call(env, 'get_beat', { beatId: id }))).toContain('超长');
    const q = String(call(env, 'query_beats', { filter: { overflow: true } }));
    expect(q).toContain('命中 1 句');
    expect(q).toContain(id);
    expect(String(call(env, 'query_beats', { filter: { linesMin: 3 } }))).toContain(id);
    env.sandbox.scenes[2]!.beats[1]!.overflow = 'expand';
    expect(String(call(env, 'query_beats', { filter: { overflow: true } }))).toContain('命中 0');
    expect(String(call(env, 'query_beats', { filter: { expanded: true } }))).toContain('命中 1 句');
    expect(String(call(env, 'get_scene', { sceneId: p.scenes[2]!.id }))).toMatch(/展开:\d行/);
  });
  it('a text edit that leaves the line too long only gives a hint, and newLongLines lists it', () => {
    const p = clone(directedProject());
    const env = makeEnv(p);
    const b = sceneOf(env).beats[1]!;
    const r = call(env, 'edit_beat', { beatId: b.id, text: LONG }) as Ans;
    expect(JSON.stringify(r.提示)).toContain('超过对话框');
    expect(sceneOf(env).beats).toHaveLength(p.scenes[2]!.beats.length);
    expect(newLongLines(p, env.sandbox).map((x) => x.beatId)).toEqual([b.id]);
    expect(newLongLines(env.sandbox, env.sandbox)).toEqual([]);
  });
  it('the agent prompt carries the unasked-split rule', () => {
    expect(AGENT_SYSTEM).toContain('split_line');
    expect(AGENT_SYSTEM).toContain('dialog_expand');
  });
});

describe('POST /api/director/split-lines', () => {
  let tmp: string;
  const servers: Server[] = [];
  const post = (b: string, body: unknown) => fetch(`${b}/api/director/split-lines`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function serve(settings: LlmSettings): Promise<string> {
    const app = express();
    app.use(directorRoutes({ settings, cache: new LlmCache(path.join(tmp, 'cache')), catalog: { get: async () => ({ ...cat, version: 'v-test' }) } as unknown as CatalogService }));
    const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }
  const state = { calls: 0 };
  const provider: LlmProvider = {
    id: 'openai', model: 'mock', maxOutputTokens: 16000,
    test: async () => ({ model: 'mock', latencyMs: 1 }),
    generateStructured: async (req) => {
      if (req.schemaName !== 'LineSplit') throw new LlmError('bad_request', 'only LineSplit expected');
      state.calls++;
      const lines = (req.input as { lines: Array<{ id: string }> }).lines;
      const out = { lines: lines.map((l) => ({ id: l.id, pieces: [{ text: PA, why: '一层意思', emotion: 'happy', camera: 'hold' }, { text: PB, why: '转折', emotion: 'sad', camera: 'hold' }] })) };
      const parsed = req.schema.safeParse(out);
      if (!parsed.success) throw new LlmError('invalid_output', 'schema');
      return { data: parsed.data as never, usage: zeroUsage(), raw: JSON.stringify(out), warnings: [] };
    },
  };
  beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'splitlines-')); });
  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('with a model: returns the pieces of the named long lines and applies nothing; fitting / locked lines are reported as skipped', async () => {
    const { p, id } = withLong();
    p.scenes[2]!.beats[3]!.text = LONG;
    p.scenes[2]!.beats[3]!.meta.locked = true;
    const lockedId = p.scenes[2]!.beats[3]!.id;
    const fitId = p.scenes[2]!.beats[0]!.id;
    const base = await serve(new LlmSettings({ file: path.join(tmp, 'a.json'), env: {}, fixtureProvider: () => provider }));
    const r = await post(base, { project: p, sceneId: p.scenes[2]!.id, beatIds: [id, lockedId, fitId, 'nope'] });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.engine).toBe('ai');
    expect(j.splits).toHaveLength(1);
    expect(j.splits[0]).toMatchObject({ beatId: id, by: 'ai' });
    expect(j.splits[0].pieces.map((x: { text: string }) => x.text)).toEqual([PA, PB]);
    expect(j.splits[0].pieces.map((x: { emotion: string }) => x.emotion)).toEqual(['happy', 'sad']);
    expect(new Map(j.skipped.map((s: { beatId: string; reason: string }) => [s.beatId, s.reason])).get(lockedId)).toContain('锁定');
    expect(j.skipped.map((s: { beatId: string }) => s.beatId).sort()).toEqual([fitId, lockedId, 'nope'].sort());
    expect(state.calls).toBe(1);
    const ck = checkOp(p, { op: 'beat_split_pieces', sceneId: p.scenes[2]!.id, beatId: id, pieces: j.splits[0].pieces.map((x: { text: string }) => ({ text: x.text })), newIds: ['n_1'] }, { allowLineSplit: true });
    expect(ck.status).toBe('ok');
  });
  it('without a model: the rule splitter answers (no error), and a bad request is a 400', async () => {
    const { p, id } = withLong();
    const base = await serve(new LlmSettings({ file: path.join(tmp, 'b.json'), env: {} }));
    const r = await post(base, { project: p, sceneId: p.scenes[2]!.id, beatIds: [id] });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.engine).toBe('rule');
    expect(j.splits).toHaveLength(1);
    expect(j.splits[0].by).toBe('rule');
    expect(j.splits[0].pieces.map((x: { text: string }) => x.text).join('')).toBe(LONG);
    expect((await post(base, { project: p, sceneId: 'nope' })).status).toBe(400);
  });
});
