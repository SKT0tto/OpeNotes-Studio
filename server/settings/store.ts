import { createHash } from 'node:crypto';
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

/** Parses `KEY=value` lines (BOM, comments, quotes tolerated). A missing / unreadable file is an empty result. */
export function parseDotEnv(file: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2]!;
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** Reads a `.env` file into `env` without overriding variables that are already set (non-empty). */
export function loadDotEnv(file: string, env: Env = process.env): void {
  for (const [k, v] of Object.entries(parseDotEnv(file))) if (!nonEmpty(env[k])) env[k] = v;
}

/** A key that is empty or an obvious placeholder (`sk-ant-...`, `<your key>`) is not a key. */
export const isUsableKey = (k: string | null | undefined): k is string => {
  const t = k?.trim();
  if (!t) return false;
  if (/(\.{3}|\u2026)$/.test(t) || /^<.*>$/.test(t) || /^(your[-_ ]?(api[-_ ]?)?key|changeme|replace[-_ ]?me|xxx+)$/i.test(t)) return false;
  return !/\s/.test(t);
};

const isLocalUrl = (url: string) => /^https?:\/\/(localhost|127\.|\[::1\]|192\.168\.|10\.)/i.test(url.trim());

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
  /**
   * Re-read on every request: edits to `.env` apply without a restart. `base` is the process environment as it was
   * before `.env` was loaded (real variables win over `.env`; the panel wins over both).
   */
  dotEnv?: { file: string; base: Env } | undefined;
}

/** Outcome of the last real call (connection test or generation) for the current configuration. */
interface LastOutcome { fingerprint: string; ok: boolean; message: string; at: number }

/**
 * LLM settings: `data/settings.local.json` (gitignored, plaintext key, never leaves the server) layered over environment
 * variables / `.env`. A value saved in the panel wins over the environment, which only provides the defaults.
 */
export class LlmSettings {
  private last: LastOutcome | null = null;
  constructor(private readonly deps: SettingsDeps) {}

  /** The environment as it is right now: real variables, then whatever `.env` says today for the rest. */
  private env(): Env {
    const d = this.deps.dotEnv;
    if (!d) return this.deps.env;
    const out: Env = { ...d.base };
    for (const [k, v] of Object.entries(parseDotEnv(d.file))) if (!nonEmpty(out[k])) out[k] = v;
    return out;
  }

  private fingerprint(): string {
    const e = this.effective();
    const p = e.provider === 'openai' ? e.openai : e.provider === 'anthropic' ? e.anthropic : null;
    return JSON.stringify([e.provider, p?.model, p?.baseUrl, p?.apiKey ? createHash('sha256').update(p.apiKey).digest('hex').slice(0, 16) : '']);
  }

  /** Remember how the last real call went, so the panel can say "verified" / "failed" instead of only "a key exists". */
  noteResult(ok: boolean, message = ''): void {
    this.last = { fingerprint: this.fingerprint(), ok, message, at: Date.now() };
  }

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
    const e = this.env();
    const usable = (v: string | undefined | null) => (isUsableKey(v) ? v.trim() : undefined);
    const aKey = usable(f.anthropic.apiKey) ?? usable(e.ANTHROPIC_API_KEY);
    const oKey = usable(f.openai.apiKey) ?? usable(e.OPENAI_API_KEY);
    const oBase = nonEmpty(f.openai.baseUrl) ?? nonEmpty(e.OPENAI_BASE_URL) ?? '';
    let provider: LlmProviderId | null = f.provider ?? (nonEmpty(e.LLM_PROVIDER) as LlmProviderId | undefined) ?? null;
    if (provider === 'fixture' && !this.deps.fixtureProvider) provider = null;
    if (!provider) provider = aKey ? 'anthropic' : oBase ? 'openai' : this.deps.fixtureProvider ? 'fixture' : null;
    return {
      provider,
      anthropic: {
        apiKey: aKey, keySource: usable(f.anthropic.apiKey) ? 'file' : aKey ? 'env' : null,
        model: nonEmpty(f.anthropic.model) ?? DEFAULT_ANTHROPIC_MODEL, baseUrl: nonEmpty(f.anthropic.baseUrl) ?? '',
      },
      openai: {
        apiKey: oKey, keySource: usable(f.openai.apiKey) ? 'file' : oKey ? 'env' : null,
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
      if (!eff.openai.apiKey && !isLocalUrl(eff.openai.baseUrl)) return { provider: null, message: '未配置 AI：该 OpenAI 兼容接口（非本机地址）需要 API key，请在设置中填写（或设置 OPENAI_API_KEY）；本机服务（LM Studio 等）无需 key' };
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
      status: p.provider ? this.configuredStatus(eff.provider, model, p.provider) : { configured: false, provider: eff.provider, model, verified: 'none' as const, message: p.message },
    };
  }

  private configuredStatus(provider: LlmProviderId | null, model: string | null, p: LlmProvider): PublicLlmSettings['status'] {
    if (provider === 'fixture') return { configured: true, provider, model, verified: 'none', message: '测试用录制回放（非真实 AI）' };
    const name = `${p.id === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${p.model}`;
    const l = this.last && this.last.fingerprint === this.fingerprint() ? this.last : null;
    if (l?.ok) return { configured: true, provider, model, verified: 'ok', message: `已配置并验证：${name}`, testedAt: l.at };
    if (l) return { configured: true, provider, model, verified: 'failed', message: `已填写配置，但最近一次调用失败（${l.message}）：${name}。请检查 API key / 地址后点「测试连接」`, testedAt: l.at };
    return { configured: true, provider, model, verified: 'untested', message: `已填写配置，尚未验证：${name}（点「测试连接」确认 key 可用）` };
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
