import { z } from 'zod';

export const LLM_PROVIDERS = ['anthropic', 'openai', 'fixture'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/** What the settings file stores (server side only; contains plaintext keys). */
export const StoredLlmSettingsSchema = z.object({
  provider: z.enum(LLM_PROVIDERS).optional(),
  anthropic: z.object({ apiKey: z.string().optional(), model: z.string().optional(), baseUrl: z.string().optional() }).default({}),
  openai: z.object({ baseUrl: z.string().optional(), apiKey: z.string().optional(), model: z.string().optional() }).default({}),
});
export type StoredLlmSettings = z.infer<typeof StoredLlmSettingsSchema>;

/** What a client may send to change settings. `apiKey: ''` or `null` clears the stored key; absent keeps it. */
export const LlmSettingsPatchSchema = z.object({
  provider: z.enum(LLM_PROVIDERS).optional(),
  anthropic: z.object({ apiKey: z.string().nullable().optional(), model: z.string().optional(), baseUrl: z.string().optional() }).optional(),
  openai: z.object({ baseUrl: z.string().optional(), apiKey: z.string().nullable().optional(), model: z.string().optional() }).optional(),
});
export type LlmSettingsPatch = z.infer<typeof LlmSettingsPatchSchema>;

export interface PublicKeyInfo {
  hasKey: boolean;
  /** e.g. `sk-…087b`; never the key. */
  mask: string | null;
  source: 'env' | 'file' | null;
}

/** What the server returns: no plaintext key anywhere. */
export interface PublicLlmSettings {
  provider: LlmProviderId | null;
  /** Providers the UI may offer (`fixture` only when the server runs in test mode). */
  available: LlmProviderId[];
  anthropic: PublicKeyInfo & { model: string; baseUrl: string };
  openai: PublicKeyInfo & { model: string; baseUrl: string };
  status: {
    /** A usable key / address is present (not whether the provider accepts it). */
    configured: boolean;
    provider: LlmProviderId | null;
    model: string | null;
    /** Result of the last real call with this exact configuration: `ok` / `failed`, `untested` when none yet, `none` when not applicable. */
    verified: 'ok' | 'failed' | 'untested' | 'none';
    message: string;
    testedAt?: number;
  };
}

export const NOT_CONFIGURED_MESSAGE = '未配置 AI：请在设置中填写 ANTHROPIC_API_KEY 或 OpenAI 兼容地址；也可使用『规则生成（非 AI）』';

export function maskKey(key: string): string {
  const k = key.trim();
  return k.length <= 8 ? '…' : `${k.slice(0, 3)}…${k.slice(-4)}`;
}
