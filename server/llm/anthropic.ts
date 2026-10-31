import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_ANTHROPIC_MODEL } from '../../shared/schema/settings';
import {
  LlmError, TruncatedError, extractJson, inputText, modelJsonSchema, redact, validateOutput, zeroUsage,
  type LlmProvider, type StructuredRequest, type StructuredResult, type TestResult,
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

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  /** Output cap of one call (above 16000 the call streams, see STREAM_ABOVE). */
  readonly maxOutputTokens = 32768;
  private readonly client: Anthropic;
  private readonly effort: 'low' | 'medium' | 'high';

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

  async test(signal?: AbortSignal): Promise<TestResult> {
    const t0 = Date.now();
    const msg = await this.send({ model: this.model, max_tokens: 64, messages: [{ role: 'user', content: '只回复 OK' }], output_config: { effort: 'low' } }, signal);
    return { model: msg.model || this.model, latencyMs: Date.now() - t0 };
  }
}
