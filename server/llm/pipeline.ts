/** One AI step with its safety net: cache -> zod -> semantic validation/repair -> at most ONE LLM repair call. */
import type { StructuredRequest } from './provider';
import { LlmError, inputText, type LlmProvider, type LlmUsage, zeroUsage } from './provider';
import { LlmCache, generateCached } from './cache';
import type { Validated } from '../../shared/director/validate';

export interface RunInfo {
  pass: 'breakdown' | 'scene';
  label: string;
  provider: string;
  model: string;
  cached: boolean;
  ms: number;
  usage: LlmUsage;
  repaired: boolean;
  warnings: string[];
}

export class DirectorError extends Error {
  constructor(public readonly kind: 'repair_failed' | 'llm', message: string, public readonly problems: string[] = [], public readonly cause2?: unknown) {
    super(message);
    this.name = 'DirectorError';
  }
}

export interface StepInput<T> {
  provider: LlmProvider;
  cache: LlmCache | null;
  promptVersion: string;
  req: StructuredRequest<T>;
  validate: (data: T) => Validated<T>;
  label: string;
  pass: RunInfo['pass'];
  refresh?: boolean;
}

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
});

/** The follow-up input of the repair call: the original task, what the model said, and exactly what is wrong. */
const repairInput = (original: unknown, previous: string, problems: string[]) => ({
  task: '你上一次的输出有问题，请修正后重新输出完整 JSON（仍然只用给定的 ID 和词汇）。',
  originalInput: original,
  previousOutput: previous.slice(0, 14000),
  problems: problems.slice(0, 30),
});

export async function runStep<T>(s: StepInput<T>): Promise<{ value: T; info: RunInfo }> {
  const t0 = Date.now();
  let usage = zeroUsage();
  let cachedAll = true;
  let repaired = false;
  const warnings: string[] = [];
  const call = async (req: StructuredRequest<T>) => {
    const r = await generateCached(s.provider, s.cache, s.promptVersion, req, s.refresh ? { refresh: true } : {});
    usage = addUsage(usage, r.usage);
    cachedAll &&= r.cached;
    warnings.push(...r.warnings);
    return r;
  };
  let repairedData: T | null = null;
  const repairWith = async (previous: string, problems: string[]) => {
    repaired = true;
    const r = await call({ ...s.req, input: repairInput(s.req.input, previous, problems) });
    repairedData = r.data;
    return r;
  };

  let data: T;
  try {
    const r = await call(s.req);
    data = r.data;
  } catch (e) {
    // malformed JSON / schema violation: one repair call with the issue list
    if (!(e instanceof LlmError) || e.kind !== 'invalid_output') throw e;
    const r = await repairWith(e.detail?.raw ?? '', e.detail?.issues ?? [e.message]).catch((e2) => {
      throw e2 instanceof LlmError && e2.kind === 'invalid_output' ? new DirectorError('repair_failed', `模型输出两次都不符合 schema：${e2.message}`, e2.detail?.issues ?? [], e2) : e2;
    });
    data = r.data;
  }
  let v = s.validate(data);
  if (v.errors.length > 0 && !repaired) {
    const r = await repairWith(inputText(data), v.errors);
    v = s.validate(r.data);
  }
  if (v.errors.length > 0) throw new DirectorError('repair_failed', `无法修复：${v.errors.join('；')}`, v.errors);
  // the good answer also answers the ORIGINAL request next time (otherwise the failing first call would be repeated on every run)
  if (repaired && repairedData !== null && s.cache && !s.refresh) {
    await s.cache.set(LlmCache.key(s.provider, s.promptVersion, s.req as StructuredRequest<unknown>), { data: repairedData, raw: '', usage, createdAt: Date.now(), provider: s.provider.id, model: s.provider.model, schemaName: s.req.schemaName }).catch(() => {});
  }
  warnings.push(...v.warnings);
  return { value: v.value, info: { pass: s.pass, label: s.label, provider: s.provider.id, model: s.provider.model, cached: cachedAll, ms: Date.now() - t0, usage, repaired, warnings } };
}
