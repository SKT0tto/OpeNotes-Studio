/**
 * `run_script`, the host side. The model writes a short JavaScript snippet; a SANDBOX (server/agent/sandbox.ts: QuickJS compiled to WASM,
 * no host objects at all) runs it on a read-only JSON snapshot and the snippet RETURNS a list of AgentOps. It never changes anything itself.
 * Here every returned op is validated like any other (schema, `checkOp`, locks, hand-made content); the valid set is applied to the
 * turn's sandbox project in one go and becomes one change group on the card ("AI 写的脚本"), with the script text attached.
 *
 * Failures (syntax error, time / memory limit, an invalid op) are returned to the model as the tool result so it can fix the script and
 * retry; after `MAX_SCRIPT_FAILURES` failed runs the tool refuses and the model is told to use another way.
 */
import { z } from 'zod';
import { clone } from '../project/mutate';
import type { Project } from '../schema/project';
import { AgentOpSchema, type AgentOp } from './ops';
import { buildIndex, type BeatRow } from './query';
import { collectRecords, nextGroupId, summarise, tagRecords } from './batch';
import type { OpGroup, ToolEnv } from './tools';

export const MAX_SCRIPT_FAILURES = 3;
export const MAX_SCRIPT_OPS = 400;
export const MAX_SCRIPT_CHARS = 6000;
/** CPU time, memory and output limits of one script run. */
export const SCRIPT_LIMITS = { cpuMs: 2000, memoryBytes: 64 * 1024 * 1024, stackBytes: 512 * 1024, outputBytes: 400_000 } as const;

/** What the sandbox receives (all plain JSON). */
export interface ScriptSnapshot {
  project: Project;
  rows: BeatRow[];
  scenes: Array<{ id: string; no: number; title: string; beatIds: string[] }>;
  cast: Array<{ id: string; name: string }>;
}
export interface ScriptRun {
  ok: boolean;
  /** The JSON the script returned (an array of op-like objects) when ok. */
  result?: unknown;
  error?: string;
  logs: string[];
  ms: number;
  /** How the run ended when it was not ok: a script mistake, the CPU limit, the memory limit, or too much output. */
  failure?: 'error' | 'timeout' | 'memory' | 'output';
}
/** Runs a script in the sandbox; `queryFn` answers `query(filter)` calls from inside it (JSON in, JSON out). */
export type ScriptRunner = (code: string, snapshot: ScriptSnapshot, queryFn: (filterJson: string) => string) => ScriptRun;

export const ScriptSchema = z.object({
  code: z.string().min(1).max(MAX_SCRIPT_CHARS).describe('JavaScript 函数体：用 return 返回 op 数组。可用：project（只读 JSON）、scenes()、beats(sceneId)、beat(id)、query(filter)、visible(beatId)、op.setShot/setBeat/setEmotion/setTiming/nudge/setFx/insertBeat/deleteBeat/moveBeat/raw。'),
  description: z.string().min(1).max(60).describe('一句话说这个脚本做什么（卡片上的标题，例如「每隔三句插一个反应镜头」）'),
  reason: z.string().max(200).optional(),
}).strict();

const j = (o: unknown) => JSON.stringify(o);

export function snapshotOf(project: Project): ScriptSnapshot {
  const idx = buildIndex(project);
  return {
    project,
    rows: idx.rows,
    scenes: project.scenes.map((s, i) => ({ id: s.id, no: i + 1, title: s.title, beatIds: s.beats.map((b) => b.id) })),
    cast: project.cast.map((c) => ({ id: c.id, name: c.displayName })),
  };
}

/** Fields of an op that can hold a beat id (the placeholders of new beats are replaced there, never inside text). */
const ID_FIELDS = new Set(['beatId', 'afterBeatId', 'fromBeatId', 'toBeatId', 'beatIds', 'at']);
const substitute = (v: unknown, map: Map<string, string>, key = ''): unknown => {
  if (typeof v === 'string') return ID_FIELDS.has(key) ? map.get(v) ?? v : v;
  if (Array.isArray(v)) return v.map((x) => substitute(x, map, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, map, k)]));
  return v;
};
/** Escape hatches that only the user may pull (confirming hand-made content, taking locked keys along): a script never sets them. */
export const stripPrivileged = (o: Record<string, unknown>): Record<string, unknown> => { const rest = { ...o }; delete rest.overrideUser; delete rest.includeProtected; return rest; };

export interface ScriptDeps {
  commitOps: (env: ToolEnv, tool: string, ops: AgentOp[], extra?: { continueOnIssue?: boolean }) => string;
  freeBeatId: (scene: Project['scenes'][number]) => string;
  newStats: () => ToolEnv['stats'];
  queryFn: (project: Project) => (filterJson: string) => string;
}

/** Applies script ops one at a time (placeholders `$newN` of inserted beats become real ids as they are created); returns the errors. */
function commitScriptOps(env: ToolEnv, ops: AgentOp[], deps: ScriptDeps): string[] {
  const map = new Map<string, string>();
  const errors: string[] = [];
  ops.forEach((raw, i) => {
    const op = substitute(raw, map) as AgentOp;
    const o = op as unknown as { newId?: string; sceneId: string };
    const asked = (raw as unknown as { newId?: string }).newId;
    // a new beat ALWAYS gets a fresh id from the host (a script could name an id that already exists in another scene); whatever the
    // script called it ($newN, or anything else) is mapped to the real id for the ops after it
    if ((op.op === 'beat_insert' || op.op === 'beat_split') && typeof asked === 'string') {
      const scene = env.sandbox.scenes.find((s) => s.id === op.sceneId);
      if (!scene) { errors.push(`第 ${i + 1} 个 op：场景 ${op.sceneId} 不存在`); return; }
      o.newId = deps.freeBeatId(scene);
      map.set(asked, o.newId);
    }
    const out = JSON.parse(deps.commitOps(env, 'run_script', [op], { continueOnIssue: true })) as { 错误?: string[] };
    for (const e of out.错误 ?? []) errors.push(`第 ${i + 1} 个 op（${op.op}）：${e}`);
  });
  return errors;
}

export function runScriptTool(env: ToolEnv, a: z.infer<typeof ScriptSchema>, deps: ScriptDeps): string {
  if (!env.scriptRunner) return j({ 错误: ['当前环境没有脚本沙箱，不能用 run_script；请改用 query_beats + batch_edit 或单个工具'] });
  const failures = env.scriptFailures ?? 0;
  if (failures >= MAX_SCRIPT_FAILURES) return j({ 错误: [`run_script 已经失败 ${failures} 次，不再重试。请改用 query_beats + batch_edit / 其他工具，或在总结里如实告诉用户做不到`] });
  const fail = (errors: string[], extra: Record<string, unknown> = {}) => {
    env.scriptFailures = failures + 1;
    return j({ 错误: errors.slice(0, 8), ...extra, 剩余重试次数: Math.max(0, MAX_SCRIPT_FAILURES - env.scriptFailures), 说明: '脚本没有产生任何改动（失败的脚本不会部分生效）；修正后可以重新调用 run_script' });
  };

  const snap = snapshotOf(env.sandbox);
  const run = env.scriptRunner(a.code, snap, deps.queryFn(env.sandbox));
  const logs = run.logs.length ? { 脚本输出: run.logs } : {};
  if (!run.ok) {
    const why = run.failure === 'timeout' ? `脚本超时（CPU 限制 ${SCRIPT_LIMITS.cpuMs / 1000} 秒）：有死循环或计算太多` : run.failure === 'memory' ? `脚本内存超限（${SCRIPT_LIMITS.memoryBytes / 1024 / 1024} MB）` : run.failure === 'output' ? '脚本返回的内容太大' : `脚本出错：${run.error ?? '未知错误'}`;
    return fail([why], logs);
  }
  if (!Array.isArray(run.result)) return fail(['脚本必须 return 一个 op 数组（可以是空数组）'], logs);
  // a run that only printed (to look at the data before writing the real script) is fine: it does not use up a retry
  if (run.result.length === 0 && run.logs.length) return j({ 结果: '脚本返回了空数组：没有任何改动（只看了 console.log 输出，不计入失败次数）', ...logs });
  if (run.result.length === 0) return fail(['脚本返回了空数组，没有产生任何 op（条件可能没命中；用 console.log 看看）'], logs);
  if (run.result.length > MAX_SCRIPT_OPS) return fail([`脚本返回了 ${run.result.length} 个 op，上限 ${MAX_SCRIPT_OPS}；请分场景或收紧条件`], logs);

  // 1. schema
  const ops: AgentOp[] = [];
  const problems: string[] = [];
  run.result.forEach((raw, i) => {
    const withReason = raw && typeof raw === 'object' && !Array.isArray(raw) ? { reason: a.description, ...stripPrivileged(raw as Record<string, unknown>) } : raw;
    const p = AgentOpSchema.safeParse(withReason);
    if (p.success) ops.push(p.data);
    else problems.push(`第 ${i + 1} 个返回值不是合法的 op：${p.error.issues.slice(0, 2).map((x) => `${x.path.join('.') || '(根)'} ${x.message}`).join('；')}`);
  });
  if (problems.length) return fail(problems, logs);

  // 2. a dry run on a copy: any invalid op rejects the whole script (so a retry cannot double-apply the valid part)
  const tmp: ToolEnv = { ...env, sandbox: clone(env.sandbox), applied: [], pending: [], stats: deps.newStats(), seq: { n: 0 } };
  const dry = commitScriptOps(tmp, ops, deps);
  env.stats.opsChecked += tmp.stats.opsChecked;
  env.stats.opsInvalid += tmp.stats.opsInvalid;
  if (dry.length) return fail(dry, logs);

  // 3. for real
  const a0 = env.applied.length;
  const p0 = env.pending.length;
  const errors = commitScriptOps(env, ops, deps);
  const group: OpGroup = { id: nextGroupId(env, 'script'), kind: 'script', label: a.description, script: a.code };
  const recs = collectRecords(env, a0, p0);
  tagRecords(recs, group);
  const s = summarise(env, recs, errors, { 脚本返回: `${ops.length} 个 op`, ...logs });
  return s.text;
}
