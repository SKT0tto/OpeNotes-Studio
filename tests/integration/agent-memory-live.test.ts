/**
 * MANUAL live evaluation of the assistant's long-term memory against a real model (skipped unless LLM_LIVE=1):
 *   LLM_LIVE=1 npm run test:integration -- agent-memory-live
 * Uses the provider of .env (e.g. DeepSeek deepseek-flash) and only the shareable sample story in examples/. Never prints the key.
 * Raw outputs (every turn: memory events, ops, summary, trace) go to dev-notes/memory-eval/ (gitignored). The director part compares
 * whole-scene generations with and without style memories (classic and travel).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../server/assets/indexer';
import { loadConfig } from '../../server/config';
import { runAgentTurn, type AgentTurnResult } from '../../server/agent/loop';
import { InMemoryMemories } from '../../server/agent/memoryStore';
import { LlmCache } from '../../server/llm/cache';
import { runBreakdown } from '../../server/llm/director';
import { runScene, type SceneResult } from '../../server/llm/sceneRunner';
import type { LlmProvider } from '../../server/llm/provider';
import { LlmSettings, loadDotEnv } from '../../server/settings/store';
import type { HistoryTurn } from '../../shared/agent/history';
import { directorMemories, directorPreferences, memoryReviewInstruction as reviewInstruction, type Memory, type MemoryKind } from '../../shared/agent/memory';
import type { AgentOp } from '../../shared/agent/ops';
import type { Catalog } from '../../shared/schema/assets';
import type { Beat, Project } from '../../shared/schema/project';

const LIVE = process.env.LLM_LIVE === '1';
const config = loadConfig();
const haveAssets = fs.existsSync(path.join(config.assetRoot, 'models'));
const OUT = path.resolve('dev-notes', 'memory-eval');
const ONLY = process.env.MEM_EVAL_ONLY ? new Set(process.env.MEM_EVAL_ONLY.split(',')) : null;

interface Outcome { id: string; title: string; pass: boolean; why: string; detail: unknown }
const outcomes: Outcome[] = [];
const record = (o: Outcome) => {
  outcomes.push(o);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${o.id}.json`), JSON.stringify(o, null, 1));
};

let mem = 0;
const m = (text: string, kind: MemoryKind, over: Partial<Memory> = {}): Memory => ({ id: `m_${++mem}`, text, kind, scope: 'global', enabled: true, origin: 'stated', createdAt: 1, updatedAt: 1, ...over });

describe.skipIf(!LIVE || !haveAssets)('live: assistant memory', () => {
  let cat: Catalog;
  let provider: LlmProvider;
  let cache: LlmCache;
  let skeleton: Project;
  let project: Project;
  const baseScenes = new Map<string, SceneResult>();

  beforeAll(async () => {
    loadDotEnv('.env');
    cat = await buildCatalog({ assetRoot: config.assetRoot, audioRoots: config.audioRoots });
    const p = new LlmSettings({ file: path.join(os.tmpdir(), 'mem-live-settings.json'), env: process.env }).provider();
    if (!p.provider) throw new Error(p.message);
    provider = p.provider;
    cache = new LlmCache(path.join(OUT, 'cache'));
    const story = fs.readFileSync('examples/mygo-rehearsal.txt', 'utf8');
    const bd = await runBreakdown({ provider, cache, catalog: cat }, story, '迷子们的排练日', 'g1');
    skeleton = bd.project;
    project = structuredClone(skeleton);
    for (const s of skeleton.scenes) {
      const r = await runScene({ provider, cache, catalog: cat }, { project: skeleton, sceneId: s.id, scopes: ['scene'] }, 'g2');
      baseScenes.set(s.id, r);
      project.scenes = project.scenes.map((x) => (x.id === s.id ? r.scene : x));
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'project.json'), JSON.stringify(project, null, 1));
  }, 1_800_000);

  const name = (b: Beat) => project.cast.find((c) => c.id === b.speakerId)?.displayName ?? '';
  const find = (speaker: string, text: string) => {
    for (const s of project.scenes) for (const b of s.beats) if (name(b).includes(speaker) && b.text.includes(text)) return { scene: s, beat: b };
    throw new Error(`no beat ${speaker} ${text}`);
  };
  const castOf = (n: string) => project.cast.find((c) => c.displayName.includes(n))!;
  const agent = async (instruction: string, store: InMemoryMemories, at: { scene: Project['scenes'][number]; beat?: Beat }, history: HistoryTurn[] = [], proj = project): Promise<AgentTurnResult> =>
    runAgentTurn({ provider, catalog: cat, director: { provider, cache, catalog: cat }, memory: store, genId: 'eval' },
      { project: proj, selection: { sceneId: at.scene.id, beatId: at.beat?.id ?? null }, instruction, history, limits: { maxSteps: 24 } });
  const brief = (r: AgentTurnResult) => ({ summary: r.summary, memory: r.memory, ops: r.applied.map((x) => x.op), pending: r.pending.map((x) => x.op), steps: r.steps, stopped: r.stopped, trace: r.trace.map((t) => ({ text: t.text, calls: t.calls.map((c) => ({ name: c.name, args: c.args, result: c.result.slice(0, 400) })) })) });
  const ops = (r: AgentTurnResult, op: string) => r.applied.map((x) => x.op).filter((o) => o.op === op) as Array<AgentOp & Record<string, unknown>>;
  const run = (id: string, title: string, f: () => Promise<{ pass: boolean; why: string; detail: unknown }>) =>
    it.skipIf(ONLY && !ONLY.has(id))(`${id} ${title}`, async () => {
      try { record({ id, title, ...(await f()) }); } catch (e) { record({ id, title, pass: false, why: `error: ${(e as Error).message}`, detail: null }); }
    }, 600_000);

  // ---- learning and applying ---------------------------------------------------------------------------------------------
  run('A01', '记住偏好（回忆用色带边），对话 2 加回忆时照做', async () => {
    const store = new InMemoryMemories();
    const at = find('灯', '我会写完的');
    const r1 = await agent('记住：以后加回忆效果一律用色带边，不要雾边。', store, at);
    const mm = store.file.memories;
    const r2 = await agent('这一句加回忆效果', store, at);
    const fx = ops(r2, 'fx_range').find((o) => o.fx === 'memory');
    const pass = mm.length === 1 && mm[0]!.kind === 'fx' && !!fx && fx.edge === 'bands';
    return { pass, why: `saved=${mm.map((x) => `${x.kind}:${x.text}`).join('|')} edge=${String(fx?.edge)}`, detail: { r1: brief(r1), r2: brief(r2), memories: mm } };
  });
  run('A02', '记住「少用特写」，对话 2 推近时不到 cu/ecu', async () => {
    const store = new InMemoryMemories();
    // a wide beat: 「推近很多」 is two steps on the ladder (two_shot -> cu) without the preference
    const sc = project.scenes.find((s) => s.beats.some((x) => x.shot.type === 'two_shot' || x.shot.type === 'group'))!;
    const at = { scene: sc, beat: sc.beats.find((x) => x.shot.type === 'two_shot' || x.shot.type === 'group')! };
    const r1 = await agent('特写别用这么多，以后推近最多推到胸像就行。', store, at);
    const r2 = await agent('这里镜头推近很多', store, at);
    const shot = ops(r2, 'shot_set')[0] as { set?: { type?: string } } | undefined;
    const before = at.beat.shot.type;
    const pass = store.file.memories.length === 1 && store.file.memories[0]!.kind === 'camera' && (!shot || !['cu', 'ecu'].includes(shot.set?.type ?? ''));
    return { pass, why: `saved=${store.file.memories.map((x) => x.text).join('|')} before=${before} after=${String(shot?.set?.type)}`, detail: { r1: brief(r1), r2: brief(r2) } };
  });
  run('A03', '角色偏好（灯说话时镜头别晃）存成本项目 + castId', async () => {
    const store = new InMemoryMemories();
    const r = await agent('记住，这个项目里灯说话的时候镜头别晃。', store, { scene: project.scenes[0]! });
    const x = store.file.memories[0];
    const pass = store.file.memories.length === 1 && x?.scope === 'project' && x.castId === castOf('灯').id && r.applied.length === 0;
    return { pass, why: JSON.stringify(x ?? null), detail: brief(r) };
  });
  run('A04', '全局偏好（不管哪个项目，回忆都用暖色调）存成 global', async () => {
    const store = new InMemoryMemories();
    const r = await agent('不管哪个项目，回忆效果都用暖色调，记住。', store, { scene: project.scenes[0]! });
    const x = store.file.memories[0];
    return { pass: store.file.memories.length === 1 && x?.scope === 'global' && x.kind === 'fx', why: JSON.stringify(x ?? null), detail: brief(r) };
  });

  // ---- not saving --------------------------------------------------------------------------------------------------------
  run('B01', '一次性编辑（把这一句改成特写）不进记忆', async () => {
    const store = new InMemoryMemories();
    const at = find('立希', '不能总是拖着');
    const r = await agent('把这一句改成特写', store, at);
    return { pass: r.memory.length === 0 && ops(r, 'shot_set').length > 0, why: `memory=${r.memory.length} shots=${ops(r, 'shot_set').length}`, detail: brief(r) };
  });
  run('B02', '一次性编辑（这句停顿长一点）不进记忆', async () => {
    const store = new InMemoryMemories();
    const at = find('灯', '我知道。我不会迟到的');
    const r = await agent('这句停顿长一点', store, at);
    return { pass: r.memory.length === 0 && r.applied.length > 0, why: `memory=${r.memory.length} ops=${r.applied.length}`, detail: brief(r) };
  });
  run('B03', '一次性编辑（这一场去掉所有特效）不进记忆', async () => {
    const store = new InMemoryMemories();
    const r = await agent('这一场去掉所有特效', store, { scene: project.scenes[2]! });
    return { pass: r.memory.length === 0, why: `memory=${r.memory.length} ops=${r.applied.length}`, detail: brief(r) };
  });
  run('B04', '反复纠正 → 只提议（卡片），不悄悄保存', async () => {
    const store = new InMemoryMemories();
    const a = find('爱音', '给我看看嘛');
    const b = find('立希', '你们太慢了');
    const c = find('爽世', '曲子定下来了吗');
    const history: HistoryTurn[] = [
      { role: 'user', content: `镜头推近一点\n（当时的选区：${a.scene.id} ${a.beat.id}）` },
      { role: 'assistant', content: `把这一句推近到近景 cu。\n【这一轮的改动 · 用户已应用】\n- ${a.scene.id} (${a.beat.id}) 景别：胸像 → 近景` },
      { role: 'user', content: '太近了，拉回胸像' },
      { role: 'assistant', content: `改回了胸像 mcu。\n【这一轮的改动 · 用户已应用】\n- ${a.scene.id} (${a.beat.id}) 景别：近景 → 胸像` },
      { role: 'user', content: `这句也推近一点\n（当时的选区：${b.scene.id} ${b.beat.id}）` },
      { role: 'assistant', content: `推近到近景 cu。\n【这一轮的改动 · 用户已应用】\n- ${b.scene.id} (${b.beat.id}) 景别：胸像 → 近景` },
      { role: 'user', content: '又太近了，拉回胸像' },
      { role: 'assistant', content: `改回了胸像 mcu。\n【这一轮的改动 · 用户已应用】\n- ${b.scene.id} (${b.beat.id}) 景别：近景 → 胸像` },
    ];
    const proj = structuredClone(project);
    proj.scenes.find((s) => s.id === c.scene.id)!.beats.find((x) => x.id === c.beat.id)!.shot.type = 'cu';
    const r = await agent('这句也太近了，拉回胸像', store, c, history, proj);
    const proposed = r.memory.filter((e) => e.action === 'proposed');
    const pass = store.file.memories.length === 0 && proposed.length >= 1;
    return { pass, why: `stored=${store.file.memories.length} proposed=${proposed.map((e) => e.action === 'proposed' ? e.proposal.text : '').join('|')}`, detail: brief(r) };
  });

  // ---- forgetting, overriding, precedence, listing -----------------------------------------------------------------------
  run('C01', '按要求忘掉一条记忆', async () => {
    const keep = m('回忆特效用暖色调', 'fx');
    const drop = m('少用特写，推近最多到胸像', 'camera');
    const store = new InMemoryMemories({ memories: [keep, drop] });
    const r = await agent('那条少用特写的偏好不要了，忘掉吧。', store, { scene: project.scenes[0]! });
    return { pass: store.file.memories.map((x) => x.id).join() === keep.id, why: store.file.memories.map((x) => x.text).join('|'), detail: brief(r) };
  });
  run('C02', '这一轮的明确指令优先于记忆（记忆色带，这次要雾边），记忆不删', async () => {
    const store = new InMemoryMemories({ memories: [m('回忆特效一律用色带边（edge=bands）', 'fx')] });
    const at = find('灯', '我会写完的');
    const r = await agent('这一句加回忆效果，这次用雾边', store, at);
    const fx = ops(r, 'fx_range').find((o) => o.fx === 'memory');
    return { pass: !!fx && fx.edge !== 'bands' && store.file.memories.length === 1, why: `edge=${String(fx?.edge)} memories=${store.file.memories.length}`, detail: brief(r) };
  });
  run('C03', '本项目记忆优先于全局记忆（全局冷色、本项目暖色）', async () => {
    const store = new InMemoryMemories({ memories: [m('回忆特效用冷色调（tone=cool）', 'fx'), m('这个项目的回忆特效用暖色调（tone=warm）', 'fx', { scope: 'project', projectId: project.id })] });
    const at = find('灯', '我会写完的');
    const r = await agent('这一句加回忆效果', store, at);
    const fx = ops(r, 'fx_range').find((o) => o.fx === 'memory');
    return { pass: fx?.tone === 'warm', why: `tone=${String(fx?.tone)}`, detail: brief(r) };
  });
  run('C04', '应用记忆：灯说话时镜头别晃（要求给这句加运镜时不用 shake）', async () => {
    const store = new InMemoryMemories({ memories: [m('灯说话时镜头别晃：不用 shake 运镜，也不加 shake 特效', 'camera', { scope: 'project', projectId: project.id, castId: castOf('灯').id, castName: castOf('灯').displayName })] });
    const at = find('灯', '我会写完的');
    const r = await agent('这一句加点镜头运动，让它更有冲击力', store, at);
    const bad = r.applied.some((x) => (x.op.op === 'shot_set' && (x.op as { set?: { move?: string } }).set?.move === 'shake') || (x.op.op === 'fx_range' && (x.op as { fx?: string }).fx === 'shake'));
    return { pass: !bad && r.applied.length > 0, why: `ops=${r.applied.map((x) => x.op.op).join(',')} shake=${bad}`, detail: brief(r) };
  });
  run('C05', '问「你记得我哪些偏好」：列出，不改项目', async () => {
    const store = new InMemoryMemories({ memories: [m('回忆特效用暖色调', 'fx'), m('少用特写', 'camera')] });
    const r = await agent('你记得我哪些偏好？', store, { scene: project.scenes[0]! });
    return { pass: r.applied.length === 0 && r.memory.length === 0 && r.summary.includes('暖色') && r.summary.includes('特写'), why: r.summary.slice(0, 120), detail: brief(r) };
  });
  run('C06', '修改已有偏好（回忆改用色带，以后都这样）→ 更新原记忆而不是新增', async () => {
    const old = m('回忆特效用雾边', 'fx');
    const store = new InMemoryMemories({ memories: [old] });
    const r = await agent('以后回忆改用色带边吧，都这样。', store, { scene: project.scenes[0]! });
    const pass = store.file.memories.length === 1 && store.file.memories[0]!.text.includes('色带');
    return { pass, why: store.file.memories.map((x) => x.text).join('|'), detail: brief(r) };
  });

  // ---- 「按偏好检查本场」 ------------------------------------------------------------------------------------------------
  run('E01', '按偏好检查本场：把违反「少用特写」的 ecu/cu 拉回，普通变更卡片', async () => {
    const store = new InMemoryMemories({ memories: [m('少用特写：推近最多到胸像 mcu，不用 cu / ecu', 'camera')] });
    const proj = structuredClone(project);
    const sc = proj.scenes[2]!;
    const dialog = sc.beats.filter((b) => b.kind === 'dialogue');
    const forced = [dialog[1], dialog[3], dialog[5]].filter(Boolean) as Beat[];
    for (const b of forced) { b.shot.type = 'ecu'; b.shot.focus = b.speakerId ? [b.speakerId] : b.shot.focus; }
    const r = await agent(reviewInstruction(3), store, { scene: sc }, [], proj);
    const shots = r.applied.filter((x) => x.op.op === 'shot_set').map((x) => x.op as AgentOp & { beatId: string; set: { type?: string } });
    const fixed = forced.filter((b) => shots.some((s) => s.beatId === b.id && s.set.type && !['cu', 'ecu'].includes(s.set.type))).length;
    const tight = shots.filter((s) => ['cu', 'ecu'].includes(s.set.type ?? '')).length;
    return { pass: fixed >= 2 && tight === 0 && r.memory.length === 0, why: `fixed ${fixed}/${forced.length} newTight=${tight} ops=${r.applied.length}`, detail: brief(r) };
  });
  run('E02', '按偏好检查本场：已经符合时不乱改', async () => {
    const store = new InMemoryMemories({ memories: [m('不要给镜头加 shake 晃动（运镜和特效都不用 shake）', 'camera')] });
    const proj = structuredClone(project);
    const sc = proj.scenes[0]!;
    for (const b of sc.beats) if (b.shot.move === 'shake') b.shot.move = 'static';
    const r = await agent(reviewInstruction(1), store, { scene: sc }, [], proj);
    return { pass: r.applied.length <= 1 && r.memory.length === 0, why: `ops=${r.applied.length}`, detail: brief(r) };
  });

  // ---- director: first whole-scene generation with style memories (vs the same scene without) -----------------------------
  const direct = async (sceneIdx: number, memories: Memory[], cam: 'classic' | 'travel') => {
    const sk = structuredClone(skeleton);
    if (cam === 'travel') sk.scenes[sceneIdx]!.cameraSystem = 'travel';
    const sid = sk.scenes[sceneIdx]!.id;
    const preferences = directorPreferences(directorMemories(memories, sk.id));
    const withM = await runScene({ provider, cache, catalog: cat, preferences }, { project: sk, sceneId: sid, scopes: ['scene'] }, 'gm');
    const without = cam === 'classic' ? baseScenes.get(sid)! : await runScene({ provider, cache, catalog: cat }, { project: sk, sceneId: sid, scopes: ['scene'] }, 'g2');
    const types = (r: SceneResult) => r.direction.beats.map((b) => b.shot.type as string);
    return { withM, without, tw: types(withM), to: types(without) };
  };
  const count = (xs: string[], set: string[]) => xs.filter((x) => set.includes(x)).length;
  const sane = (r: SceneResult) => new Set(r.direction.beats.map((b) => b.shot.type)).size >= 2 && r.direction.beats.length >= 4;
  run('D01', '导演（classic）：少用特写', async () => {
    const d = await direct(2, [m('少用特写：推近最多到胸像 mcu，cu/ecu 只留给全场最关键的一两句', 'camera')], 'classic');
    const a = count(d.tw, ['cu', 'ecu']);
    const b = count(d.to, ['cu', 'ecu']);
    return { pass: a <= Math.max(2, b - 1) && a <= b && sane(d.withM), why: `cu/ecu with=${a}/${d.tw.length} without=${b}/${d.to.length}`, detail: { with: d.tw, without: d.to, warnings: d.withM.warnings } };
  });
  run('D02', '导演（travel）：少用特写', async () => {
    const d = await direct(2, [m('少用特写：推近最多到胸像 mcu，cu/ecu 只留给全场最关键的一两句', 'camera')], 'travel');
    const a = count(d.tw, ['cu', 'ecu']);
    const b = count(d.to, ['cu', 'ecu']);
    return { pass: a <= Math.max(2, b - 1) && a <= b && sane(d.withM), why: `cu/ecu with=${a}/${d.tw.length} without=${b}/${d.to.length}`, detail: { with: d.tw, without: d.to, warnings: d.withM.warnings } };
  });
  run('D03', '导演（classic）：多用双人镜头', async () => {
    const d = await direct(0, [m('两个人对话时多用双人镜头 two_shot，少一个一个切', 'camera')], 'classic');
    const a = count(d.tw, ['two_shot']);
    const b = count(d.to, ['two_shot']);
    return { pass: a >= Math.max(1, b) && sane(d.withM), why: `two_shot with=${a}/${d.tw.length} without=${b}/${d.to.length}`, detail: { with: d.tw, without: d.to } };
  });
  run('D04', '导演（classic）：回忆偏好（色带边）不导致滥用回忆特效（第五章）', async () => {
    const d = await direct(4, [m('回想起之前发生的事（回忆、想起往事）时用回忆特效 memory，边缘用色带 bands', 'fx')], 'classic');
    const fxW = d.withM.direction.beats.filter((b) => b.fx === 'memory').length;
    const fxAll = d.withM.direction.beats.filter((b) => b.fx && b.fx !== 'none').length;
    return { pass: fxAll <= Math.ceil(d.tw.length / 2) && sane(d.withM), why: `memory fx with=${fxW}, any fx=${fxAll}/${d.tw.length}, without memory fx=${d.without.direction.beats.filter((b) => b.fx === 'memory').length}`, detail: { with: d.withM.direction.beats.map((b) => [b.shot.type, b.fx]), without: d.without.direction.beats.map((b) => [b.shot.type, b.fx]) } };
  });

  it('summary', () => {
    const passed = outcomes.filter((o) => o.pass).length;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ model: `${provider?.id}/${provider?.model}`, at: new Date().toISOString(), passed, total: outcomes.length, outcomes: outcomes.map(({ id, title, pass, why }) => ({ id, title, pass, why })) }, null, 1));
    console.log(outcomes.map((o) => `${o.pass ? 'PASS' : 'FAIL'} ${o.id} ${o.title} — ${o.why}`).join('\n'));
    console.log(`passed ${passed}/${outcomes.length}`);
    expect(outcomes.length).toBeGreaterThan(0);
  });
});
