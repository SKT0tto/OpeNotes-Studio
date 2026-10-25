/**
 * `batch_edit`: ONE edit template applied to every beat a query matched (or to an explicit id list). Each item goes through the normal
 * tool -> checkOp -> apply path (so locks and hand-made content behave exactly as for a single edit: a locked item becomes a 「需要你确认」
 * entry, never a silent skip), and the records are tagged with one group so the card shows ONE collapsible line
 * ("把 12 句的景别改成 mcu") that expands into per-beat rows. The whole group is still just ops: applying the card is one undo step.
 *
 * This file only imports types from tools.ts; the pieces it needs (the write-tool dispatcher) arrive as `deps`, which keeps the module
 * graph acyclic.
 */
import { z } from 'zod';
import { AgentOpSchema, type AgentOp } from './ops';
import { BeatFilterSchema, ModelFilterSchema, buildIndex, refOf, runQuery, type BeatFilter, type BeatRef } from './query';
import { opBeatIds } from './verify';
import type { OpGroup, OpRecord, ToolEnv } from './tools';

export const MAX_BATCH_BEATS = 400;
/** Write tools that make sense per beat. */
export const BATCH_TOOLS = ['edit_beat', 'set_shot', 'nudge_shot', 'set_actor', 'set_fx', 'set_timing', 'set_keyframe', 'set_lock', 'edit_structure'] as const;
const LIST_TOOLS: Record<string, number> = { set_shot: 80, set_timing: 120 };

export const BatchTargetSchema = z.object({
  queryId: z.string().optional().describe('query_beats 返回的 queryId（用它的完整结果，不受表格截断影响）'),
  filter: BeatFilterSchema.optional().describe('直接给一个过滤条件，写法同 query_beats'),
  beatIds: z.array(z.string()).max(MAX_BATCH_BEATS).optional().describe('明确的 beatId 列表'),
}).strict();

const j = (o: unknown) => JSON.stringify(o);

export interface BatchDeps {
  /** Runs one write tool with parsed arguments (the dispatcher of tools.ts). */
  writeTool: (env: ToolEnv, name: string, args: Record<string, unknown>) => string;
  toolSchema: (name: string) => z.ZodType | undefined;
  commitOps: (env: ToolEnv, tool: string, ops: AgentOp[], extra?: { continueOnIssue?: boolean }) => string;
}

/** Targets of a batch: from a stored query, a filter or an id list (exactly one). */
export function resolveTargets(env: ToolEnv, t: z.infer<typeof BatchTargetSchema>): { refs: BeatRef[] } | { error: string[] } {
  const given = [t.queryId, t.filter, t.beatIds].filter((x) => x !== undefined).length;
  if (given !== 1) return { error: ['target 里 queryId / filter / beatIds 必须且只能给一个'] };
  let refs: BeatRef[];
  if (t.queryId !== undefined) {
    const q = env.queries?.get(t.queryId);
    if (!q) return { error: [`没有 queryId=${t.queryId}（先调用 query_beats；已有：${[...(env.queries?.keys() ?? [])].join(', ') || '无'}）`] };
    const idx = buildIndex(env.sandbox);
    refs = q.filter((r) => idx.byBeat.has(r.beatId)).map((r) => refOf(idx.byBeat.get(r.beatId)!));
  } else if (t.filter !== undefined) {
    const res = runQuery(buildIndex(env.sandbox), t.filter as BeatFilter);
    if (res.problems.length) return { error: ['过滤条件有问题，先改正再批量：', ...res.problems] };
    refs = res.rows.map(refOf);
  } else {
    const idx = buildIndex(env.sandbox);
    const missing = t.beatIds!.filter((id) => !idx.byBeat.has(id));
    if (missing.length) return { error: [`这些 beatId 不存在：${missing.slice(0, 8).join(', ')}`] };
    const want = new Set(t.beatIds);
    refs = idx.rows.filter((r) => want.has(r.beatId)).map(refOf);
  }
  if (refs.length > MAX_BATCH_BEATS) return { error: [`一次批量最多 ${MAX_BATCH_BEATS} 句，这次命中 ${refs.length} 句；请按场景分几次，或收紧条件`] };
  return { refs };
}

/** A short Chinese phrase for what the template does ("景别改成 mcu"), for the group label on the card. */
export function describeTemplate(toolName: string | undefined, args: Record<string, unknown>): string {
  const tool = toolName ?? (args.__tool as string | undefined);
  const parts: string[] = [];
  const has = (k: string) => args[k] !== undefined;
  switch (tool) {
    case 'set_shot':
      if (typeof args.type === 'string') parts.push(`景别改成 ${args.type}`);
      if (args.adjust === 'tighter') parts.push('景别推近');
      if (args.adjust === 'wider') parts.push('景别拉远');
      if (has('focus')) parts.push('焦点');
      if (typeof args.move === 'string') parts.push(`运镜改成 ${args.move}`);
      if (has('dof')) parts.push('景深');
      if (typeof args.intent === 'string') parts.push(`意图改成 ${args.intent}`);
      if (typeof args.flow === 'string') parts.push(`换镜方式改成 ${args.flow}`);
      if (has('insertTarget')) parts.push('插入镜头目标');
      break;
    case 'edit_beat':
      if (has('emotion')) parts.push(args.emotion === null ? '情绪清除' : `情绪改成 ${String(args.emotion)}`);
      if (has('speaker')) parts.push('说话人');
      if (has('kind')) parts.push(`类型改成 ${String(args.kind)}`);
      if (has('text') || has('trimTo')) parts.push('台词文字');
      if (has('cutIn')) parts.push(`切入改成 ${String(args.cutIn)}`);
      if (has('durationSeconds')) parts.push('时长');
      if (has('variant')) parts.push('形式');
      break;
    case 'set_timing':
      if (typeof args.pace === 'string') parts.push(`节奏${args.pace === 'slower' ? '放慢' : args.pace === 'faster' ? '加快' : '回到正常'}`);
      if (has('gapSteps') || has('gapSeconds') || has('lineGap')) parts.push('句后停顿');
      if (has('tailSteps') || has('tail')) parts.push('句尾停留');
      if (args.reset === true) parts.push('节奏恢复默认');
      if (has('readingCps') || has('minLine') || has('textSpeedCps')) parts.push('阅读速度');
      break;
    case 'set_fx':
      parts.push(args.fx === 'none' ? '特效清除' : `特效 ${String(args.fx)}`);
      break;
    case 'nudge_shot':
      parts.push(args.resetOffset ? '画面偏移清除' : '画面位置微调');
      break;
    case 'set_actor':
      for (const k of ['motion', 'expression', 'head', 'body', 'gaze', 'headTilt', 'moveTo', 'slotSteps']) if (has(k)) parts.push({ motion: '动作', expression: '表情', head: '头部朝向', body: '身体朝向', gaze: '视线', headTilt: '头部俯仰', moveTo: '站位', slotSteps: '站位' }[k]!);
      if (has('remove')) parts.push('清除轨道');
      break;
    case 'set_keyframe':
      parts.push(`${String(args.channel ?? '')} 关键帧`);
      break;
    case 'set_lock':
      parts.push(args.locked === false ? '解锁' : '锁定');
      break;
    case 'edit_structure':
      parts.push('删除');
      break;
    default:
      break;
  }
  return [...new Set(parts)].join('、') || '批量修改';
}

/** Beat ids a record is about (its changes and its op). */
export function recordBeats(rec: Pick<OpRecord, 'op' | 'changes'>): string[] {
  const ids = new Set<string>(opBeatIds(rec.op));
  const o = rec.op as unknown as { beatIds?: string[] };
  for (const id of o.beatIds ?? []) ids.add(id);
  for (const c of rec.changes) if (c.beatId) ids.add(c.beatId);
  return [...ids];
}

export const nextGroupId = (env: ToolEnv, kind: 'batch' | 'script'): string => `${kind}${(env.groupSeq = (env.groupSeq ?? 0) + 1)}`;

/** The records a call produced (indexes into applied / pending before the call). */
export const collectRecords = (env: ToolEnv, a0: number, p0: number): { applied: OpRecord[]; pending: OpRecord[] } => ({ applied: env.applied.slice(a0), pending: env.pending.slice(p0) });

/** Tag records with one group. The script text rides on the first record only (the card finds it there). */
export function tagRecords(recs: { applied: OpRecord[]; pending: OpRecord[] }, group: OpGroup): void {
  const { script, ...lite } = group;
  [...recs.applied, ...recs.pending].forEach((r, i) => { r.group = i === 0 && script !== undefined ? group : lite; });
}

/** The shared answer of batch_edit / run_script: counts, what is waiting for the user, a few examples. */
export function summarise(env: ToolEnv, recs: { applied: OpRecord[]; pending: OpRecord[] }, bad: string[], extra: Record<string, unknown> = {}): { text: string; beats: number } {
  const beats = new Set(recs.applied.flatMap(recordBeats));
  const asks = recs.pending;
  const out: Record<string, unknown> = { ...extra };
  if (recs.applied.length) out.已放入变更集 = { 改动数: recs.applied.length, 涉及句数: beats.size, 示例: recs.applied.slice(0, 4).flatMap((r) => r.changes.slice(0, 1)).map((c) => `${c.where} ${c.field}：${c.before} → ${c.after}`), 说明: '完整明细在变更集卡片里（折叠成一组，可展开逐句查看）' };
  if (asks.length) {
    const lock = asks.filter((r) => r.status === 'needs_unlock').length;
    out.待用户确认 = { 数量: asks.length, 锁定: lock, 覆盖手改: asks.length - lock, 涉及: [...new Set(asks.flatMap((r) => (r.status === 'needs_unlock' ? r.violations : r.overwrote)))].slice(0, 6), 说明: '这些没有应用到当前状态，已作为「需要你确认」放进卡片；请在总结里告诉用户，不要重复提交' };
  }
  if (bad.length) {
    const count = new Map<string, number>();
    for (const b of bad) count.set(b, (count.get(b) ?? 0) + 1);
    out.错误 = [...count].slice(0, 6).map(([m, n]) => (n > 1 ? `${m}（${n} 处）` : m));
  }
  if (!recs.applied.length && !asks.length && !bad.length) out.结果 = '没有任何变化（目标已经是这个状态）';
  return { text: j(out), beats: beats.size };
}

function listFromJson(s: string): { errors: string[] } {
  try {
    const o = JSON.parse(s) as { 错误?: string[] };
    return { errors: o.错误 ?? [] };
  } catch {
    return { errors: [] };
  }
}

/** Expand a raw AgentOp template to the given beats of one scene (the id fields are filled in). */
function expandOp(tpl: Record<string, unknown>, sceneId: string, beatIds: string[], consecutive: string[][]): Record<string, unknown>[] {
  const kind = tpl.op as string;
  const withScene = { ...tpl, sceneId };
  switch (kind) {
    case 'timing': return chunk(beatIds, 120).map((ids) => ({ ...withScene, beatIds: ids }));
    case 'fx_range': return consecutive.map((run) => ({ ...withScene, fromBeatId: run[0], toBeatId: run[run.length - 1] }));
    case 'key_set': return beatIds.map((id) => ({ ...withScene, at: { ...(tpl.at as object | undefined), beatId: id, offset: (tpl.at as { offset?: number } | undefined)?.offset ?? 0 } }));
    default: return beatIds.map((id) => ({ ...withScene, beatId: id }));
  }
}
const chunk = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/** Runs of consecutive beats (by position in the scene) among `ids`; `max` caps a run (dim: 4, flash / shake: 1). */
function runsOf(env: ToolEnv, sceneId: string, ids: string[], max: number): string[][] {
  const scene = env.sandbox.scenes.find((s) => s.id === sceneId)!;
  const pos = ids.map((id) => ({ id, i: scene.beats.findIndex((b) => b.id === id) })).sort((a, b) => a.i - b.i);
  const runs: string[][] = [];
  for (const p of pos) {
    const last = runs.at(-1);
    if (last && last.length < max && scene.beats.findIndex((b) => b.id === last.at(-1)) === p.i - 1) last.push(p.id);
    else runs.push([p.id]);
  }
  return runs;
}

const BatchBody = {
  tool: z.enum(BATCH_TOOLS).optional().describe('对每一句执行的写工具（参数放 args）：edit_beat|set_shot|nudge_shot|set_actor|set_fx|set_timing|set_keyframe|set_lock|edit_structure(只能 delete)'),
  args: z.record(z.string(), z.unknown()).optional().describe('该工具的参数，不含 sceneId / beatId / beatIds / fromBeatId / toBeatId（这些按命中的句子自动展开）。set_fx 会把连续的句子合成一段'),
  op: z.record(z.string(), z.unknown()).optional().describe('也可以不用 tool，直接给一个 AgentOp 模板（不含句子 id）：beat_set / shot_set / shot_offset / timing / fx_range / key_set / beat_delete / lock_set'),
  label: z.string().max(40).optional().describe('卡片上这一组的名字，如「景别改成 mcu」；省略则自动生成'),
  reason: z.string().max(200).optional(),
};
/** The schema the model sees (the filter is spelled out once, see ModelFilterSchema). */
export const BatchModelSchema = z.object({
  target: z.object({ queryId: BatchTargetSchema.shape.queryId, filter: ModelFilterSchema.optional().describe('直接给一个过滤条件，写法同 query_beats'), beatIds: BatchTargetSchema.shape.beatIds }).strict(),
  ...BatchBody,
}).strict();

export const BatchSchema = z.object({
  target: BatchTargetSchema,
  ...BatchBody,
}).strict();

export function batchEdit(env: ToolEnv, a: z.infer<typeof BatchSchema>, deps: BatchDeps): string {
  if ((a.tool === undefined) === (a.op === undefined)) return j({ 错误: ['tool+args 和 op 必须且只能给一个'] });
  const resolved = resolveTargets(env, a.target);
  if ('error' in resolved) return j({ 错误: resolved.error });
  const refs = resolved.refs;
  if (refs.length === 0) return j({ 结果: '过滤条件没有命中任何句子，没有改动。可以放宽条件，或先用 query_beats 看看。' });
  const byScene = new Map<string, string[]>();
  for (const r of refs) (byScene.get(r.sceneId) ?? byScene.set(r.sceneId, []).get(r.sceneId)!).push(r.beatId);

  const a0 = env.applied.length;
  const p0 = env.pending.length;
  const bad: string[] = [];
  const reason = (a.reason ?? (a.label ? `批量：${a.label}` : '批量修改')).slice(0, 200);
  const calls: Array<() => void> = [];

  if (a.tool !== undefined) {
    const schema = deps.toolSchema(a.tool);
    if (!schema) return j({ 错误: [`批量不支持工具 ${a.tool}`] });
    const args0 = { ...(a.args ?? {}) } as Record<string, unknown>;
    for (const k of ['sceneId', 'beatId', 'beatIds', 'fromBeatId', 'toBeatId']) if (k in args0) return j({ 错误: [`args 里不要写 ${k}：它由命中的句子自动填`] });
    if (a.tool === 'edit_structure' && args0.action !== 'delete') return j({ 错误: ['批量的 edit_structure 只支持 action=delete'] });
    if (a.tool === 'set_actor' || a.tool === 'nudge_shot') { if (typeof args0.castId !== 'string') return j({ 错误: [`${a.tool} 需要 args.castId（批量里对每一句的这个人做同样的事）`] }); }
    args0.reason = args0.reason ?? reason;
    const queue = (sceneId: string, extra: Record<string, unknown>) => {
      calls.push(() => {
        const parsed = schema.safeParse({ ...args0, sceneId, ...extra });
        if (!parsed.success) { env.stats.badArgs++; bad.push(...parsed.error.issues.slice(0, 3).map((i) => `参数 ${i.path.join('.') || '(根)'}：${i.message}`)); return; }
        const out = deps.writeTool(env, a.tool!, parsed.data as Record<string, unknown>);
        bad.push(...listFromJson(out).errors);
      });
    };
    for (const [sceneId, ids] of byScene) {
      if (a.tool in LIST_TOOLS) for (const part of chunk(ids, LIST_TOOLS[a.tool]!)) queue(sceneId, { beatIds: part });
      else if (a.tool === 'set_fx') {
        const fx = String(args0.fx ?? '');
        const max = fx === 'flash' || fx === 'shake' ? 1 : fx === 'dim' ? 4 : 1000;
        for (const run of runsOf(env, sceneId, ids, max)) queue(sceneId, { fromBeatId: run[0], toBeatId: run[run.length - 1] });
      } else for (const id of ids) queue(sceneId, { beatId: id });
    }
    // a wrong template fails once, not once per beat: try the first call alone
    const first = calls.shift()!;
    first();
    if (bad.length && env.applied.length === a0 && env.pending.length === p0) return j({ 错误: [...new Set(bad)].slice(0, 6), 说明: '批量没有开始（模板本身有问题），请改正参数后重试' });
    for (const c of calls) c();
  } else {
    const tpl = { ...(a.op as Record<string, unknown>) };
    // a raw template cannot carry the confirmation flags (overwriteManual of tool+args is the documented, user-named way)
    delete tpl.overrideUser;
    delete tpl.includeProtected;
    const parsedKind = typeof tpl.op === 'string' ? tpl.op : '';
    if (!['beat_set', 'shot_set', 'shot_offset', 'timing', 'fx_range', 'key_set', 'beat_delete', 'lock_set'].includes(parsedKind)) return j({ 错误: [`op 模板不支持 ${parsedKind || '(缺 op)'}`] });
    const withReason = { reason, ...tpl };
    const all: AgentOp[] = [];
    for (const [sceneId, ids] of byScene) {
      const consecutive = parsedKind === 'fx_range' ? runsOf(env, sceneId, ids, String(tpl.fx) === 'flash' || String(tpl.fx) === 'shake' ? 1 : String(tpl.fx) === 'dim' ? 4 : 1000) : [];
      for (const o of expandOp(withReason, sceneId, ids, consecutive)) {
        const p = AgentOpSchema.safeParse(o);
        if (!p.success) { if (all.length === 0 && bad.length === 0) return j({ 错误: p.error.issues.slice(0, 4).map((i) => `op.${i.path.join('.') || '(根)'}：${i.message}`), 说明: '批量没有开始（模板本身有问题）' }); bad.push('op 模板无效'); continue; }
        all.push(p.data);
      }
    }
    const first = all.shift();
    if (first) {
      const out = deps.commitOps(env, 'batch_edit', [first], { continueOnIssue: true });
      bad.push(...listFromJson(out).errors);
      if (bad.length && env.applied.length === a0 && env.pending.length === p0) return j({ 错误: [...new Set(bad)].slice(0, 6), 说明: '批量没有开始（模板本身有问题），请改正后重试' });
    }
    if (all.length) bad.push(...listFromJson(deps.commitOps(env, 'batch_edit', all, { continueOnIssue: true })).errors);
  }

  const recs = collectRecords(env, a0, p0);
  const s = summarise(env, recs, bad, { 命中: `${refs.length} 句` });
  const what = describeTemplate(a.tool, a.tool ? a.args ?? {} : opAsArgs(a.op as Record<string, unknown>));
  const n = s.beats || refs.length;
  const label = a.label ?? (/^(锁定|解锁|删除|批量修改|特效清除)/.test(what) ? `对 ${n} 句：${what}` : `把 ${n} 句的${what}`);
  tagRecords(recs, { id: nextGroupId(env, 'batch'), kind: 'batch', label });
  return s.text;
}

/** An op template read as the arguments of the matching tool, only to word the group label. */
function opAsArgs(tpl: Record<string, unknown>): Record<string, unknown> {
  const set = (tpl.set ?? {}) as Record<string, unknown>;
  switch (tpl.op) {
    case 'shot_set': return { __tool: 'set_shot', ...set };
    case 'beat_set': return { __tool: 'edit_beat', ...set };
    default: return {};
  }
}
