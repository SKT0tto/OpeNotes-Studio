import fs from 'node:fs';
import path from 'node:path';
import { LlmError, inputText, validateOutput, zeroUsage, type LlmProvider, type StructuredRequest, type StructuredResult } from './provider';

interface IndexEntry {
  schemaName: string;
  /** Substring(s) that must all occur in the serialised input; the first matching entry wins. */
  match?: string | string[];
  file: string;
}

/**
 * TEST-ONLY provider: replays recorded model outputs from `tests/fixtures/llm/` (see index.json). It is registered
 * only when the server runs with NODE_ENV=test; the UI labels it as a replay, never as AI.
 */
export class FixtureProvider implements LlmProvider {
  readonly id = 'fixture' as const;
  readonly model = 'fixture-replay';
  /** The answers were recorded when a long scene was directed in spans of 9 paragraphs (8192 tokens at 700 per paragraph); the cap keeps that split with today's 450 tokens per paragraph. */
  readonly maxOutputTokens = 5550;
  /** Every call, in order (tests assert how many calls were made and with what). */
  readonly calls: Array<{ schemaName: string; input: string }> = [];

  constructor(readonly dir: string) {}

  async generateStructured<T>(req: StructuredRequest<T>): Promise<Omit<StructuredResult<T>, 'cached'>> {
    const input = inputText(req.input);
    this.calls.push({ schemaName: req.schemaName, input });
    const index = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')) as IndexEntry[];
    const hit = index.find((e) => e.schemaName === req.schemaName && [e.match ?? []].flat().every((m) => input.includes(m)));
    if (!hit) throw new LlmError('bad_request', `没有可回放的录制响应：${req.schemaName}`);
    const raw = fs.readFileSync(path.join(this.dir, hit.file), 'utf8');
    return { data: validateOutput(req.schema, JSON.parse(raw), raw), usage: zeroUsage(), raw, warnings: [] };
  }

  async test() {
    return { model: this.model, latencyMs: 1 };
  }
}
