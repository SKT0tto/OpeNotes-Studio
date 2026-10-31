import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_ANTHROPIC_MODEL } from '../../shared/schema/settings';
import {
  LlmError, TruncatedError, extractJson, inputText, modelJsonSchema, redact, validateOutput, zeroUsage,
  type ChatImage, type ChatToolsRequest, type ChatToolsResult, type ChatTurn, type DescribeImagesRequest, type LlmProvider, type LlmUsage, type StructuredRequest, type StructuredResult, type TestResult,
} from './provider';

export interface AnthropicOptions {
  apiKey: string;
  model?: string | undefined;
  baseUrl?: string | undefined;
  /** Injected in tests (mock fetch). */
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
  effort?: 'low' | 'medium' | 'high';
}

/** Above this the SDK requires streaming (HTTP timeouts), so `finalMessage()` is used instead of one blocking call. */
const STREAM_ABOVE = 16000;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** Claude content blocks: the text, then each picture preceded by its label (a `data:` URL that is not a supported base64 image is left out). */
export function imageBlocks(text: string, images: ChatImage[]): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = text ? [{ type: 'text', text }] : [];
  for (const im of images) {
    const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/is.exec(im.dataUrl);
    const type = m?.[1]?.toLowerCase();
    if (!m || !type || !(IMAGE_TYPES as readonly string[]).includes(type)) continue;
    if (im.label) out.push({ type: 'text', text: im.label });
    out.push({ type: 'image', source: { type: 'base64', media_type: type as ImageType, data: m[2]! } });
  }
  return out;
}

const usageOf = (u: Anthropic.Usage): LlmUsage => ({
  ...zeroUsage(),
  inputTokens: u.input_tokens,
  outputTokens: u.output_tokens,
  cacheReadTokens: u.cache_read_input_tokens ?? 0,
  cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
});

/**
 * Agent turns -> Claude messages. System turns go to `system`; a run of tool results and user turns becomes ONE user message
 * (tool_result blocks first, as the API requires; the screenshots of `capture_frames` follow them as image blocks).
 */
export function toClaudeMessages(turns: ChatTurn[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system = turns.filter((t) => t.role === 'system').map((t) => t.content).join('\n\n');
  const messages: Anthropic.MessageParam[] = [];
  let pending: Anthropic.ContentBlockParam[] = [];
  const flush = () => {
    if (pending.length) messages.push({ role: 'user', content: pending });
    pending = [];
  };
  for (const t of turns) {
    if (t.role === 'system') continue;
    if (t.role === 'tool') {
      pending.push({ type: 'tool_result', tool_use_id: t.toolCallId ?? '', content: t.content || '（空）' });
    } else if (t.role === 'user') {
      pending.push(...imageBlocks(t.content || (t.images?.length ? '' : '（空）'), t.images ?? []));
    } else {
      flush();
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (t.content.trim()) blocks.push({ type: 'text', text: t.content });
      for (const c of t.toolCalls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(c.arguments || '{}'); } catch { /* the model wrote broken JSON: send an empty object, the tool_result carries the complaint */ }
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: input && typeof input === 'object' ? input : {} });
      }
      messages.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '（空）' }] });
    }
  }
  flush();
  return { system, messages };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  /** Output cap of one call (above 16000 the call streams, see STREAM_ABOVE). */
  readonly maxOutputTokens = 32768;
  private readonly client: Anthropic;
  private readonly effort: 'low' | 'medium' | 'high';
  private toolsRefused = false;

  constructor(private readonly opts: AnthropicOptions) {
    this.model = opts.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    this.effort = opts.effort ?? 'medium';
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      maxRetries: opts.maxRetries ?? 2,
      timeout: opts.timeoutMs ?? 10 * 60_000,
    });
  }

  /** Map SDK exceptions to the provider-layer taxonomy (keys redacted). */
  private fail(e: unknown): never {
    if (e instanceof LlmError) throw e;
    const msg = redact((e as Error).message ?? String(e), this.opts.apiKey);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new LlmError('auth', `API key 无效或无权限（HTTP ${e.status}）：${msg}`, { status: e.status });
    if (e instanceof Anthropic.RateLimitError) throw new LlmError('rate_limit', `请求过于频繁（429）：${msg}`, { status: 429 });
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new LlmError('timeout', '请求超时');
    if (e instanceof Anthropic.APIUserAbortError) throw new LlmError('aborted', '请求已取消');
    if (e instanceof Anthropic.APIConnectionError) throw new LlmError('network', `无法连接到 Anthropic 接口：${msg}`);
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.UnprocessableEntityError) throw new LlmError('bad_request', `请求被拒绝（HTTP ${e.status}）：${msg}`, { status: e.status });
    if (e instanceof Anthropic.APIError) throw new LlmError('server', `Anthropic 服务错误（HTTP ${e.status ?? '?'}）：${msg}`, e.status === undefined ? undefined : { status: e.status });
    throw new LlmError('network', msg);
  }

  private async send(params: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal): Promise<Anthropic.Message> {
    try {
      if (params.max_tokens > STREAM_ABOVE) {
        const stream = this.client.messages.stream({ ...params, stream: undefined } as Anthropic.MessageStreamParams, signal ? { signal } : undefined);
        return await stream.finalMessage();
      }
      return await this.client.messages.create(params, signal ? { signal } : undefined);
    } catch (e) {
      return this.fail(e);
    }
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<Omit<StructuredResult<T>, 'cached'>> {
    const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: req.system }];
    // The stable catalog goes last in `system` and carries the cache breakpoint: prefix caching covers tools + system up to here.
    if (req.cacheablePrefix) system.push({ type: 'text', text: req.cacheablePrefix, cache_control: { type: 'ephemeral' } });
    else system[0]!.cache_control = { type: 'ephemeral' };
    const msg = await this.send(
      {
        model: this.model,
        max_tokens: req.maxTokens,
        system,
        messages: [{ role: 'user', content: inputText(req.input) }],
        output_config: { effort: this.effort, format: { type: 'json_schema', schema: modelJsonSchema(req.schema) } },
      },
      req.signal,
    );
    const raw = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const usage = {
      ...zeroUsage(),
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
    if (msg.stop_reason === 'max_tokens') throw new TruncatedError(undefined, raw);
    if (msg.stop_reason === 'refusal') {
      const cat = msg.stop_details?.category;
      throw new LlmError('refusal', `模型拒绝了这次请求${cat ? `（类别：${cat}）` : ''}${msg.stop_details?.explanation ? `：${msg.stop_details.explanation}` : ''}`);
    }
    const data = validateOutput(req.schema, extractJson(raw), raw);
    return { data, usage, raw, warnings: [] };
  }

  /** Every Claude model takes pictures. */
  async imageInput(): Promise<boolean | null> {
    return true;
  }

  toolsSupported(): boolean {
    return !this.toolsRefused;
  }
  noteToolsUnsupported(): void {
    this.toolsRefused = true;
  }

  /** A plain multimodal request (no tools): the pictures and a question in, text out. */
  async describeImages(req: DescribeImagesRequest): Promise<{ text: string; usage: LlmUsage }> {
    const msg = await this.send(
      { model: this.model, max_tokens: Math.min(req.maxTokens, this.maxOutputTokens), messages: [{ role: 'user', content: imageBlocks(req.prompt, req.images) }] },
      req.signal,
    );
    return { text: msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''), usage: usageOf(msg.usage) };
  }

  /** One native tool-use round trip (`tool_choice` auto). A truncated reply (`max_tokens`) throws: a cut-off tool call must not be run. */
  async chatTools(req: ChatToolsRequest): Promise<ChatToolsResult> {
    const { system, messages } = toClaudeMessages(req.messages);
    const tools = req.tools.map((t, i): Anthropic.Tool => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', ...t.parameters } as Anthropic.Tool.InputSchema,
      // the tools + system prefix is stable across steps: one cache breakpoint at the end of the tools
      ...(i === req.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
    const msg = await this.send(
      {
        model: this.model,
        max_tokens: Math.min(req.maxTokens, this.maxOutputTokens),
        ...(system ? { system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }] } : {}),
        messages,
        tools,
        tool_choice: { type: 'auto' },
        output_config: { effort: this.effort },
      },
      req.signal,
    );
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (msg.stop_reason === 'max_tokens') throw new TruncatedError(undefined, text);
    if (msg.stop_reason === 'refusal') {
      const cat = msg.stop_details?.category;
      throw new LlmError('refusal', `模型拒绝了这次请求${cat ? `（类别：${cat}）` : ''}${msg.stop_details?.explanation ? `：${msg.stop_details.explanation}` : ''}`);
    }
    return {
      text,
      toolCalls: msg.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }] : [])),
      usage: usageOf(msg.usage),
      finish: msg.stop_reason ?? 'end_turn',
    };
  }

  async test(signal?: AbortSignal): Promise<TestResult> {
    const t0 = Date.now();
    const msg = await this.send({ model: this.model, max_tokens: 64, messages: [{ role: 'user', content: '只回复 OK' }], output_config: { effort: 'low' } }, signal);
    return { model: msg.model || this.model, latencyMs: Date.now() - t0 };
  }
}
