/**
 * Step 2 of a scene (only for a full-scene generation with `DirectorDeps.splitLongLines`): the lines of the finished direction that do
 * not fit the dialogue area are cut into consecutive lines of the same speaker.
 *
 *  1. Measure (`fitsDialog`, the one source of truth) and pick the lines that are too long and not fixed (locked / hand-made / expanded).
 *  2. With a model: ONE small `LineSplit` call for the scene (more only when there are many lines), every answer checked by `checkPieces`;
 *     the lines that fail are sent back once with the problem list; a line that still fails, and a failing call, fall back to the
 *     deterministic splitter (`splitForDialog`) with a warning. An abort is never swallowed.
 *     The rule engine, which has no model, uses the deterministic splitter directly.
 *  3. Soft repair of motions / expressions / camera intent (`repairPieces`), then `applySplitPlans`.
 */
import { stageEvents, stageTimeline } from '../../shared/director/stage';
import { normalizeIntents } from '../../shared/director/intentNormalize';
import type { ActorResources } from '../../shared/director/catalogDigest';
import { checkPieces, charsPerLine, minPiecesFor, splitForDialog, wrapperOf } from '../../shared/director/splitLines';
import { applySplitPlans, repairPieces, type PieceDecision, type SplitBy, type SplitPlan } from '../../shared/director/splitPieces';
import { repairExpression, repairMotion } from '../../shared/director/validate';
import type { ModelEntry } from '../../shared/schema/assets';
import type { LineSplit, SceneDirection } from '../../shared/schema/ai';
import { fitsDialog, type DialogMetrics } from '../../shared/style/dialogLayout';
import type { DirectorDeps } from './director';
import { LlmCache, generateCached } from './cache';
import type { RunInfo } from './pipeline';
import { LlmError, zeroUsage, type LlmUsage, type StructuredRequest } from './provider';
import { LineSplitSchema, SPLIT_PROMPT_VERSION, SPLIT_SCHEMA_NAME, SPLIT_SYSTEM, splitRepairInput, splitRequestInput, type SplitInput, type SplitLineInput } from './prompts/lineSplit';

/** Lines per call: more than this are sent in several calls. */
export const MAX_LINES_PER_CALL = 20;

/**
 * The output budget of one call: every line is answered with its pieces repeated verbatim plus a reason / emotion / camera each, about
 * `300 + 1.3 x characters` tokens (a real 13-line scene came to ~410 per line), with 40% headroom, plus a thinking allowance (a floor of
 * 4096 per call, like the other director calls' 4000+ bases). A budget that is too tight cuts the answer off and costs a second call.
 */
/** Reasoning tokens of a thinking model (deepseek-flash...) count against `max_tokens` too: every call gets at least this much on top of the visible JSON. */
export const SPLIT_THINKING_ALLOWANCE = 4096;

export function splitOutputBudget(textLengths: readonly number[], cap: number): number {
  const need = textLengths.reduce((s, n) => s + 300 + 1.3 * n, 0);
  return Math.min(cap, Math.ceil(SPLIT_THINKING_ALLOWANCE + 1.4 * need));
}

export interface SplitPassArgs {
  d: DirectorDeps;
  direction: SceneDirection;
  /** Scene title and mood (the prompt), the camera system (the continuation's shot intent). */
  scene: { title: string; mood: string };
  cameraSystem: 'classic' | 'travel';
  /** The scene's resolved dialogue style: the threshold is its `maxLines`. */
  style: DialogMetrics;
  castIds: string[];
  /** The resources of an actor in the outfit he wears at that beat (null: unknown). */
  actorAt(castId: string, beatIndex: number): { res: ActorResources; model: ModelEntry } | null;
  /** Prefix of warnings that name a line ("场景名"). */
  label: string;
  /** Called once with the number of lines about to be cut, before any model call. */
  onStart?: ((count: number) => void) | undefined;
}

export interface SplitPassResult {
  direction: SceneDirection;
  /** The lines that were cut; `headAt` is the index of the first piece in `direction.beats`. */
  plans: Array<SplitPlan & { headAt: number }>;
  warnings: string[];
  runs: RunInfo[];
}

interface Candidate {
  /** Index in the direction's beats. */
  index: number;
  id: string;
  text: string;
}

type RawLine = LineSplit['lines'][number];

const isAbort = (d: DirectorDeps, e: unknown): boolean => d.signal?.aborted === true || (e instanceof LlmError && e.kind === 'aborted') || (e as { name?: string } | null)?.name === 'AbortError';

const clip = (s: string, n: number) => [...s].slice(0, n).join('');

/** The deterministic split of one line: pieces that pass `checkPieces` (or the splitter's own when even that does not), and its warnings. */
function ruleSplit(text: string, style: DialogMetrics): { pieces: string[]; warnings: string[] } {
  const sp = splitForDialog(text, style, 'normal');
  const warnings = [...sp.warnings];
  if (sp.pieces.length < 2) return { pieces: [text], warnings };
  const c = checkPieces(text, sp.pieces, style, 'normal', { maxExtra: 8 });
  if (!c.ok) {
    warnings.push(`按标点拆分的结果没有通过检查：${c.problems.join('；')}`);
    return { pieces: sp.pieces, warnings };
  }
  return { pieces: c.pieces, warnings };
}

export async function runSplitPass(a: SplitPassArgs): Promise<SplitPassResult> {
  const { d, direction, style } = a;
  const beats = direction.beats;
  const warnings: string[] = [];
  const runs: RunInfo[] = [];
  // ---- 1. measure -----------------------------------------------------------------------------------------------
  const candidates: Candidate[] = [];
  beats.forEach((b, i) => {
    if ((b.kind !== 'dialogue' && b.kind !== 'narration') || !b.text || b.keepId !== null) return;
    if (!fitsDialog(b.text, style, 'normal').over) return;
    candidates.push({ index: i, id: `L${candidates.length + 1}`, text: b.text });
  });
  if (candidates.length === 0) return { direction, plans: [], warnings, runs };
  a.onStart?.(candidates.length);

  const stage = stageTimeline(beats, a.castIds);
  const where = (c: Candidate) => `${a.label}第 ${c.index + 1} 句`;

  // ---- 2. who cuts ----------------------------------------------------------------------------------------------
  const accepted = new Map<string, { raw: RawLine; by: SplitBy; texts: string[] }>();
  const fallback = new Map<string, string>();
  if (d.provider.id === 'rule') {
    // no model: the deterministic splitter, nothing to report
  } else {
    const input = buildInput(a, candidates, stage);
    const outcome = await askModel(a, input, candidates, runs);
    for (const [id, v] of outcome.accepted) accepted.set(id, v);
    for (const [id, why] of outcome.fallback) fallback.set(id, why);
  }

  // ---- 3. decisions ---------------------------------------------------------------------------------------------
  const plans: SplitPlan[] = [];
  for (const c of candidates) {
    const b = beats[c.index]!;
    const ai = accepted.get(c.id);
    if (ai) {
      const at = a.actorAt(b.speaker ?? '', c.index);
      const rep = repairPieces(ai.raw.pieces, ai.texts, {
        speaker: b.kind === 'dialogue' ? b.speaker : null, onStage: stage[c.index] ?? new Set(), emotion: b.emotion, where: where(c),
        resolveMotion: (w, e) => (at ? (at.res.motions.includes(w) ? w : repairMotion(at.model, w, e)) : null),
        resolveExpression: (w, e) => (at ? (at.res.expressions.includes(w) ? w : repairExpression(at.model, w, e)) : null),
      });
      warnings.push(...rep.warnings);
      plans.push({ index: c.index, pieces: rep.pieces, by: ai.by });
      continue;
    }
    const why = fallback.get(c.id);
    const r = ruleSplit(c.text, style);
    if (why) warnings.push(`${where(c)}：${why}`);
    for (const w of r.warnings) warnings.push(`${where(c)}：${w}`);
    if (r.pieces.length < 2) continue;
    const pieces: PieceDecision[] = r.pieces.map((text) => ({ text, emotion: b.emotion, why: '长句续行', camera: 'hold', reactionOf: null, actor: null }));
    plans.push({ index: c.index, pieces, by: 'rule' });
  }

  // ---- 4. insert the pieces ---------------------------------------------------------------------------------------
  const travel = a.cameraSystem === 'travel';
  const out = applySplitPlans(direction, plans, { travel });
  if (travel && plans.length > 0) {
    // the continuations' intent labels are checked like any other beat's (the other beats are left as they are)
    warnings.push(...normalizeIntents(out.beats, {
      castIds: a.castIds, events: stageEvents(out.beats), skip: (b) => b.splitOf === undefined, where: (i) => `${a.label}第 ${i + 1} 句`,
    }));
  }
  let extra = 0;
  const placed = [...plans].sort((x, y) => x.index - y.index).map((p) => {
    const headAt = p.index + extra;
    extra += p.pieces.length - 1;
    return { ...p, headAt };
  });
  return { direction: out, plans: placed, warnings, runs };
}

// ---- the model -------------------------------------------------------------------------------------------------

function buildInput(a: SplitPassArgs, candidates: Candidate[], stage: Array<ReadonlySet<string>>): SplitInput {
  const beats = a.direction.beats;
  const near = (i: number, step: -1 | 1) => {
    const out: SplitLineInput['before'] = [];
    for (let k = i + step; k >= 0 && k < beats.length && out.length < 2; k += step) {
      const b = beats[k]!;
      if (!b.text) continue;
      out.push({ speaker: b.kind === 'dialogue' ? b.speaker : null, text: clip(b.text, 40) });
    }
    return step < 0 ? out.reverse() : out;
  };
  const lines: SplitLineInput[] = candidates.map((c) => {
    const b = beats[c.index]!;
    const wrap = wrapperOf(c.text);
    const min = minPiecesFor(c.text, a.style, 'normal');
    return {
      id: c.id, kind: b.kind, speaker: b.kind === 'dialogue' ? b.speaker : null, emotion: b.emotion, text: c.text,
      measuredLines: fitsDialog(c.text, a.style, 'normal').lines, minPieces: min, maxPieces: min + 1,
      wrapped: wrap ? wrap.open + wrap.close : null, shot: { type: b.shot.type, focus: b.shot.focus }, onStage: [...(stage[c.index] ?? [])],
      before: near(c.index, -1), after: near(c.index, 1),
    };
  });
  // the people these lines involve; only the speakers get their motion / expression lists
  const speakerAt = new Map<string, number>();
  for (const c of candidates) {
    const b = beats[c.index]!;
    if (b.kind === 'dialogue' && b.speaker && !speakerAt.has(b.speaker)) speakerAt.set(b.speaker, c.index);
  }
  const involved = new Set<string>([...speakerAt.keys(), ...lines.flatMap((l) => l.onStage)]);
  const cast = [...involved].sort().map((castId) => {
    const at = speakerAt.has(castId) ? a.actorAt(castId, speakerAt.get(castId)!) : a.actorAt(castId, 0);
    return { castId, name: at?.res.name ?? castId, expressions: speakerAt.has(castId) ? at?.res.expressions ?? [] : [], motions: speakerAt.has(castId) ? at?.res.motions ?? [] : [] };
  });
  return {
    box: { maxLines: a.style.maxLines, charsPerLine: charsPerLine(a.style), note: '字数只是参考，程序会逐段测量' },
    scene: { title: a.scene.title, mood: a.scene.mood, cameraSystem: a.cameraSystem },
    cast, lines,
  };
}

interface ModelOutcome {
  accepted: Map<string, { raw: RawLine; by: SplitBy; texts: string[] }>;
  /** Lines that go to the deterministic splitter, with the reason to show. */
  fallback: Map<string, string>;
}

async function askModel(a: SplitPassArgs, input: SplitInput, candidates: Candidate[], runs: RunInfo[]): Promise<ModelOutcome> {
  const { d } = a;
  const t0 = Date.now();
  let usage: LlmUsage = zeroUsage();
  let cachedAll = true;
  const callWarnings: string[] = [];
  const cap = d.provider.maxOutputTokens ?? 16000;
  const accepted: ModelOutcome['accepted'] = new Map();
  const fallback: ModelOutcome['fallback'] = new Map();
  const text = new Map(candidates.map((c) => [c.id, c.text]));

  const request = (inp: Record<string, unknown>, ids: string[], scale = 1): StructuredRequest<LineSplit> => ({
    system: SPLIT_SYSTEM, input: inp, schema: LineSplitSchema, schemaName: SPLIT_SCHEMA_NAME,
    maxTokens: Math.min(cap, splitOutputBudget(ids.map((id) => [...(text.get(id) ?? '')].length), cap) * scale), signal: d.signal,
  });
  /** Lines whose call was cut off for good (or failed in a half): only these fall back; the rest of the batch keeps its answers. */
  const lost = new Map<string, string>();
  const lose = (ids: string[], why: string) => { for (const id of ids) if (!accepted.has(id)) lost.set(id, why); };
  /**
   * One call. A cut-off answer is asked again for each half of the lines; a single line that is cut off is asked once more with double the
   * budget before it is given up (recorded in `lost`, not thrown). A failing half does not take the other half's answers with it.
   */
  const call = async (ids: string[], mk: (ids: string[]) => Record<string, unknown>, scale = 1): Promise<LineSplit[]> => {
    try {
      const r = await generateCached(d.provider, d.cache, SPLIT_PROMPT_VERSION, request(mk(ids), ids, scale), d.refresh ? { refresh: true } : {});
      usage = { inputTokens: usage.inputTokens + r.usage.inputTokens, outputTokens: usage.outputTokens + r.usage.outputTokens, cacheReadTokens: usage.cacheReadTokens + r.usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens + r.usage.cacheCreationTokens };
      cachedAll &&= r.cached;
      callWarnings.push(...r.warnings);
      return [r.data];
    } catch (e) {
      if (!(e instanceof LlmError && e.kind === 'truncated')) throw e;
      if (ids.length === 1) {
        const budget = Math.min(cap, splitOutputBudget(ids.map((id) => [...(text.get(id) ?? '')].length), cap));
        // a budget already at the cap cannot be doubled: the retry would be the identical request
        if (scale < 2 && Math.min(cap, budget * 2) > budget) return call(ids, mk, 2);
        lose(ids, scale < 2 ? '模型输出被截断（预算已达上限，无法加倍），已按标点拆分' : '模型输出被截断（加倍预算重试后仍然截断），已按标点拆分');
        return [];
      }
      const mid = Math.ceil(ids.length / 2);
      const out: LineSplit[] = [];
      for (const half of [ids.slice(0, mid), ids.slice(mid)]) {
        try {
          out.push(...(await call(half, mk)));
        } catch (err) {
          if (isAbort(d, err)) throw err;
          lose(half, `长句拆分调用失败（${(err as Error).message}），已按标点拆分`);
        }
      }
      return out;
    }
  };

  /** Check what came back for `ids`: accept the lines that pass, return the ones that do not with what is wrong. */
  const judge = (answers: LineSplit[], ids: string[], by: SplitBy): Map<string, string[]> => {
    const problems = new Map<string, string[]>();
    const lines = answers.flatMap((x) => x.lines);
    for (const id of ids) {
      if (lost.has(id)) continue;
      const hits = lines.filter((l) => l.id === id);
      if (hits.length === 0) {
        problems.set(id, [`${id}：没有给出这句的拆分`]);
        continue;
      }
      const raw = hits[0]!;
      if (hits.length > 1) {
        problems.set(id, [`${id}：回答了 ${hits.length} 次，只能回答一次`]);
        continue;
      }
      const original = text.get(id)!;
      const c = checkPieces(original, raw.pieces.map((p) => p.text), a.style, 'normal', { maxExtra: 1 });
      if (!c.ok) {
        problems.set(id, c.problems.map((p) => `${id}：${p}`));
        continue;
      }
      accepted.set(id, { raw, by, texts: c.pieces });
    }
    return problems;
  };

  const ids = candidates.map((c) => c.id);
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_LINES_PER_CALL) batches.push(ids.slice(i, i + MAX_LINES_PER_CALL));
  let failing = new Map<string, string[]>();
  const previous: LineSplit[] = [];
  const subset = (b: string[]): SplitInput => ({ ...input, lines: input.lines.filter((l) => b.includes(l.id)) });
  const firstReqInputs: Array<{ ids: string[]; req: StructuredRequest<LineSplit> }> = [];
  for (const b of batches) {
    try {
      const mk = (x: string[]) => splitRequestInput({ ...input, lines: input.lines.filter((l) => x.includes(l.id)) });
      const answers = await call(b, mk);
      previous.push(...answers);
      firstReqInputs.push({ ids: b, req: request(mk(b), b) });
      for (const [id, p] of judge(answers, b, 'ai')) failing.set(id, p);
    } catch (e) {
      if (isAbort(d, e)) throw e;
      if (e instanceof LlmError && e.kind === 'invalid_output') {
        // malformed answer: the same one retry, with the issue list as the problems
        for (const id of b) failing.set(id, [`${id}：输出不符合 JSON Schema：${(e.detail?.issues ?? [e.message]).slice(0, 3).join('；')}`]);
        continue;
      }
      // the call itself failed: the rest of the scene is cut by punctuation
      const why = `长句拆分调用失败（${(e as Error).message}），已按标点拆分`;
      for (const id of b) if (!accepted.has(id)) fallback.set(id, why);
    }
  }

  // ---- the one retry: only the failing lines, with the problem list ----------------------------------------------------
  let retried = false;
  const retryIds = [...failing.keys()].filter((id) => !lost.has(id));
  if (retryIds.length > 0) {
    retried = true;
    const allProblems = [...failing.values()].flat();
    const prevOfFailing = previous.map((p) => ({ lines: p.lines.filter((l) => failing.has(l.id)) }));
    try {
      const answers = await call(retryIds, (x) => splitRepairInput(subset(x), x, prevOfFailing, allProblems.filter((p) => x.some((id) => p.startsWith(`${id}：`)))));
      const still = judge(answers, retryIds, 'retry');
      for (const id of still.keys()) fallback.set(id, 'AI 拆分两次不合格，已按标点拆分');
      failing = still;
    } catch (e) {
      if (isAbort(d, e)) throw e;
      for (const id of retryIds) fallback.set(id, `AI 拆分重试失败（${(e as Error).message}），已按标点拆分`);
    }
  }

  for (const [id, why] of lost) if (!accepted.has(id) && !fallback.has(id)) fallback.set(id, why);

  // the repaired answer also answers the ORIGINAL request next time (otherwise the failing first call would be repeated on every run)
  if (retried && d.cache && !d.refresh && firstReqInputs.length === 1 && batches.length === 1 && fallback.size === 0) {
    const only = firstReqInputs[0]!;
    const data: LineSplit = { lines: only.ids.map((id) => accepted.get(id)!.raw) };
    await d.cache.set(LlmCache.key(d.provider, SPLIT_PROMPT_VERSION, only.req as StructuredRequest<unknown>), {
      data, raw: '', usage, createdAt: Date.now(), provider: d.provider.id, model: d.provider.model, schemaName: SPLIT_SCHEMA_NAME,
    }).catch(() => {});
  }

  runs.push({
    pass: 'split', label: `${a.label} · 拆分长句（${candidates.length} 句）`, provider: d.provider.id, model: d.provider.model, cached: cachedAll, ms: Date.now() - t0, usage, repaired: retried, warnings: callWarnings,
  });
  return { accepted, fallback };
}
