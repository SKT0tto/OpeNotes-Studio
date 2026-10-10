import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from '../../server/llm/anthropic';

// Runs only when ANTHROPIC_API_KEY is in the environment: one minimal structured call to Claude.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('Claude (real API)', () => {
  it('returns schema-valid structured output and reports usage', async () => {
    const p = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const r = await p.generateStructured({
      system: '只输出 JSON。', input: '给出标题"测试"和数字 3。', schema: z.object({ title: z.string(), n: z.number() }), schemaName: 'Mini', maxTokens: 300,
    });
    expect(r.data.title).toBe('测试');
    expect(r.data.n).toBe(3);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
  }, 60_000);
});
