/** Orchestration of the AI director on the server: Pass 1 (breakdown) and Pass 2 (scene direction). */
import { breakdownDigest } from '../../shared/director/catalogDigest';
import { projectFromBreakdown } from '../../shared/director/fromBreakdown';
import { chunkParagraphs, splitParagraphs, type Paragraph } from '../../shared/director/paragraphs';
import { validateBreakdown } from '../../shared/director/validate';
import { BreakdownSchema, type Breakdown } from '../../shared/schema/ai';
import type { Project } from '../../shared/schema/project';
import type { DirectorCatalog } from '../../shared/director/resources';
import type { LlmCache } from './cache';
import { runStep, type RunInfo } from './pipeline';
import { LlmError, isModelAi, type LlmProvider } from './provider';
import { BREAKDOWN_PROMPT_VERSION, BREAKDOWN_SYSTEM, breakdownInput, type BreakdownCarry } from './prompts/breakdown';

export interface DirectorDeps {
  provider: LlmProvider;
  cache: LlmCache | null;
  catalog: DirectorCatalog;
  /** Local models: keep only the best N backgrounds in the prompt. */
  backgroundLimit?: number | undefined;
  refresh?: boolean | undefined;
  signal?: AbortSignal | undefined;
  /** The user's long-term preferences (assistant memory) for scene direction; absent / null = none, and the scene input stays byte-identical. */
  preferences?: { note: string; items: string[] } | null | undefined;
  /** Cut lines that do not fit the dialogue area into consecutive lines (a second, small call per scene). Off unless a product route asks for it, so library callers and the golden tests keep today's behaviour. */
  splitLongLines?: boolean | undefined;
  now?: () => number;
}

export interface BreakdownResult {
  breakdown: Breakdown;
  paragraphs: Paragraph[];
  project: Project;
  warnings: string[];
  runs: RunInfo[];
}

/** Output budget of one breakdown call: about 600 tokens per scene, generous (an unused budget costs nothing); a truncated answer is split and retried. */
const breakdownTokens = (n: number, cap = 16000) => Math.min(cap, 4000 + n * 120);

async function breakdownChunk(d: DirectorDeps, system: string, prefix: string, paras: Paragraph[], carry: BreakdownCarry | null, runs: RunInfo[], depth = 0): Promise<Breakdown> {
  const first = paras[0]!.index;
  try {
    const { value, info } = await runStep({
      provider: d.provider, cache: d.cache, promptVersion: BREAKDOWN_PROMPT_VERSION, pass: 'breakdown', label: `段落 ${first}–${paras.at(-1)!.index}`,
      refresh: d.refresh === true,
      req: { system, cacheablePrefix: prefix, input: breakdownInput(paras, carry), schema: BreakdownSchema, schemaName: 'Breakdown', maxTokens: breakdownTokens(paras.length, d.provider.maxOutputTokens), signal: d.signal },
      validate: (b) => validateBreakdown(b, { catalog: d.catalog, paragraphCount: paras.length, paragraphOffset: first }),
    });
    runs.push(info);
    return value;
  } catch (e) {
    // truncated output: split the chunk in two (once) and continue with the second half after the first
    if (e instanceof LlmError && e.kind === 'truncated' && depth < 2 && paras.length >= 4) {
      const mid = Math.ceil(paras.length / 2);
      const a = await breakdownChunk(d, system, prefix, paras.slice(0, mid), carry, runs, depth + 1);
      const b = await breakdownChunk(d, system, prefix, paras.slice(mid), carryOf(a, carry), runs, depth + 1);
      return mergeBreakdowns(a, b);
    }
    throw e;
  }
}

const carryOf = (b: Breakdown, prev: BreakdownCarry | null): BreakdownCarry => {
  const last = b.scenes.at(-1);
  const known = new Map((prev?.knownCast ?? []).map((c) => [c.nameInText, c]));
  for (const c of b.cast) known.set(c.nameInText, { nameInText: c.nameInText, characterKey: c.characterKey });
  return {
    knownCast: [...known.values()],
    lastScene: last ? { title: last.title, backgroundId: last.location.backgroundId, timeOfDay: last.timeOfDay, wardrobe: last.wardrobe.map((w) => ({ characterKey: w.characterKey, modelId: w.modelId })) } : (prev?.lastScene ?? null),
  };
};

export function mergeBreakdowns(a: Breakdown, b: Breakdown): Breakdown {
  const cast = new Map(a.cast.map((c) => [c.nameInText, c]));
  for (const c of b.cast) if (!cast.has(c.nameInText)) cast.set(c.nameInText, c);
  return { cast: [...cast.values()], scenes: [...a.scenes, ...b.scenes] };
}

/** Pass 1 over the whole text (about 20k characters per call), then the deterministic project skeleton. */
export async function runBreakdown(d: DirectorDeps, text: string, title: string, genId: string): Promise<BreakdownResult> {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) throw new LlmError('bad_request', '文本为空');
  const prefix = breakdownDigest(d.catalog, { ...(d.backgroundLimit ? { backgroundLimit: d.backgroundLimit, text } : {}) });
  const runs: RunInfo[] = [];
  let merged: Breakdown | null = null;
  let carry: BreakdownCarry | null = null;
  for (const chunk of chunkParagraphs(paragraphs)) {
    const b = await breakdownChunk(d, BREAKDOWN_SYSTEM, prefix, chunk, carry, runs);
    merged = merged ? mergeBreakdowns(merged, b) : b;
    carry = carryOf(b, carry);
  }
  const breakdown = merged!;
  const project = projectFromBreakdown({ title, text, paragraphs, breakdown, catalog: d.catalog, genId, now: (d.now ?? Date.now)(), decisions: isModelAi(d.provider) ? 'ai' : 'rule' });
  return { breakdown, paragraphs, project, warnings: runs.flatMap((r) => r.warnings), runs };
}
