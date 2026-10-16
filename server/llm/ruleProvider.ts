import { z } from 'zod';
import { nameIndex, ruleBreakdown, ruleDirection, type RuleSceneInput } from '../../shared/director/ruleDirector';
import type { DirectorCatalog } from '../../shared/director/resources';
import type { Paragraph } from '../../shared/director/paragraphs';
import type { ActorResources } from '../../shared/director/catalogDigest';
import { LlmError, inputText, validateOutput, zeroUsage, type LlmProvider, type StructuredRequest, type StructuredResult } from './provider';

/**
 * The deterministic rule director behind the same interface as the models: no key, no network, no cache. Its answers are
 * stamped `source: 'rule'` by the pipeline (never "AI") and the UI labels them "规则生成（非 AI）".
 */
export class RuleProvider implements LlmProvider {
  readonly id = 'rule' as const;
  readonly model = 'rule-director';
  readonly maxOutputTokens = 1_000_000;
  private readonly idx;
  constructor(private readonly catalog: DirectorCatalog) {
    this.idx = nameIndex(catalog);
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<Omit<StructuredResult<T>, 'cached'>> {
    const input = (typeof req.input === 'string' ? JSON.parse(req.input) : req.input) as Record<string, unknown>;
    let out: unknown;
    if (req.schemaName === 'Breakdown') {
      const paras = (input.paragraphs as Array<{ i: number; text: string }>).map((p) => ({ index: p.i, text: p.text, start: 0, end: 0 }) as Paragraph);
      out = ruleBreakdown(this.catalog, paras);
    } else if (req.schemaName === 'SceneDirection' || req.schemaName === 'SceneDirectionTravel') {
      const scene = input.scene as { isPerformance: boolean };
      const si: RuleSceneInput = {
        cast: input.cast as ActorResources[], paragraphs: input.paragraphs as RuleSceneInput['paragraphs'], previousScene: input.previousScene ?? null,
        isPerformance: scene.isPerformance, fixedBeats: (input.fixedBeats as RuleSceneInput['fixedBeats']) ?? [],
        ...(req.schemaName === 'SceneDirectionTravel' ? { travel: true } : {}),
      };
      out = ruleDirection(this.idx, this.catalog, si);
    } else throw new LlmError('bad_request', `规则导演不支持 ${req.schemaName}`);
    const raw = inputText(out);
    return { data: validateOutput(req.schema as z.ZodType<T>, JSON.parse(raw), raw), usage: zeroUsage(), raw, warnings: [] };
  }

  async test() {
    return { model: this.model, latencyMs: 0 };
  }
}
