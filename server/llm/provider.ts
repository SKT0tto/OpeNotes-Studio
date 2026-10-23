import { z } from 'zod';

export type LlmErrorKind =
  | 'not_configured' | 'auth' | 'rate_limit' | 'network' | 'timeout' | 'bad_request' | 'server'
  | 'truncated' | 'refusal' | 'invalid_output' | 'aborted';

/** Every failure of the provider layer. `message` is safe to show (keys are redacted before an error is built). */
export class LlmError extends Error {
  constructor(public readonly kind: LlmErrorKind, message: string, public readonly detail?: { raw?: string; issues?: string[]; status?: number }) {
    super(message);
    this.name = 'LlmError';
  }
}
export class TruncatedError extends LlmError {
  constructor(message = '模型输出被截断（达到 max_tokens）', raw?: string) {
    super('truncated', message, raw === undefined ? undefined : { raw });
    this.name = 'TruncatedError';
  }
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}
export const zeroUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });

export interface StructuredRequest<T> {
  system: string;
  /** Large stable text (catalog digest): sent after `system`, marked cacheable where the provider supports it. */
  cacheablePrefix?: string | undefined;
  /** Per-call input: a string, or JSON-able data (serialised with sorted keys). */
  input: unknown;
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens: number;
  signal?: AbortSignal | undefined;
}

export interface StructuredResult<T> {
  data: T;
  usage: LlmUsage;
  cached: boolean;
  raw: string;
  warnings: string[];
}

export interface TestResult {
  model: string;
  latencyMs: number;
}

/** A tool the model may call: `parameters` is a JSON Schema (from `modelJsonSchema`). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  /** The arguments exactly as the model wrote them (a JSON string); parsing / validation is the caller's job. */
  arguments: string;
}
export interface ChatTurn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Thinking models: the reasoning of the assistant turn, passed back unchanged inside one tool loop. */
  reasoning?: string;
  /** User turns only: pictures sent with the text (multimodal models). */
  images?: ChatImage[];
}
/** A picture for a multimodal model: a `data:image/(png|jpeg|webp);base64,...` URL and a short label that is sent as text before it. */
export interface ChatImage {
  dataUrl: string;
  label?: string | undefined;
}
export interface DescribeImagesRequest {
  /** What to look at / answer (the agent's question). */
  prompt: string;
  images: ChatImage[];
  maxTokens: number;
  signal?: AbortSignal | undefined;
}
export interface ChatToolsRequest {
  messages: ChatTurn[];
  tools: ToolSpec[];
  maxTokens: number;
  signal?: AbortSignal | undefined;
}
export interface ChatToolsResult {
  text: string;
  toolCalls: ToolCall[];
  reasoning?: string | undefined;
  usage: LlmUsage;
  finish: string;
}

export interface LlmProvider {
  readonly id: 'anthropic' | 'openai' | 'fixture' | 'rule';
  readonly model: string;
  /** Largest `max_tokens` the backend accepts (the director splits long scenes to stay below it). */
  readonly maxOutputTokens?: number;
  generateStructured<T>(req: StructuredRequest<T>): Promise<Omit<StructuredResult<T>, 'cached'>>;
  /** Function calling (optional). `toolsSupported()` is false once the endpoint refused tools; the agent then uses the JSON action protocol. */
  chatTools?(req: ChatToolsRequest): Promise<ChatToolsResult>;
  toolsSupported?(): boolean;
  noteToolsUnsupported?(): void;
  /** Whether the model takes pictures: true / false when known (the endpoint lists the model's input modalities), null when it cannot be told. */
  imageInput?(signal?: AbortSignal): Promise<boolean | null>;
  /** One plain multimodal request: the pictures and a question in, text out (a separate vision model that reports to a text-only agent). */
  describeImages?(req: DescribeImagesRequest): Promise<{ text: string; usage: LlmUsage }>;
  test(signal?: AbortSignal): Promise<TestResult>;
}

/** JSON with sorted keys: the canonical form used for cache keys and prompts. */
export function stableStringify(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, norm(val)]),
      );
    }
    return x;
  };
  return JSON.stringify(norm(v));
}
export const inputText = (input: unknown): string => (typeof input === 'string' ? input : stableStringify(input));

/**
 * JSON Schema for the model: zod's output minus keywords that structured-output backends reject (bounds, patterns,
 * formats, defaults). The real validation is done with zod after the call, so nothing is lost.
 */
export function modelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const drop = new Set(['$schema', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'format', 'default', 'minItems', 'maxItems', 'multipleOf', 'uniqueItems', 'examples', 'title']);
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (!drop.has(k)) o[k] = walk(v);
      if (o.type === 'object' && o.properties) o.additionalProperties = false;
      return o;
    }
    return x;
  };
  return walk(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })) as Record<string, unknown>;
}

/** Replace every occurrence of a secret in a message. */
export const redact = (text: string, ...secrets: Array<string | undefined>): string =>
  secrets.reduce<string>((t, s) => (s && s.length >= 6 ? t.split(s).join('***') : t), text);

/** Parse model text into JSON: plain, fenced, or the first balanced {...} / [...] block. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const tries: string[] = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) tries.push(fence[1]!.trim());
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const open = t[start]!;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i]!;
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) {
        tries.push(t.slice(start, i + 1));
        break;
      }
    }
  }
  for (const s of tries) {
    try {
      return JSON.parse(s);
    } catch {
      /* next */
    }
  }
  throw new LlmError('invalid_output', '模型输出不是合法 JSON', { raw: t.slice(0, 4000) });
}

/** zod-validate parsed model output; failures become `invalid_output` carrying the issue list (for the repair call). */
export function validateOutput<T>(schema: z.ZodType<T>, value: unknown, raw: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 40).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new LlmError('invalid_output', `模型输出不符合 schema：${issues.slice(0, 3).join('；')}`, { raw: raw.slice(0, 8000), issues });
}

/** Decisions of these providers are labelled `rule`, never `ai`. */
export const isModelAi = (p: Pick<LlmProvider, 'id'>): boolean => p.id === 'anthropic' || p.id === 'openai';
