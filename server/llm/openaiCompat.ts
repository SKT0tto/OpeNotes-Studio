import {
  LlmError, TruncatedError, extractJson, inputText, modelJsonSchema, redact, stableStringify, validateOutput, zeroUsage,
  type ChatImage, type ChatToolsRequest, type ChatToolsResult, type DescribeImagesRequest, type LlmProvider, type LlmUsage, type StructuredRequest, type StructuredResult, type TestResult,
} from './provider';

/** Default output cap of one call (thinking tokens count against it too). */
export const DEFAULT_MAX_TOKENS = 32768;

export interface OpenAiCompatOptions {
  baseUrl: string;
  /** Optional: LM Studio and other local servers need none. */
  apiKey?: string | undefined;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  /** Upper bound for `max_tokens` (default 32768). */
  maxTokensCap?: number;
  /** Injected in tests so retries do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Structured-output mode to start from (default json_schema; degrades json_schema -> json_object -> text and remembers what worked). */
  mode?: Mode;
  /**
   * Where "this service does not accept strict json_schema" is remembered across provider instances (a provider is built per request).
   * Default: one process-wide memory; tests pass their own. `false` = no memory.
   */
  modeMemory?: Map<string, RememberedMode> | false;
  /** Where "this endpoint refused function calling" is remembered (key = base|model|tools -> time). Default: process-wide; `false` = no memory. */
  toolsMemory?: Map<string, number> | false;
  now?: () => number;
}

type Mode = 'json_schema' | 'json_object' | 'text';
const MODES: Mode[] = ['json_schema', 'json_object', 'text'];

export interface RememberedMode { mode: Mode; at: number }
/** How long a service is believed not to support strict json_schema before it is tried again (a service may add it). */
export const MODE_MEMORY_MS = 6 * 60 * 60 * 1000;
const sharedModeMemory = new Map<string, RememberedMode>();
const sharedToolsMemory = new Map<string, number>();
/** Forget which endpoints refused function calling (all, or one base URL). */
export function forgetToolsSupport(baseUrl?: string, memory: Map<string, number> = sharedToolsMemory): void {
  if (baseUrl === undefined) return void memory.clear();
  const prefix = `${baseUrl.trim().replace(/\/+$/, '')}|`;
  for (const k of [...memory.keys()]) if (k.startsWith(prefix)) memory.delete(k);
}
const modeKey = (baseUrl: string, model: string) => `${baseUrl.trim().replace(/\/+$/, '')}|${model}`;
/** Forget what was learned about services (all of them, or one base URL): call it when the endpoint / model setting changes. */
export function forgetStructuredModes(baseUrl?: string, memory: Map<string, RememberedMode> = sharedModeMemory): void {
  if (baseUrl === undefined) return void memory.clear();
  const prefix = `${baseUrl.trim().replace(/\/+$/, '')}|`;
  for (const k of [...memory.keys()]) if (k.startsWith(prefix)) memory.delete(k);
}

/** Whether a base|model takes pictures (null = the endpoint does not say). */
const imageMemory = new Map<string, boolean | null>();
/** OpenAI content parts: the text, then each picture preceded by its label. */
export function imageContent(text: string, images: ChatImage[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text }];
  for (const im of images) {
    if (im.label) parts.push({ type: 'text', text: im.label });
    parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
  }
  return parts;
}

interface ChatResponse {
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  model?: string;
  error?: { message?: string };
}

class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`HTTP ${status}`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** OpenAI-compatible `/chat/completions` client: OpenAI, DeepSeek, LM Studio, vLLM, Ollama's /v1 ... */
export class OpenAiCompatProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly model: string;
  readonly maxOutputTokens: number;
  private mode: Mode | null;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.model = opts.model;
    this.maxOutputTokens = opts.maxTokensCap ?? DEFAULT_MAX_TOKENS;
    this.base = opts.baseUrl.trim().replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.memory = opts.modeMemory === false ? null : opts.modeMemory ?? sharedModeMemory;
    this.mode = opts.mode ?? this.remembered() ?? null;
  }

  private readonly memory: Map<string, RememberedMode> | null;
  private get toolsMemory(): Map<string, number> | null {
    return this.opts.toolsMemory === false ? null : this.opts.toolsMemory ?? sharedToolsMemory;
  }
  private toolsKey(): string {
    return `${this.memoryKey()}|tools`;
  }
  /** False when this endpoint (or an earlier provider instance for it) refused function calling and the belief is still fresh. */
  toolsSupported(): boolean {
    const at = this.toolsMemory?.get(this.toolsKey());
    if (at === undefined) return true;
    if ((this.opts.now ?? Date.now)() - at > MODE_MEMORY_MS) {
      this.toolsMemory!.delete(this.toolsKey());
      return true;
    }
    return false;
  }
  noteToolsUnsupported(): void {
    this.toolsMemory?.set(this.toolsKey(), (this.opts.now ?? Date.now)());
  }

  /**
   * One function-calling round trip. `tool_choice` is always `auto` (a thinking model such as deepseek-flash answers 400 to `required`).
   * Retries, timeout and key redaction are those of `post()`. A 400 means "tools not supported here": the caller falls back.
   */
  async chatTools(req: ChatToolsRequest): Promise<ChatToolsResult> {
    const body = {
      model: this.model,
      max_tokens: Math.min(req.maxTokens, this.opts.maxTokensCap ?? DEFAULT_MAX_TOKENS),
      messages: req.messages.map((m) => {
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        if (m.role === 'assistant') {
          return {
            role: 'assistant', content: m.content || null,
            ...(m.reasoning ? { reasoning_content: m.reasoning } : {}),
            ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
          };
        }
        return { role: m.role, content: m.role === 'user' && m.images?.length ? imageContent(m.content, m.images) : m.content };
      }),
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: 'auto',
    };
    const res = await this.post(body, req.signal);
    const choice = res.choices?.[0];
    if (!choice?.message) throw new LlmError('invalid_output', '接口返回里没有 message');
    const u = res.usage ?? {};
    if (choice.message.refusal) throw new LlmError('refusal', `模型拒绝了这次请求：${choice.message.refusal}`);
    if (choice.finish_reason === 'content_filter') throw new LlmError('refusal', '输出被内容过滤器拦截');
    return {
      text: choice.message.content ?? '',
      toolCalls: (choice.message.tool_calls ?? []).flatMap((c, i) => (c.function?.name ? [{ id: c.id || `call_${i}`, name: c.function.name, arguments: c.function.arguments ?? '{}' }] : [])),
      ...(choice.message.reasoning_content ? { reasoning: choice.message.reasoning_content } : {}),
      usage: { ...zeroUsage(), inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, cacheReadTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0 },
      finish: choice.finish_reason ?? 'stop',
    };
  }
  /** Asks the endpoint's model list once per base|model (OpenAI-style `input_modalities` / `modalities`, as DeepSeek and OpenRouter report it). */
  async imageInput(signal?: AbortSignal): Promise<boolean | null> {
    const k = this.memoryKey();
    if (imageMemory.has(k)) return imageMemory.get(k)!;
    let answer: boolean | null = null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      signal?.addEventListener('abort', () => ctl.abort());
      const res = await this.doFetch(`${this.base}/models`, { headers: this.headers(), signal: ctl.signal }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const j = (await res.json()) as { data?: Array<{ id?: string; input_modalities?: string[]; modalities?: string[]; architecture?: { input_modalities?: string[] } }> };
        const m = j.data?.find((x) => x.id === this.model);
        const mods = m?.input_modalities ?? m?.architecture?.input_modalities ?? m?.modalities;
        answer = Array.isArray(mods) ? mods.includes('image') : null;
      }
    } catch {
      answer = null;
    }
    imageMemory.set(k, answer);
    return answer;
  }

  /** A plain multimodal request (no tools): the separate vision model of the assistant. */
  async describeImages(req: DescribeImagesRequest): Promise<{ text: string; usage: LlmUsage }> {
    const res = await this.post({ model: this.model, max_tokens: Math.min(req.maxTokens, this.opts.maxTokensCap ?? DEFAULT_MAX_TOKENS), messages: [{ role: 'user', content: imageContent(req.prompt, req.images) }] }, req.signal);
    const choice = res.choices?.[0];
    const u = res.usage ?? {};
    return { text: choice?.message?.content ?? '', usage: { ...zeroUsage(), inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, cacheReadTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0 } };
  }

  private memoryKey(): string {
    return modeKey(this.base, this.model);
  }
  /** The weaker mode this service needed the last time, if it is still believed. */
  private remembered(): Mode | null {
    const e = this.memory?.get(this.memoryKey());
    if (!e) return null;
    if ((this.opts.now ?? Date.now)() - e.at > MODE_MEMORY_MS) {
      this.memory!.delete(this.memoryKey());
      return null;
    }
    return e.mode;
  }

  /** Mode actually in use (null until the first call succeeded). */
  get structuredMode(): Mode | null {
    return this.mode;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  private explain(e: unknown): LlmError {
    if (e instanceof LlmError) return e;
    const key = this.opts.apiKey;
    if (e instanceof HttpError) {
      const body = redact(e.body.slice(0, 400), key);
      if (e.status === 401 || e.status === 403) return new LlmError('auth', `API key 无效或无权限（HTTP ${e.status}）：${body}`, { status: e.status });
      if (e.status === 429) return new LlmError('rate_limit', `请求过于频繁（HTTP 429）：${body}`, { status: 429 });
      if (e.status >= 500) return new LlmError('server', `服务端错误（HTTP ${e.status}）：${body}`, { status: e.status });
      return new LlmError('bad_request', `请求被拒绝（HTTP ${e.status}）：${body}`, { status: e.status });
    }
    const err = e as Error & { cause?: { code?: string; message?: string }; name?: string };
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return new LlmError('timeout', `请求超时（${Math.round((this.opts.timeoutMs ?? 120_000) / 1000)} 秒无响应）`);
    const code = err.cause?.code;
    const why =
      code === 'ECONNREFUSED' ? '连接被拒绝，服务没有在该地址运行（LM Studio 需要在「Developer」里启动本地服务器）'
        : code === 'ENOTFOUND' ? '域名无法解析' : code === 'ETIMEDOUT' ? '连接超时' : redact(err.cause?.message ?? err.message ?? String(e), key);
    return new LlmError('network', `无法连接到 ${this.base}：${why}`);
  }

  /** One HTTP round trip with timeout; retries 429 / 5xx / network failures with backoff. */
  private async post(body: unknown, signal?: AbortSignal): Promise<ChatResponse> {
    const retries = this.opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 120_000);
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort);
      try {
        const res = await this.doFetch(`${this.base}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ctl.signal });
        const text = await res.text();
        if (!res.ok) throw new HttpError(res.status, text);
        try {
          return JSON.parse(text) as ChatResponse;
        } catch {
          throw new LlmError('invalid_output', `接口返回的不是 JSON：${redact(text.slice(0, 200), this.opts.apiKey)}`);
        }
      } catch (e) {
        if (signal?.aborted) throw new LlmError('aborted', '请求已取消');
        const retryable = e instanceof HttpError ? e.status === 429 || e.status >= 500 : !(e instanceof LlmError);
        const timedOut = (e as Error).name === 'AbortError';
        if (retryable && !timedOut && attempt < retries) {
          await this.sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        throw this.explain(e);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  private build<T>(req: StructuredRequest<T>, mode: Mode): unknown {
    const schema = modelJsonSchema(req.schema);
    let system = [req.system, req.cacheablePrefix].filter(Boolean).join('\n\n');
    // json_object / text modes cannot carry the schema, so it goes into the prompt (and the word "JSON" must appear for json_object).
    if (mode !== 'json_schema') system += `\n\n只输出一个 JSON 对象，不要任何解释或 Markdown。它必须符合下面的 JSON Schema：\n${stableStringify(schema)}`;
    return {
      model: this.model,
      max_tokens: Math.min(req.maxTokens, this.opts.maxTokensCap ?? DEFAULT_MAX_TOKENS),
      messages: [{ role: 'system', content: system }, { role: 'user', content: inputText(req.input) }],
      ...(mode === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema } } } : {}),
      ...(mode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
    };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<Omit<StructuredResult<T>, 'cached'>> {
    const warnings: string[] = [];
    const order = this.mode ? MODES.slice(MODES.indexOf(this.mode)) : MODES;
    let res: ChatResponse | null = null;
    let used: Mode = order[0]!;
    let lastErr: LlmError | null = null;
    for (const mode of order) {
      try {
        res = await this.post(this.build(req, mode), req.signal);
        used = mode;
        break;
      } catch (e) {
        lastErr = e as LlmError;
        // only a 400 means "this response_format is not supported here": try the next, weaker mode
        if (!(e instanceof LlmError) || e.kind !== 'bad_request' || mode === 'text') throw e;
        warnings.push(`结构化输出模式 ${mode} 不被支持，降级`);
      }
    }
    if (!res) throw lastErr ?? new LlmError('network', '没有响应');
    this.mode = used;
    // a service that refused strict json_schema is not asked again (by this or a later provider instance); one that took it is forgotten
    if (this.memory) {
      if (used === 'json_schema') this.memory.delete(this.memoryKey());
      else this.memory.set(this.memoryKey(), { mode: used, at: (this.opts.now ?? Date.now)() });
    }
    const choice = res.choices?.[0];
    const raw = choice?.message?.content ?? '';
    const u = res.usage ?? {};
    const usage = {
      ...zeroUsage(),
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    };
    if (choice?.message?.refusal) throw new LlmError('refusal', `模型拒绝了这次请求：${choice.message.refusal}`);
    if (choice?.finish_reason === 'length') throw new TruncatedError(undefined, raw);
    if (choice?.finish_reason === 'content_filter') throw new LlmError('refusal', '输出被内容过滤器拦截');
    if (!raw.trim()) throw new LlmError('invalid_output', '模型返回了空内容');
    const data = validateOutput(req.schema, extractJson(raw), raw);
    return { data, usage, raw, warnings };
  }

  async test(signal?: AbortSignal): Promise<TestResult> {
    const t0 = Date.now();
    const res = await this.post({ model: this.model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }, signal);
    if (!res.choices?.length) throw new LlmError('invalid_output', '接口有响应，但不是 chat/completions 格式（请确认地址以 /v1 结尾或是 OpenAI 兼容地址）');
    return { model: res.model || this.model, latencyMs: Date.now() - t0 };
  }
}
