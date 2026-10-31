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
import { clone, moveBeat, removeBeat } from '../../shared/project/mutate';
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
  // The acceptance reviewer's 30 phrasings: [text, asks split, asks expand]
  it.each<[string, boolean, boolean]>([
    ['第5句太长了，帮我拆一下', true, false], ['这句放不下，处理一下', true, false], ['把过长的台词都修一下', true, false], ['这句话分两次说吧', true, false],
    ['第3句显示不全，帮我断一下句', true, false], ['这句台词太长了，切一下', true, false], ['这句话太长，分开说', true, false], ['能不能把这段独白拆成三句', true, false],
    ['这一句超出对话框了，帮我分段', true, false], ['长台词按情绪断开', true, false],
    ['这句不要拆，完整显示就行', false, true], ['这句全部显示出来，超出屏幕也没关系', false, true], ['让这句台词展开显示', false, true], ['对话框显示四行也可以', false, true],
    ['这句话一次性显示完整，别拆开', false, true],
    ['把第3句的镜头切成特写', false, false], ['第3句切成近景', false, false], ['这个停顿太长了，处理一下', false, false], ['这个镜头太长了，修一下', false, false],
    ['让所有人都完整显示在画面里', false, false], ['让情绪在这一句慢慢展开', false, false], ['把这个场景拆成两个场景', false, false], ['把第二章分成两段', false, false],
    ['爱音和灯的对话之间断开一下，加个停顿', false, false], ['把第5句改短一点', false, false], ['这句台词太长了，精简一下', false, false], ['显示全部角色的表情', false, false],
    ['第4句的推镜太长了，弄短点', false, false], ['把“拆开”这个词改成“分开”', false, false], ['把背景切成夜晚', false, false],
  ])('reviewer phrasing: %s', (t, split, expand) => {
    expect(asksForLineSplit(t)).toBe(split);
    expect(asksForDialogExpand(t)).toBe(expand);
  });
  it.each([
    '切一下这句', '这句分开说', '帮我把这句分段', '这句话帮我断一下句', '把这句台词切开', '这句独白拆成两句',
    '别的不用管，把第2句拆开', '这句话太长了，别拆开，帮我把第4句拆开',
  ])('more split requests: %s', (t) => expect(asksForLineSplit(t)).toBe(true));
  it.each([
    '别拆开', '不要拆', '这句话不用拆', '先不要分句', '不要把这句断开', '别切', '镜头切一下', '把镜头切成两段', '把第三场分成两段', '把背景拆开', '人物分开站',
    '把这两个人分成两组', '对话之间停顿久一点', '这句停顿太长，处理一下', '节奏太长了，整理一下', '场景切换太长了修一下',
  ])('not a split request: %s', (t) => expect(asksForLineSplit(t)).toBe(false));
  it.each([
    '不要把第三句台词拆开', '别把立希那句切开', '请不要把素世的独白断开', '别把立希那句切开，完整显示吧', '不要把立希那句台词拆开，给它换个近景就行',
  ])('a longer object between the negation and the verb is still a refusal: %s', (t) => expect(asksForLineSplit(t)).toBe(false));
  it.each(['长的那几句台词，麻烦分开来说', '这句话分开来说'])('分开来说 is a split request: %s', (t) => expect(asksForLineSplit(t)).toBe(true));
  it.each(['让情绪慢慢展开', '让所有人完整显示在镜头里', '全员完整显示在画面里', '表情展开一点'])('not an expand request: %s', (t) => expect(asksForDialogExpand(t)).toBe(false));
  it.each(['让这个人的台词完整显示', '把角色的字幕全部显示'])('still an expand request: %s', (t) => expect(asksForDialogExpand(t)).toBe(true));
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
  describe('the editor auto split carries the performance and camera of the model (F3)', () => {
    const P1 = '……不过，钱的事';
    const P2 = '我还没跟大家商量。';
    const run = (travel: boolean, pieceExtra: Record<string, unknown>[]) => {
      const { p, id } = withLong();
      p.scenes[2]!.beats[1]!.kind = 'dialogue';
      p.scenes[2]!.beats[1]!.speakerId = 'c_005';
      p.settings = { ...p.settings, cameraSystem: travel ? 'travel' : 'classic' };
      const s = p.scenes[2]!;
      const head = s.beats[1]!;
      const speaker = head.speakerId!;
      const listener = Object.keys(s.wardrobe).find((c) => c !== speaker)!;
      const op = {
        op: 'beat_split_pieces' as const, sceneId: s.id, beatId: id, newIds: ['x_b1', 'x_b2'],
        pieces: [{ text: PA }, { text: P1, ...pieceExtra[0] }, { text: P2, ...pieceExtra[1] }],
      };
      const r = checkOp(p, op as never, { allowLineSplit: true });
      expect(r.status, JSON.stringify(r.problems)).not.toBe('invalid');
      const after = clone(p);
      const ar = applyOp(after, r.op, { genId: 'g', now: 5 });
      expect(ar.ok).toBe(true);
      return { p, after, r, id, speaker, listener, head, scene: after.scenes[2]! };
    };

    it('a closer piece takes one step tighter, a hold after it keeps that framing, the performance keys sit in the piece (travel)', () => {
      const x = run(true, [{ camera: 'closer', why: '说到钱的事，语气一沉', motion: 'thinking01', expression: 'sad01', attention: 'down' }, {}]);
      const [h, a, b] = x.scene.beats.slice(1, 4);
      expect(h!.id).toBe(x.id);
      expect(a!.id).toBe('x_b1');
      const tight = { ms: 'mcu', mcu: 'cu', cu: 'ecu', ecu: 'ecu', group: 'mcu', two_shot: 'mcu' }[x.head.shot.type as string];
      expect(a!.shot).toMatchObject({ type: tight, focus: [x.speaker], move: 'static', intent: 'emphasis' });
      expect(b!.shot).toMatchObject({ type: tight, focus: [x.speaker], move: 'static', intent: 'continue' });
      expect(h!.shot.type).toBe(x.head.shot.type);
      expect(a!.meta.reason).toBe('说到钱的事，语气一沉');
      const keys = (ch: string) => (x.scene.tracks as unknown as Array<{ channel: string; target: { kind: string; castId?: string }; keys: Array<{ at: { beatId: string }; value: unknown }> }>).filter((t) => t.channel === ch && t.target.kind === 'actor' && t.target.castId === x.speaker).flatMap((t) => t.keys).filter((k) => k.at.beatId === 'x_b1');
      expect(keys('motion').map((k) => k.value)).toEqual([{ name: 'thinking01' }]);
      expect(keys('expression').map((k) => k.value)).toEqual([{ name: 'sad01' }]);
      expect(keys('gaze').map((k) => k.value)).toEqual([{ target: 'down' }]);
      expect(x.r.warnings.join()).not.toContain('降级');
    });

    it('classic: no intent on the pieces; a reaction is a close-up of the listener', () => {
      const x0 = run(false, [{ camera: 'closer', why: '说到钱的事，语气一沉' }, {}]);
      const [, a0, b0] = x0.scene.beats.slice(1, 4);
      expect(a0!.shot.intent).toBeUndefined();
      expect(b0!.shot.intent).toBeUndefined();
      expect(b0!.shot.type).toBe(a0!.shot.type);
      const probe = run(false, [{}, {}]);
      const x = run(true, [{ camera: 'reaction', reactionOf: probe.listener, why: '听到钱的事对方愣住' }, {}]);
      const [, a, b] = x.scene.beats.slice(1, 4);
      expect(a!.shot).toMatchObject({ type: 'cu', focus: [x.listener], intent: 'reaction', transition: 'cut' });
      // after a reaction the speaker's own framing is back
      expect(b!.shot).toMatchObject({ type: x.head.shot.type, intent: 'continue' });
    });

    it('the same soft repair as the generation: a vague reason, a second camera change and a listener that is not on stage drop to hold, with warnings', () => {
      const x = run(true, [{ camera: 'closer', why: '强调' }, { camera: 'reaction', reactionOf: 'c_nobody', why: '对方愣住了很久' }]);
      const [, a, b] = x.scene.beats.slice(1, 4);
      expect(a!.shot).toMatchObject({ type: x.head.shot.type, intent: 'continue' });
      expect(b!.shot).toMatchObject({ type: x.head.shot.type, intent: 'continue' });
      expect(x.r.warnings.join()).toContain('没有写出具体的故事理由');
      expect(x.r.warnings.join()).toContain('听者不在台上');
    });

    it('without any extra fields it is exactly the old behaviour, and revertOps restores the line exactly', () => {
      const x = run(true, [{}, {}]);
      const [, a, b] = x.scene.beats.slice(1, 4);
      expect([a!.shot.type, b!.shot.type]).toEqual([x.head.shot.type, x.head.shot.type]);
      const back = clone(x.after);
      for (const op of revertOps(x.p, x.after)) {
        const r = checkOp(back, op, { allowLineSplit: true, allowDialogExpand: true });
        expect(r.status, JSON.stringify(r.problems)).not.toBe('invalid');
        applyOp(back, r.op, { genId: 'r', now: 9 });
      }
      expect(JSON.stringify(back.scenes[2]!.beats.map((q) => [q.id, q.text, q.splitFrom]))).toBe(JSON.stringify(x.p.scenes[2]!.beats.map((q) => [q.id, q.text, q.splitFrom])));
    });
    it('a closer with performance keys reverts exactly (keys included)', () => {
      const x = run(true, [{ camera: 'closer', why: '说到钱的事，语气一沉', motion: 'thinking01', attention: 'down' }, {}]);
      const back = clone(x.after);
      for (const op of revertOps(x.p, x.after)) {
        const r = checkOp(back, op, { allowLineSplit: true, allowDialogExpand: true });
        expect(r.status, JSON.stringify(r.problems)).not.toBe('invalid');
        applyOp(back, r.op, { genId: 'r', now: 9 });
      }
      const norm = (q: typeof back) => JSON.stringify({ b: q.scenes[2]!.beats.map((z) => [z.id, z.text, z.splitFrom]), k: q.scenes[2]!.tracks.map((t) => [t.channel, t.keys.map((k) => k.at.beatId)]).filter((t) => (t[1] as string[]).length) });
      expect(norm(back)).toBe(norm(x.p));
    });
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

describe('split groups survive delete / move / merge (F4)', () => {
  const P1 = '……不过，钱的事';
  const P2 = '我还没跟大家商量。';
  /** The long line cut into three: [..., H, x_b1, x_b2, ...] in scene 3, with the beats around it. */
  function grouped() {
    const { p, id } = withLong();
    const r = checkOp(p, { op: 'beat_split_pieces', sceneId: p.scenes[2]!.id, beatId: id, newIds: ['x_b1', 'x_b2'], pieces: [{ text: PA }, { text: P1 }, { text: P2 }] } as never, { allowLineSplit: true });
    expect(r.status, JSON.stringify(r.problems)).not.toBe('invalid');
    applyOp(p, r.op, { genId: 'g', now: 1 });
    const s = p.scenes[2]!;
    const i = s.beats.findIndex((b) => b.id === id);
    return { p, sid: s.id, H: id, before: s.beats[i - 1]!.id, after: s.beats[i + 3]!.id };
  }
  const run = (p: ReturnType<typeof grouped>['p'], op: Record<string, unknown>) => {
    const w = clone(p);
    const r = checkOp(w, { sceneId: p.scenes[2]!.id, ...op } as never, { allowLineSplit: true });
    expect(r.status, JSON.stringify(r.problems)).not.toBe('invalid');
    applyOp(w, r.op, { genId: 'g2', now: 2 });
    return w;
  };
  const shape = (p: ReturnType<typeof grouped>['p']) => p.scenes[2]!.beats.map((b) => `${b.id}${b.splitFrom ? '<' + b.splitFrom : ''}`);
  /** revertOps takes the project back to the order and the groups it had. */
  const reverts = (before: ReturnType<typeof grouped>['p'], after: ReturnType<typeof grouped>['p']) => {
    const back = clone(after);
    for (const op of revertOps(before, after)) {
      const r = checkOp(back, op, { allowLineSplit: true, allowDialogExpand: true });
      expect(r.status, JSON.stringify(r.problems)).not.toBe('invalid');
      applyOp(back, r.op, { genId: 'r', now: 9 });
    }
    expect(shape(back)).toEqual(shape(before));
    expect(back.scenes[2]!.beats.map((b) => b.text)).toEqual(before.scenes[2]!.beats.map((b) => b.text));
  };

  it('the grouped fixture is H, x_b1, x_b2 with the pieces pointing at H', () => {
    const g = grouped();
    const s = shape(g.p);
    const i = s.indexOf(g.H);
    expect(s.slice(i, i + 3)).toEqual([g.H, `x_b1<${g.H}`, `x_b2<${g.H}`]);
  });
  it('deleting the first piece makes the next piece the line and the one after it follows; revert restores the group', () => {
    const g = grouped();
    const w = run(g.p, { op: 'beat_delete', beatId: g.H });
    const s = shape(w);
    expect(s).toContain('x_b1');
    expect(s).toContain('x_b2<x_b1');
    expect(s.some((x) => x.includes('<' + g.H))).toBe(false);
    reverts(g.p, w);
  });
  it('deleting a middle piece keeps the rest of the group; deleting the last one too', () => {
    const g = grouped();
    const w = run(g.p, { op: 'beat_delete', beatId: 'x_b1' });
    expect(shape(w)).toContain(`x_b2<${g.H}`);
    reverts(g.p, w);
    expect(shape(run(g.p, { op: 'beat_delete', beatId: 'x_b2' }))).toContain(`x_b1<${g.H}`);
  });
  it('merging the first piece with its next piece keeps the group; merging the previous line into the first piece takes the pieces along', () => {
    const g = grouped();
    const w = run(g.p, { op: 'beat_merge', beatId: g.H });
    expect(shape(w)).toContain(`x_b2<${g.H}`);
    expect(w.scenes[2]!.beats.find((b) => b.id === g.H)!.text).toBe(PA + P1);
    reverts(g.p, w);
    const m = run(g.p, { op: 'beat_merge', beatId: g.before });
    const s = shape(m);
    expect(s.includes(`x_b1<${g.before}`) && s.includes(`x_b2<${g.before}`)).toBe(true);
    expect(s.some((x) => x.includes('<' + g.H))).toBe(false);
    reverts(g.p, m);
  });
  it('moving a piece away from its group makes it a plain line; moving the first piece away makes the next one the line; moving a line between the pieces cuts the group', () => {
    const g = grouped();
    const away = run(g.p, { op: 'beat_move', beatId: 'x_b1', afterBeatId: g.after });
    const s = shape(away);
    expect(s).toContain('x_b1');
    expect(s).toContain(`x_b2<${g.H}`);
    reverts(g.p, away);
    const head = run(g.p, { op: 'beat_move', beatId: g.H, afterBeatId: g.after });
    expect(shape(head)).toContain('x_b1');
    expect(shape(head)).toContain('x_b2<x_b1');
    reverts(g.p, head);
    const between = run(g.p, { op: 'beat_move', beatId: g.before, afterBeatId: g.H });
    const b = shape(between);
    expect(b).toContain('x_b1');
    expect(b).toContain('x_b2<x_b1');
    reverts(g.p, between);
  });
  it('moving the first piece to where it already is, or a plain line elsewhere, changes nothing in the groups', () => {
    const g = grouped();
    const w = run(g.p, { op: 'beat_move', beatId: g.after, afterBeatId: null });
    const s = shape(w);
    const i = s.findIndex((x) => x === g.H);
    expect(s.slice(i, i + 3)).toEqual([g.H, `x_b1<${g.H}`, `x_b2<${g.H}`]);
    reverts(g.p, w);
  });
  it('the editor delete / move (mutate) clean up the same way, and projects without continuations are untouched', () => {
    const g = grouped();
    const w = clone(g.p);
    removeBeat(w.scenes[2]!, g.H);
    expect(shape(w)).toContain('x_b2<x_b1');
    const v = clone(g.p);
    moveBeat(v.scenes[2]!, 'x_b2', 0);
    expect(shape(v)[0]).toBe('x_b2');
    const plain = withLong();
    removeBeat(plain.p.scenes[2]!, plain.p.scenes[2]!.beats[0]!.id);
    moveBeat(plain.p.scenes[2]!, plain.p.scenes[2]!.beats[3]!.id, 0);
    expect(plain.p.scenes[2]!.beats.every((b) => b.splitFrom === undefined)).toBe(true);
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
