import type { z } from 'zod';
import { LlmError, zeroUsage, type ChatToolsRequest, type ChatToolsResult, type LlmProvider, type StructuredRequest, type StructuredResult, type ToolCall } from '../../../server/llm/provider';

export const call = (name: string, args: unknown, id = `c_${Math.random().toString(36).slice(2, 8)}`): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
export const reply = (text: string, toolCalls: ToolCall[] = [], usage = { inputTokens: 1000, outputTokens: 100 }): ChatToolsResult => ({ text, toolCalls, usage: { ...zeroUsage(), ...usage }, finish: toolCalls.length ? 'tool_calls' : 'stop' });

type ToolStep = ChatToolsResult | Error | ((req: ChatToolsRequest) => ChatToolsResult);
/** A mock model: replays scripted answers, records every request. No network, no real LLM. */
export class ScriptedProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly model = 'scripted';
  readonly toolRequests: ChatToolsRequest[] = [];
  readonly structuredRequests: Array<StructuredRequest<unknown>> = [];
  unsupportedNoted = 0;
  private supported = true;
  constructor(private readonly tools: ToolStep[], private readonly structured: unknown[] = [], readonly withTools = true) {
    if (!withTools) Object.defineProperty(this, 'chatTools', { value: undefined });
  }
  async chatTools(req: ChatToolsRequest): Promise<ChatToolsResult> {
    this.toolRequests.push(JSON.parse(JSON.stringify(req)) as ChatToolsRequest);
    const s = this.tools.shift();
    if (s === undefined) throw new Error('script exhausted');
    if (s instanceof Error) throw s;
    return typeof s === 'function' ? s(req) : s;
  }
  toolsSupported() {
    return this.supported;
  }
  noteToolsUnsupported() {
    this.supported = false;
    this.unsupportedNoted++;
  }
  async generateStructured<T>(req: StructuredRequest<T>): Promise<Omit<StructuredResult<T>, 'cached'>> {
    this.structuredRequests.push(req as StructuredRequest<unknown>);
    const s = this.structured.shift();
    if (s === undefined) throw new Error('structured script exhausted');
    const data = (req.schema as z.ZodType<T>).parse(s);
    return { data, usage: { ...zeroUsage(), inputTokens: 500, outputTokens: 50 }, raw: JSON.stringify(s), warnings: [] };
  }
  async test() {
    return { model: this.model, latencyMs: 1 };
  }
}
export const badRequest = () => new LlmError('bad_request', 'tools unsupported', { status: 400 });
