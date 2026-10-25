/**
 * The agent loop (server side). A turn works on a SANDBOX copy of the project: the model calls tools, every write tool resolves to ops, each
 * op is validated (`checkOp`) and applied to the sandbox; the turn returns the op list (not the project), which the browser replays with the same
 * pure functions inside one `applyEdit`. No token cap: the only limits are a step ceiling, a wall-clock timeout and an op ceiling against runaway loops.
 *
 * Function calling is the main path (`tool_choice: auto`); an endpoint that refuses tools (HTTP 400 on the first request) is remembered and the
 * JSON action protocol is used instead.
 */
import { z } from 'zod';
import { applyOp } from '../../shared/agent/apply';
import { projectSummary, sceneTable, type AgentSelection } from '../../shared/agent/compact';
import { DEFAULT_FRAME_WIDTH, planFrames, type CaptureRequest, type CapturedFrame } from '../../shared/agent/frames';
import type { HistoryTurn } from '../../shared/agent/history';
import type { AgentOp } from '../../shared/agent/ops';
import { pruneRoundTrips } from '../../shared/agent/prune';
import { TOOLS, commitOps, newStats, runTool, toolByName, type OpRecord, type ToolEnv, type ToolStats } from '../../shared/agent/tools';
import type { DirectorCatalog } from '../../shared/director/resources';
import { clone } from '../../shared/project/mutate';
import type { Project } from '../../shared/schema/project';
import type { DirectorDeps } from '../llm/director';
import { LlmError, modelJsonSchema, stableStringify, zeroUsage, type ChatImage, type ChatTurn, type LlmProvider, type LlmUsage, type ToolSpec } from '../llm/provider';
import { runScene } from '../llm/sceneRunner';
import { NO_VERIFICATION, changesPicture, involvesMove, opBeatIds, type Verification } from '../../shared/agent/verify';
import { AGENT_SYSTEM, FALLBACK_PROTOCOL, VISION_PROMPT, userMessage } from './prompt';
import { loadSandbox, runInSandbox } from './sandbox';

export interface AgentLimits {
  /** Model steps per turn (a safety ceiling, not a budget). */
  maxSteps: number;
  /** Wall clock of the whole turn, ms. */
  wallMs: number;
  /** Write ops per turn. */
  maxOps: number;
}
export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 40, wallMs: 10 * 60_000, maxOps: 600 };

export type { HistoryTurn };
/** Renders frames of a project (the editor's stage over the SSE bridge, or a headless page): see shared/agent/frames.ts. */
export interface FrameSource {
  capture(project: Project, req: CaptureRequest, signal?: AbortSignal): Promise<CapturedFrame[]>;
}
/** How the assistant sees pictures: the main model reads them (inline), or a separate vision model describes them in words. */
export type VisionChannel = { mode: 'inline'; model?: string } | { mode: 'describe'; model?: string; provider: LlmProvider };
export interface AgentTurnRequest {
  project: Project;
  selection: AgentSelection;
  instruction: string;
  /** Earlier turns of the conversation (the last four are used): the instruction and what the assistant said. */
  history?: HistoryTurn[] | undefined;
  /** Pictures the user attached or pasted (a video arrives as a few sampled frames). */
  attachments?: ChatImage[] | undefined;
  limits?: Partial<AgentLimits> | undefined;
}
export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'op'; record: OpRecord }
  | { type: 'usage'; usage: LlmUsage; total: LlmUsage }
  | { type: 'ask'; question: string; options: string[] };

export interface AgentDeps {
  provider: LlmProvider;
  catalog: DirectorCatalog;
  /** Used by regenerate_scene_camera (cache, background limits ...). */
  director: DirectorDeps;
  now?: () => number;
  genId?: string;
  signal?: AbortSignal | undefined;
  emit?: (e: AgentEvent) => void;
  /** Where `capture_frames` gets its pictures; without it (or without `vision`) the tool is not offered. */
  frames?: FrameSource | undefined;
  /** The assistant's eyes; null / absent = no pictures at all. */
  vision?: VisionChannel | null | undefined;
}

export interface AgentTurnResult {
  genId: string;
  /** What the model said at the end (≤3 sentences, Chinese). */
  summary: string;
  applied: OpRecord[];
  /** Ops that need the user (locks, hand-made content): not applied to the sandbox. */
  pending: OpRecord[];
  question: { question: string; options: string[] } | null;
  /** Ops whose effect could not be read back from the final state. */
  unverified: number[];
  /** The model described a change but made none (so the card can say so). */
  claimedWithoutOps: string | null;
  usage: LlmUsage;
  /** The part of `usage` spent in regenerate_scene_camera (a whole-scene direction call). */
  regenUsage: LlmUsage;
  steps: number;
  mode: 'tools' | 'json';
  stats: ToolStats;
  /** Whether the picture-changing edits of this turn were looked at (see shared/agent/verify.ts). */
  verification: Verification;
  stopped: 'done' | 'steps' | 'time' | 'ops' | 'aborted' | 'ask';
  elapsedMs: number;
  /** Raw calls, for the evaluation log. */
  trace: Array<{ step: number; text: string; calls: Array<{ name: string; args: unknown; result: string }> }>;
}

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens });

/** Tool specs for the model; tools that cannot work in this turn (no frames / no history to undo) are left out. */
export function toolSpecs(have: { frames?: boolean; revert?: boolean; script?: boolean } = { frames: true, revert: true, script: true }): ToolSpec[] {
  return TOOLS.filter((t) => (t.name !== 'capture_frames' || have.frames) && (t.name !== 'revert_turn' || have.revert) && (t.name !== 'run_script' || have.script)).map((t) => ({ name: t.name, description: t.description, parameters: modelJsonSchema(t.modelSchema ?? t.schema) }));
}

const Fallback = z.object({ say: z.string().default(''), calls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()).default({}) })).default([]), done: z.boolean().default(false) });

const CHANGE_WORDS = /(已|将|会|我把|帮你|为你)[^。]{0,12}(改|调整|设置|设为|添加|加上|推近|拉远|换成|移到|放慢|加快|删除|插入|锁定)/;

const brief = (name: string, args: Record<string, unknown>): string => {
  const pick = (k: string) => (args[k] !== undefined ? `${k}=${JSON.stringify(args[k]).slice(0, 40)}` : '');
  return [name, ...['beatId', 'beatIds', 'castId', 'fx', 'type', 'adjust', 'pace', 'action', 'tool', 'description', 'label', 'filter', 'target'].map(pick).filter(Boolean)].join(' ').slice(0, 160);
};

export async function runAgentTurn(deps: AgentDeps, req: AgentTurnRequest): Promise<AgentTurnResult> {
  const t0 = Date.now();
  const now = deps.now ?? Date.now;
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...req.limits };
  const genId = deps.genId ?? `agent_${now().toString(36)}`;
  const emit = deps.emit ?? (() => {});
  const env: ToolEnv = {
    sandbox: clone(req.project), catalog: deps.catalog, selection: req.selection, genId, now: () => now(),
    applied: [], pending: [], stats: newStats(), seq: { n: 0 },
  };
  // the script sandbox (WASM, loaded once per process); without it run_script is not offered
  if (await loadSandbox()) env.scriptRunner = runInSandbox;
  let usage = zeroUsage();
  let regenUsage = zeroUsage();
  let regenUsed = false;
  const trace: AgentTurnResult['trace'] = [];

  const selScene = req.selection.sceneId && env.sandbox.scenes.some((s) => s.id === req.selection.sceneId) ? req.selection.sceneId : null;
  const messages: ChatTurn[] = [{ role: 'system', content: AGENT_SYSTEM }];
  const history = (req.history ?? []).slice(-8);
  for (const h of history) messages.push({ role: h.role, content: h.content.slice(0, 2000) });
  // earlier applied turns that can be undone exactly, most recent first
  const answers = history.filter((h) => h.role === 'assistant');
  env.reverts = answers.map((h, i) => ({ turnsAgo: answers.length - i, instruction: history[history.indexOf(h) - 1]?.content.split('\n')[0] ?? '', ops: h.revert ?? [] })).filter((r) => r.ops.length > 0);

  let mode: 'tools' | 'json' = deps.provider.chatTools && deps.provider.toolsSupported?.() !== false ? 'tools' : 'json';
  // the eyes: inline pictures need function calling (json mode cannot carry them), else a model that describes them in words
  const vision: VisionChannel | null = deps.vision?.mode === 'inline' && mode === 'json' ? (deps.provider.describeImages ? { mode: 'describe', provider: deps.provider } : null) : deps.vision ?? null;
  const describe = async (images: ChatImage[], question: string): Promise<string> => {
    if (vision?.mode !== 'describe' || !vision.provider.describeImages) return '';
    const r = await vision.provider.describeImages({ prompt: `${VISION_PROMPT}\n\n要回答的：${question}\n图片依次是：${images.map((im, i) => `${i + 1}. ${im.label ?? ''}`).join('；')}`, images, maxTokens: 4000, signal: deps.signal });
    usage = addUsage(usage, r.usage);
    return r.text.trim();
  };
  const attachments = (req.attachments ?? []).slice(0, 8);
  let attachNote = '';
  if (attachments.length) {
    if (!vision) attachNote = `\n\n（用户附了 ${attachments.length} 张图片/视频帧，但当前没有可用的视觉模型，你看不到它们。指令如果依赖图片内容，请如实告诉用户：需要一个能看图的模型（在 AI 设置里配置视觉模型）。）`;
    else if (vision.mode === 'describe') {
      emit({ type: 'status', text: '正在看你附的图…' });
      attachNote = `\n\n用户附了 ${attachments.length} 张图片/视频帧（${attachments.map((a) => a.label ?? '').join('、')}）。视觉模型的描述：\n${await describe(attachments, '用户为什么附这些图？描述与舞台演出相关的内容：构图/景别、人物位置大小与朝向、遮挡、画面空不空、背景清晰度与色调。')}`;
    } else attachNote = `\n\n用户附了 ${attachments.length} 张图片/视频帧（见图：${attachments.map((a) => a.label ?? '').join('、')}）。`;
  }
  messages.push({ role: 'user', content: userMessage({ summary: projectSummary(env.sandbox, req.selection), sceneTable: selScene ? sceneTable(env.sandbox, selScene) : null, instruction: req.instruction }) + attachNote, ...(attachments.length && vision?.mode === 'inline' ? { images: attachments } : {}) });

  const specs = toolSpecs({ frames: !!(deps.frames && vision), revert: env.reverts.length > 0, script: !!env.scriptRunner });
  /** Pictures from capture_frames, sent as one user message after the tool results of the step (inline vision). */
  let shots: ChatImage[] = [];
  let stopped: AgentTurnResult['stopped'] = 'done';
  let summary = '';
  let steps = 0;
  let nudges = 0;
  let talkNudges = 0;
  let verifiedSinceWrite = true;
  let wrote = 0;
  // picture check: edits that change the picture must be followed by a capture_frames call (forced by the loop when the model forgets)
  const MAX_FORCED = 3; // one verification round + at most two fix-and-recheck rounds
  let picOps = 0; // picture-changing ops applied so far
  let picChecked = 0; // picOps value at the last successful capture
  let forced = 0;
  let sawProblemFixed = false;
  let lookFailed = false; // the renderer failed: asking again would only repeat the failure
  let verifyFrames: Array<{ label: string; dataUrl: string }> = [];
  const picDirty = () => picOps > picChecked;
  const countPicOps = (from: number) => env.applied.slice(from).filter((r) => changesPicture(r.op)).length;
  const canLook = !!(deps.frames && vision);

  const runCall = async (name: string, args: Record<string, unknown>): Promise<string> => {
    emit({ type: 'tool', name, summary: brief(name, args) });
    const before = env.applied.length + env.pending.length;
    const beforeApplied = env.applied.length;
    let out: string;
    if (name === 'ask_user') {
      const a = toolByName('ask_user')!.schema.safeParse(args);
      if (!a.success) return JSON.stringify({ 错误: ['ask_user 需要 question'] });
      env.askedUser = { question: (a.data as { question: string }).question, options: (a.data as { options?: string[] }).options ?? [] };
      emit({ type: 'ask', ...env.askedUser });
      return '已向用户提问；本轮到此结束。';
    }
    if (name === 'capture_frames') out = await capture(args);
    else if (name === 'regenerate_scene_camera') { env.stats.writeCalls++; out = await regenerate(args); if (!out.includes('"错误"')) env.stats.writeFirstTryOk++; }
    else out = runTool(env, name, args);
    for (const r of [...env.applied, ...env.pending].slice(before)) emit({ type: 'op', record: r });
    { const n = countPicOps(beforeApplied); if (n > 0) { if (picChecked > 0) sawProblemFixed = true; picOps += n; } }
    const isWrite = toolByName(name)?.kind === 'write';
    if (isWrite && env.applied.length > beforeApplied) { wrote++; verifiedSinceWrite = false; }
    if (!isWrite && (name === 'get_beat' || name === 'get_scene' || name === 'query_beats')) verifiedSinceWrite = true;
    // a script that only read the (already changed) project and printed it is a read-back too
    if (name === 'run_script' && env.applied.length === beforeApplied && out.includes('不计入失败次数')) verifiedSinceWrite = true;
    return out;
  };

  /** Frames of the sandbox (what the user would see after applying), shown to the model or described by the vision model. */
  const capture = async (args: Record<string, unknown>): Promise<string> => {
    env.stats.toolCalls++;
    const a = toolByName('capture_frames')!.schema.safeParse(args);
    if (!a.success) { env.stats.badArgs++; return JSON.stringify({ 错误: a.error.issues.slice(0, 3).map((i) => `参数 ${i.path.join('.')}：${i.message}`) }); }
    const p = a.data as { beatIds?: string[]; times?: number[]; samples?: number; width?: number; question?: string };
    if (!deps.frames || !vision) return JSON.stringify({ 错误: ['现在看不到画面（没有连接到编辑器的舞台，或没有能看图的模型）；请按文字信息判断'] });
    const no = (id: string) => { for (const [si, sc] of env.sandbox.scenes.entries()) { const i = sc.beats.findIndex((b) => b.id === id); if (i >= 0) return `第${si + 1}场第${i + 1}句`; } return null; };
    const sel = req.selection.beatId ? [req.selection.beatId] : [];
    const plan = planFrames({ beatIds: p.beatIds ?? (p.times?.length ? [] : sel), times: p.times, samples: p.samples }, no);
    if (plan.requests.length === 0) return JSON.stringify({ 错误: ['要给出 beatIds 或 times', ...plan.problems] });
    emit({ type: 'status', text: `正在截取 ${plan.requests.length} 帧画面…` });
    let frames: CapturedFrame[];
    try {
      frames = await deps.frames.capture(clone(env.sandbox), { frames: plan.requests, width: p.width ?? DEFAULT_FRAME_WIDTH }, deps.signal);
    } catch (e) {
      lookFailed = true;
      return JSON.stringify({ 错误: [`截图失败：${(e as Error).message}`] });
    }
    if (frames.length === 0) { lookFailed = true; return JSON.stringify({ 错误: ['没有截到画面'] }); }
    env.stats.framesCaptured = (env.stats.framesCaptured ?? 0) + frames.length;
    if (picOps > 0) { picChecked = picOps; verifyFrames = frames.map((f) => ({ label: f.label, dataUrl: f.dataUrl })).slice(0, 8); }
    // each picture names the shot it shows (景别 + who), so the model can calibrate what mcu / cu / ecu look like in this engine
    const shotOf = (label: string) => { const r = plan.requests.find((q) => q.label === label); const b = r && 'beatId' in r ? env.sandbox.scenes.flatMap((sc) => sc.beats).find((x) => x.id === r.beatId) : undefined; return b ? ` 景别=${b.shot.type}${b.shot.focus.length ? ` 焦点=${b.shot.focus.join('+')}` : ''}` : ''; };
    const images = frames.map((f) => ({ dataUrl: f.dataUrl, label: `【${f.label}${shotOf(f.label)}】` }));
    const note = env.applied.length ? '（画面已包含你本轮放进变更集的改动）' : '';
    if (vision.mode === 'describe') {
      const text = await describe(images, p.question ?? '描述画面：景别、谁在画面里、人物大小位置和朝向、有没有被遮挡或出画、背景是否清晰。');
      return JSON.stringify({ 截图: frames.map((f) => f.label), 视觉模型的描述: text || '（视觉模型没有回答）', ...(plan.problems.length ? { 提示: plan.problems } : {}) }) + note;
    }
    shots.push(...images);
    return JSON.stringify({ 截图: frames.map((f) => f.label), 说明: '图片在下一条消息里（这是渲染结果，不是用户发的图）', ...(plan.problems.length ? { 提示: plan.problems } : {}) }) + note;
  };

  /** Whole-scene camera direction with the user's preference, converted into shot ops (only the beats that really change). */
  const regenerate = async (args: Record<string, unknown>): Promise<string> => {
    env.stats.toolCalls++;
    const a = toolByName('regenerate_scene_camera')!.schema.safeParse(args);
    if (!a.success) { env.stats.badArgs++; return JSON.stringify({ 错误: a.error.issues.slice(0, 3).map((i) => `参数 ${i.path.join('.')}：${i.message}`) }); }
    const p = a.data as { sceneId?: string; guidance: string; beatIds?: string[] };
    if (regenUsed) return JSON.stringify({ 错误: ['本轮已经重导过一次镜头；请用 set_shot 做细调'] });
    const sceneId = p.sceneId ?? env.selection.sceneId ?? '';
    if (!env.sandbox.scenes.some((s) => s.id === sceneId)) return JSON.stringify({ 错误: [`场景 ${sceneId} 不存在`] });
    regenUsed = true;
    emit({ type: 'status', text: '正在让导演按你的倾向重新设计镜头…' });
    let result;
    try {
      result = await runScene({ ...deps.director, signal: deps.signal }, { project: clone(env.sandbox), sceneId, scopes: ['camera'], ...(p.beatIds?.length ? { beatIds: p.beatIds } : {}), guidance: p.guidance }, `${genId}_cam`);
    } catch (e) {
      return JSON.stringify({ 错误: [`重导失败：${(e as Error).message}`] });
    }
    for (const r of result.runs) regenUsage = addUsage(regenUsage, r.usage);
    usage = addUsage(usage, regenUsage);
    if (!result.applied) return JSON.stringify({ 错误: ['有锁定内容与新镜头冲突，没有应用'], 冲突: result.conflicts.map((c) => c.label) });
    const cur = env.sandbox.scenes.find((s) => s.id === sceneId)!;
    const ops: AgentOp[] = [];
    let churn = 0;
    for (const nb of result.scene.beats) {
      const ob = cur.beats.find((b) => b.id === nb.id);
      if (!ob) continue;
      // Only the beats whose framing (shot size or who is in it) really changes. A re-direction also re-rolls intent / flow / move on
      // beats it keeps as they were; taking those would be edits the user did not ask for.
      const framing = (s: typeof nb.shot) => stableStringify({ type: s.type, focus: [...s.focus].sort() });
      if (framing(nb.shot) === framing(ob.shot)) { const core = (s: typeof nb.shot) => stableStringify({ move: s.move, dof: s.dof ?? null, transition: s.transition ?? null, intent: s.intent ?? null }); if (core(nb.shot) !== core(ob.shot) || nb.cutIn !== ob.cutIn) churn++; continue; }
      ops.push({ op: 'shot_set', sceneId, beatId: nb.id, reason: nb.shot.meta.reason ?? p.guidance.slice(0, 60), set: { type: nb.shot.type, focus: nb.shot.focus, move: nb.shot.move, dof: nb.shot.dof ?? null, transition: nb.shot.transition ?? null, intent: nb.shot.intent ?? null, insertBox: nb.shot.insertBox ?? null } });
      if (nb.cutIn !== ob.cutIn || nb.cutInKeepDialog !== ob.cutInKeepDialog) ops.push({ op: 'beat_set', sceneId, beatId: nb.id, reason: '镜头切入', set: { cutIn: nb.cutIn, cutInKeepDialog: nb.cutInKeepDialog } });
    }
    if (ops.length === 0) return JSON.stringify({ 结果: '导演认为现有镜头已经符合这个倾向，没有改动', 警告: result.warnings.slice(0, 3) });
    const out = commitOps(env, 'regenerate_scene_camera', ops, { continueOnIssue: true });
    return churn > 0 ? JSON.stringify({ ...JSON.parse(out), 未采用: `景别和焦点没变的 ${churn} 句保持原样（没有采用导演对它们意图/换镜方式的重写）` }) : out;
  };

  const finish = (s: AgentTurnResult['stopped']) => { stopped = s; };

  // ---- the loop ---------------------------------------------------------------------------------------------
  while (steps < limits.maxSteps) {
    if (deps.signal?.aborted) { finish('aborted'); break; }
    if (Date.now() - t0 > limits.wallMs) { finish('time'); break; }
    if (env.applied.length + env.pending.length > limits.maxOps) { finish('ops'); break; }
    steps++;
    emit({ type: 'status', text: steps === 1 ? '正在理解指令…' : '继续处理…' });
    let text: string;
    let calls: Array<{ id: string; name: string; args: Record<string, unknown> | null; raw: string }>;
    let assistant: ChatTurn;
    let done = false;
    if (mode === 'tools') {
      let r;
      try {
        r = await deps.provider.chatTools!({ messages, tools: specs, maxTokens: 16000, signal: deps.signal });
      } catch (e) {
        // the very first request refused: this endpoint has no function calling -> remember it and use the JSON action protocol
        if (e instanceof LlmError && e.kind === 'bad_request' && steps === 1 && wrote === 0) {
          deps.provider.noteToolsUnsupported?.();
          mode = 'json';
          steps--;
          continue;
        }
        throw e;
      }
      usage = addUsage(usage, r.usage);
      emit({ type: 'usage', usage: r.usage, total: usage });
      text = r.text;
      calls = r.toolCalls.map((c) => {
        let args: Record<string, unknown> | null;
        try { const v: unknown = JSON.parse(c.arguments || '{}'); args = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { args = null; }
        return { id: c.id, name: c.name, args, raw: c.arguments };
      });
      assistant = { role: 'assistant', content: text, toolCalls: r.toolCalls, ...(r.reasoning ? { reasoning: r.reasoning } : {}) };
    } else {
      const system = `${AGENT_SYSTEM}\n\n# 可用工具（参数是 JSON Schema）\n${specs.map((t) => `## ${t.name}\n${t.description}\n参数：${stableStringify(t.parameters)}`).join('\n')}\n\n# 输出协议\n${FALLBACK_PROTOCOL}`;
      const transcript = messages.slice(1).map((m) => ({ role: m.role, content: m.content }));
      const r = await deps.provider.generateStructured({ system, input: { 对话: transcript }, schema: Fallback, schemaName: 'AgentStep', maxTokens: 8000, signal: deps.signal });
      usage = addUsage(usage, r.usage);
      emit({ type: 'usage', usage: r.usage, total: usage });
      text = r.data.say;
      done = r.data.done;
      calls = r.data.calls.map((c, i) => ({ id: `fb_${steps}_${i}`, name: c.name, args: c.args, raw: JSON.stringify(c.args) }));
      assistant = { role: 'assistant', content: JSON.stringify(r.data) };
    }
    messages.push(assistant);
    const step: AgentTurnResult['trace'][number] = { step: steps, text, calls: [] };
    trace.push(step);

    if (calls.length === 0) {
      // the model stopped: make sure it verified what it wrote, and that "I changed X" was not just words
      if (wrote > 0 && !verifiedSinceWrite && nudges < 2) {
        nudges++;
        // a batch / script touched many beats: re-run the condition instead of reading every scene
        const many = env.applied.some((r) => r.group);
        messages.push({ role: 'user', content: many ? '请回读确认刚才的批量 / 脚本改动：用 query_beats 再查一次同样的条件（或抽查 2–3 句 get_beat），不要逐场读全部；与指令一致就给出最终总结，不一致就修正。' : '请先用 get_beat（或 get_scene）回读你刚改过的地方，确认与指令一致；不一致就修正，一致就给出最终总结。' });
        continue;
      }
      if (canLook && !lookFailed && picDirty() && forced < MAX_FORCED && steps < limits.maxSteps) {
        forced++;
        const recs = env.applied.filter((r) => changesPicture(r.op));
        const beats = [...new Set(recs.flatMap((r) => [...opBeatIds(r.op), ...r.changes.map((c) => c.beatId ?? '')]).filter(Boolean))].slice(0, 8);
        const move = recs.some((r) => involvesMove(r.op));
        messages.push({ role: 'user', content: `请截图核对刚才的画面改动：调用 capture_frames${beats.length ? `（beatIds=${JSON.stringify(beats)}）` : ''}只看改动涉及的句子${move ? '；有运镜/走位的句子用 samples=3 沿时间取几帧' : ''}，对照用户的指令${(req.attachments ?? []).length ? '和参考图' : ''}判断；不符合就修正，修正后再看一次；确实改不了就在总结里如实说明。` });
        continue;
      }
      if (env.applied.length + env.pending.length === 0 && !env.askedUser && CHANGE_WORDS.test(text) && talkNudges < 1) {
        talkNudges++;
        messages.push({ role: 'user', content: '你只是在描述要做什么，还没有调用任何工具。请用工具执行；如果确实做不到，直接说明原因。' });
        continue;
      }
      summary = text;
      if (mode === 'json' && !done && steps < limits.maxSteps && calls.length === 0 && !text) continue;
      break;
    }

    for (const c of calls) {
      let result: string;
      if (c.args === null) {
        env.stats.toolCalls++;
        env.stats.badArgs++;
        result = JSON.stringify({ 错误: ['参数不是合法的 JSON 对象'] });
      } else result = await runCall(c.name, c.args);
      step.calls.push({ name: c.name, args: c.args ?? c.raw, result: result.slice(0, 4000) });
      messages.push(mode === 'tools' ? { role: 'tool', content: result, toolCallId: c.id } : { role: 'user', content: `工具结果 ${c.name}：${result}` });
    }
    if (shots.length) {
      messages.push({ role: 'user', content: `capture_frames 的截图（舞台渲染结果，不含对白框）：${shots.map((x) => x.label).join(' ')}`, images: shots });
      shots = [];
    }
    if (env.askedUser) { summary = text || env.askedUser.question; finish('ask'); break; }
    if (mode === 'json' && done) { summary = text; break; }
    summary = text || summary;
  }
  if (steps >= limits.maxSteps && stopped === 'done') finish('steps');

  // ---- verification: every applied op must still hold in the final state (re-applying it changes nothing) ------------------
  // try-and-take-back round trips (a move undone after looking at a frame) leave the card when the rest replays to the same result
  const applied = pruneRoundTrips(req.project, env.applied, env.sandbox);
  const unverified: number[] = [];
  for (const r of applied) {
    const probe = applyOp(clone(env.sandbox), r.op, { genId, now: now() });
    if (probe.ok && probe.changes.length > 0 && !(r.op.op === 'beat_insert' || r.op.op === 'beat_split' || r.op.op === 'beat_delete' || r.op.op === 'beat_merge' || r.op.op === 'beat_move' || r.op.op === 'key_set' || r.op.op === 'key_shift' || r.op.op === 'actor_presence')) unverified.push(r.id);
  }
  const verification: Verification = picOps === 0 ? NO_VERIFICATION
    : { status: !canLook ? 'unavailable' : picDirty() || verifyFrames.length === 0 ? 'unchecked' : sawProblemFixed ? 'fixed' : 'verified', frames: picDirty() ? [] : verifyFrames, forced };
  const claimed = env.applied.length + env.pending.length === 0 && !env.askedUser && CHANGE_WORDS.test(summary) ? summary.slice(0, 160) : null;
  return {
    genId, summary, applied, pending: env.pending, question: env.askedUser ?? null, unverified, claimedWithoutOps: claimed,
    usage, regenUsage, steps, mode, stats: env.stats, verification, stopped, elapsedMs: Date.now() - t0, trace,
  };
}
