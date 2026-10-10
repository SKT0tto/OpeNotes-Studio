import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ANTHROPIC_MODEL, LlmSettingsPatchSchema, NOT_CONFIGURED_MESSAGE, StoredLlmSettingsSchema, maskKey,
  type LlmProviderId, type LlmSettingsPatch, type PublicKeyInfo, type PublicLlmSettings, type StoredLlmSettings,
} from '../../shared/schema/settings';
import { AnthropicProvider } from '../llm/anthropic';
import { OpenAiCompatProvider } from '../llm/openaiCompat';
import type { LlmProvider } from '../llm/provider';

type Env = Record<string, string | undefined>;
const nonEmpty = (v: string | undefined | null): string | undefined => (v && v.trim() !== '' ? v.trim() : undefined);

/** Reads `KEY=value` lines (BOM, comments, quotes tolerated) into `env` without overriding variables that are already set. */
export function loadDotEnv(file: string, env: Env = process.env): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2]!;
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    if (env[m[1]!] === undefined) env[m[1]!] = v;
  }
}

export interface Effective {
  provider: LlmProviderId | null;
  anthropic: { apiKey?: string | undefined; keySource: 'env' | 'file' | null; model: string; baseUrl: string };
  openai: { apiKey?: string | undefined; keySource: 'env' | 'file' | null; model: string; baseUrl: string };
}

export interface SettingsDeps {
  file: string;
  env: Env;
  /** Registers the recorded-response `fixture` provider (NODE_ENV=test only). */
  fixtureProvider?: (() => LlmProvider) | undefined;
  fetch?: typeof fetch;
}

/**
 * LLM settings: `data/settings.local.json` (gitignored, plaintext key, never leaves the server) layered over environment
 * variables / `.env`. A value saved in the panel wins over the environment, which only provides the defaults.
 */
export class LlmSettings {
  constructor(private readonly deps: SettingsDeps) {}

  read(): StoredLlmSettings {
    try {
      return StoredLlmSettingsSchema.parse(JSON.parse(fs.readFileSync(this.deps.file, 'utf8')));
    } catch {
      return StoredLlmSettingsSchema.parse({});
    }
  }

  private write(s: StoredLlmSettings): void {
    fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
    const tmp = `${this.deps.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.deps.file);
  }

  effective(): Effective {
    const f = this.read();
    const e = this.deps.env;
    const aKey = nonEmpty(f.anthropic.apiKey) ?? nonEmpty(e.ANTHROPIC_API_KEY);
    const oKey = nonEmpty(f.openai.apiKey) ?? nonEmpty(e.OPENAI_API_KEY);
    const oBase = nonEmpty(f.openai.baseUrl) ?? nonEmpty(e.OPENAI_BASE_URL) ?? '';
    let provider: LlmProviderId | null = f.provider ?? (nonEmpty(e.LLM_PROVIDER) as LlmProviderId | undefined) ?? null;
    if (provider === 'fixture' && !this.deps.fixtureProvider) provider = null;
    if (!provider) provider = aKey ? 'anthropic' : oBase ? 'openai' : this.deps.fixtureProvider ? 'fixture' : null;
    return {
      provider,
      anthropic: {
        apiKey: aKey, keySource: nonEmpty(f.anthropic.apiKey) ? 'file' : aKey ? 'env' : null,
        model: nonEmpty(f.anthropic.model) ?? DEFAULT_ANTHROPIC_MODEL, baseUrl: nonEmpty(f.anthropic.baseUrl) ?? '',
      },
      openai: {
        apiKey: oKey, keySource: nonEmpty(f.openai.apiKey) ? 'file' : oKey ? 'env' : null,
        model: nonEmpty(f.openai.model) ?? nonEmpty(e.OPENAI_MODEL) ?? '', baseUrl: oBase,
      },
    };
  }

  /** The provider to call, or null with the reason why there is none. */
  provider(): { provider: LlmProvider } | { provider: null; message: string } {
    const eff = this.effective();
    if (eff.provider === 'fixture' && this.deps.fixtureProvider) return { provider: this.deps.fixtureProvider() };
    if (eff.provider === 'anthropic') {
      if (!eff.anthropic.apiKey) return { provider: null, message: '未配置 AI：Anthropic 缺少 API key（请在设置中填写，或设置环境变量 ANTHROPIC_API_KEY）；也可使用『规则生成（非 AI）』' };
      return { provider: new AnthropicProvider({ apiKey: eff.anthropic.apiKey, model: eff.anthropic.model, baseUrl: eff.anthropic.baseUrl || undefined, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }) };
    }
    if (eff.provider === 'openai') {
      if (!eff.openai.baseUrl) return { provider: null, message: '未配置 AI：OpenAI 兼容接口还没有填写地址（例如 LM Studio：http://localhost:1234/v1）；也可使用『规则生成（非 AI）』' };
      if (!eff.openai.model) return { provider: null, message: '未配置 AI：OpenAI 兼容接口还没有填写模型名' };
      return { provider: new OpenAiCompatProvider({ baseUrl: eff.openai.baseUrl, apiKey: eff.openai.apiKey, model: eff.openai.model, timeoutMs: 300_000, ...(/deepseek/i.test(eff.openai.baseUrl) ? { mode: 'json_object' as const } : {}), ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }) };
    }
    return { provider: null, message: NOT_CONFIGURED_MESSAGE };
  }

  view(): PublicLlmSettings {
    const eff = this.effective();
    const info = (k: string | undefined, source: 'env' | 'file' | null): PublicKeyInfo => ({ hasKey: !!k, mask: k ? maskKey(k) : null, source });
    const p = this.provider();
    const model = eff.provider === 'anthropic' ? eff.anthropic.model : eff.provider === 'openai' ? eff.openai.model : eff.provider === 'fixture' ? 'fixture' : null;
    return {
      provider: eff.provider,
      available: this.deps.fixtureProvider ? ['anthropic', 'openai', 'fixture'] : ['anthropic', 'openai'],
      anthropic: { ...info(eff.anthropic.apiKey, eff.anthropic.keySource), model: eff.anthropic.model, baseUrl: eff.anthropic.baseUrl },
      openai: { ...info(eff.openai.apiKey, eff.openai.keySource), model: eff.openai.model, baseUrl: eff.openai.baseUrl },
      status: p.provider
        ? { configured: true, provider: eff.provider, model, message: eff.provider === 'fixture' ? '测试用录制回放（非真实 AI）' : `已配置：${p.provider.id === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${p.provider.model}` }
        : { configured: false, provider: eff.provider, model, message: p.message },
    };
  }

  patch(raw: unknown): PublicLlmSettings {
    const patch: LlmSettingsPatch = LlmSettingsPatchSchema.parse(raw);
    const cur = this.read();
    const next: StoredLlmSettings = { ...cur, anthropic: { ...cur.anthropic }, openai: { ...cur.openai } };
    if (patch.provider) next.provider = patch.provider;
    const apply = (dst: Record<string, string | undefined>, src: Record<string, string | null | undefined> | undefined) => {
      for (const [k, v] of Object.entries(src ?? {})) {
        if (v === undefined) continue;
        const t = v === null ? '' : v.trim();
        if (t === '') delete dst[k];
        else dst[k] = t;
      }
    };
    apply(next.anthropic, patch.anthropic);
    apply(next.openai, patch.openai);
    this.write(next);
    return this.view();
  }
}
