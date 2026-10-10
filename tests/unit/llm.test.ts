import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../server/app';
import { resolveConfig } from '../../server/config';
import { AnthropicProvider } from '../../server/llm/anthropic';
import { LlmCache, generateCached } from '../../server/llm/cache';
import { OpenAiCompatProvider } from '../../server/llm/openaiCompat';
import { LlmError, TruncatedError, extractJson, modelJsonSchema, stableStringify, type LlmProvider } from '../../server/llm/provider';
import { LlmSettings, loadDotEnv } from '../../server/settings/store';

const KEY = 'sk-test-SECRET-1234567890abcd';
const Out = z.object({ title: z.string(), n: z.number().int().min(0) });
const req = (extra: Record<string, unknown> = {}) => ({ system: 'sys', input: { b: 1, a: 2 }, schema: Out, schemaName: 'Out', maxTokens: 500, ...extra });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chat = (content: string, extra: Record<string, unknown> = {}) =>
  json({ model: 'm', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, ...extra });

describe('helpers', () => {
  it('stableStringify sorts keys deeply', () => {
    expect(stableStringify({ b: [{ z: 1, y: 2 }], a: 1 })).toBe('{"a":1,"b":[{"y":2,"z":1}]}');
  });
  it('extractJson handles fences and surrounding prose', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('好的，结果如下：{"a":{"b":"}"}} 完毕')).toEqual({ a: { b: '}' } });
    expect(() => extractJson('no json here')).toThrow(LlmError);
  });
  it('modelJsonSchema drops bounds and closes objects', () => {
    const s = JSON.stringify(modelJsonSchema(Out));
    expect(s).not.toContain('minimum');
    expect(s).toContain('"additionalProperties":false');
  });
});

describe('OpenAI-compatible provider (mock fetch)', () => {
  const make = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
    new OpenAiCompatProvider({ baseUrl: 'http://localhost:1234/v1/', apiKey: KEY, model: 'm', fetch: fetchImpl, sleep: async () => {}, ...over });

  it('uses json_schema first and parses the structured result', async () => {
    const f = vi.fn(async () => chat('{"title":"x","n":3}'));
    const p = make(f as unknown as typeof fetch);
    const r = await p.generateStructured(req());
    expect(r.data).toEqual({ title: 'x', n: 3 });
    expect(r.usage.inputTokens).toBe(10);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:1234/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('Out');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('degrades json_schema -> json_object -> text and remembers the working mode', async () => {
    const seen: string[] = [];
    const f = async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      const t = body.response_format?.type ?? 'text';
      seen.push(t);
      if (t !== 'text') return json({ error: { message: 'unsupported response_format' } }, 400);
      return chat('结果：\n```json\n{"title":"t","n":1}\n```');
    };
    const p = make(f as unknown as typeof fetch);
    const r = await p.generateStructured(req());
    expect(seen).toEqual(['json_schema', 'json_object', 'text']);
    expect(r.data.title).toBe('t');
    expect(r.warnings.length).toBe(2);
    expect(p.structuredMode).toBe('text');
    seen.length = 0;
    await p.generateStructured(req());
    expect(seen).toEqual(['text']); // no re-probing
  });

  it('the json_object / text prompt carries the schema and the word JSON', async () => {
    let sys = '';
    const f = async (_u: unknown, init?: RequestInit) => {
      sys = JSON.parse(init!.body as string).messages[0].content;
      return chat('{"title":"x","n":0}');
    };
    await make(f as unknown as typeof fetch, { mode: 'json_object' }).generateStructured(req());
    expect(sys).toContain('JSON');
    expect(sys).toContain('"title"');
  });

  it('reports truncation, refusal and schema violations as typed errors', async () => {
    const trunc = make((async () => json({ choices: [{ finish_reason: 'length', message: { content: '{"title":' } }] })) as unknown as typeof fetch);
    await expect(trunc.generateStructured(req())).rejects.toBeInstanceOf(TruncatedError);
    const refuse = make((async () => json({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: '不能回答' } }] })) as unknown as typeof fetch);
    await expect(refuse.generateStructured(req())).rejects.toMatchObject({ kind: 'refusal' });
    const bad = make((async () => chat('{"title":1}')) as unknown as typeof fetch);
    const e = await bad.generateStructured(req()).catch((x: LlmError) => x);
    expect(e).toMatchObject({ kind: 'invalid_output' });
    expect((e as LlmError).detail?.issues?.some((i) => i.startsWith('title'))).toBe(true);
  });

  it('retries 429 / 5xx and then gives up with a typed error; 401 is not retried and never leaks the key', async () => {
    let n = 0;
    const flaky = make((async () => (++n < 3 ? json({ error: 'busy' }, 429) : chat('{"title":"ok","n":1}'))) as unknown as typeof fetch);
    expect((await flaky.generateStructured(req())).data.title).toBe('ok');
    expect(n).toBe(3);
    n = 0;
    const down = make((async () => (n++, json({ error: 'x' }, 503))) as unknown as typeof fetch);
    await expect(down.generateStructured(req())).rejects.toMatchObject({ kind: 'server' });
    expect(n).toBe(3);
    n = 0;
    const auth = make((async () => (n++, new Response(`bad key ${KEY}`, { status: 401 }))) as unknown as typeof fetch);
    const e = (await auth.generateStructured(req()).catch((x: LlmError) => x)) as LlmError;
    expect(e.kind).toBe('auth');
    expect(n).toBe(1);
    expect(e.message).not.toContain(KEY);
  });

  it('explains a refused connection (LM Studio not running) instead of hanging', async () => {
    const f = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const p = make(f, { retries: 0 });
    const e = (await p.test().catch((x: LlmError) => x)) as LlmError;
    expect(e.kind).toBe('network');
    expect(e.message).toContain('localhost:1234');
    expect(e.message).toContain('连接被拒绝');
  });

  it('works without a key (no authorization header) and tests the connection', async () => {
    let headers: Record<string, string> = {};
    const f = async (_u: unknown, init?: RequestInit) => {
      headers = init!.headers as Record<string, string>;
      return chat('pong', { model: 'local-model' });
    };
    const r = await make(f as unknown as typeof fetch, { apiKey: undefined }).test();
    expect(headers.authorization).toBeUndefined();
    expect(r.model).toBe('local-model');
  });
});

describe('Anthropic provider (SDK on mock fetch)', () => {
  const message = (over: Record<string, unknown> = {}) => ({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: '{"title":"c","n":2}' }],
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 }, ...over,
  });
  const make = (f: (url: string, init: RequestInit) => Response | Promise<Response>, over: Record<string, unknown> = {}) =>
    new AnthropicProvider({ apiKey: KEY, fetch: ((u: unknown, i: RequestInit) => Promise.resolve(f(String(u), i))) as unknown as typeof fetch, maxRetries: 0, ...over });

  it('sends structured output config and cacheable system blocks, without temperature / thinking / forced tool_choice', async () => {
    let body = {} as { model: string; system: Array<Record<string, unknown>>; output_config: { format: { type: string } } };
    const p = make((_u, init) => {
      body = JSON.parse(init.body as string);
      return json(message());
    });
    const r = await p.generateStructured(req({ cacheablePrefix: 'CATALOG' }));
    expect(r.data).toEqual({ title: 'c', n: 2 });
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 });
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.system[1]!).toMatchObject({ text: 'CATALOG', cache_control: { type: 'ephemeral' } });
    expect(body.system[0]!.cache_control).toBeUndefined();
    for (const k of ['temperature', 'thinking', 'tool_choice', 'top_p']) expect(body).not.toHaveProperty(k);
  });

  it('maps stop reasons and HTTP failures to typed errors', async () => {
    await expect(make(() => json(message({ stop_reason: 'max_tokens' }))).generateStructured(req())).rejects.toBeInstanceOf(TruncatedError);
    await expect(make(() => json(message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }))).generateStructured(req())).rejects.toMatchObject({ kind: 'refusal' });
    const auth = (await make(() => json({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }, 401)).test().catch((x: LlmError) => x)) as LlmError;
    expect(auth.kind).toBe('auth');
    expect(auth.message).not.toContain(KEY);
    await expect(make(() => json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429)).test()).rejects.toMatchObject({ kind: 'rate_limit' });
    await expect(make(() => json({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 400)).test()).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(make(() => { throw new TypeError('fetch failed'); }).test()).rejects.toMatchObject({ kind: 'network' });
  });

  it('streams (finalMessage) for large max_tokens', async () => {
    const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    let streamed = false;
    const p = make((_u, init) => {
      streamed = JSON.parse(init.body as string).stream === true;
      return new Response(
        sse([
          ['message_start', { type: 'message_start', message: message({ content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } }) }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"title":"s","n":' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '7}' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }],
          ['message_stop', { type: 'message_stop' }],
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const r = await p.generateStructured(req({ maxTokens: 32000 }));
    expect(streamed).toBe(true);
    expect(r.data).toEqual({ title: 's', n: 7 });
  });

  it('uses claude-sonnet-5-5 by default', () => {
    expect(make(() => json(message())).model).toBe('claude-sonnet-5-5');
  });
});

describe('result cache', () => {
  it('second identical call sends no request; changing prompt version, model or input misses', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-cache-'));
    let calls = 0;
    const provider: LlmProvider = {
      id: 'openai', model: 'm1',
      generateStructured: async () => (calls++, { data: { title: 'x', n: calls }, raw: '{}', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, warnings: [] }) as never,
      test: async () => ({ model: 'm1', latencyMs: 1 }),
    };
    const cache = new LlmCache(dir);
    const a = await generateCached(provider, cache, 'v1', req());
    const b = await generateCached(provider, cache, 'v1', req({ input: { a: 2, b: 1 } })); // same data, other key order
    expect([a.cached, b.cached, calls]).toEqual([false, true, 1]);
    expect(b.data).toEqual(a.data);
    await generateCached(provider, cache, 'v2', req());
    await generateCached(provider, cache, 'v1', req({ input: 'other' }));
    const bigger = await generateCached(provider, cache, 'v1', req({ maxTokens: 9000 })); // the token limit is not part of the request identity
    expect(bigger.cached).toBe(true);
    await generateCached({ ...provider, model: 'm2', generateStructured: provider.generateStructured, test: provider.test }, cache, 'v1', req());
    expect(calls).toBe(4);
    const c = await generateCached(provider, cache, 'v1', req(), { refresh: true });
    expect(c.cached).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not cache failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-cache-'));
    let n = 0;
    const provider: LlmProvider = {
      id: 'openai', model: 'm',
      generateStructured: async () => {
        if (n++ === 0) throw new LlmError('server', 'boom');
        return { data: { title: 'ok', n: 1 }, raw: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, warnings: [] } as never;
      },
      test: async () => ({ model: 'm', latencyMs: 1 }),
    };
    const cache = new LlmCache(dir);
    await expect(generateCached(provider, cache, 'v', req())).rejects.toThrow('boom');
    expect((await generateCached(provider, cache, 'v', req())).cached).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('settings and routes: keys stay on the server', () => {
  let tmp: string;
  let server: Server;
  let base: string;
  const logs: string[] = [];
  const fetchCalls: Array<{ url: string; auth: string | null }> = [];

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-settings-'));
    const config = resolveConfig({ ASSET_ROOT: path.join(tmp, 'none'), DATA_DIR: path.join(tmp, 'data') });
    const mockFetch = (async (u: unknown, init?: RequestInit) => {
      fetchCalls.push({ url: String(u), auth: ((init?.headers ?? {}) as Record<string, string>).authorization ?? null });
      if (String(u).includes('refused')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return chat('pong', { model: 'deepseek-flash' });
    }) as unknown as typeof fetch;
    const { app } = createApp(config, (m) => logs.push(m), { env: { NODE_ENV: 'production', LLM_SETTINGS_FILE: path.join(tmp, 'settings.local.json') }, fetch: mockFetch });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const put = (body: unknown) => fetch(`${base}/api/llm/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('starts unconfigured with the guidance text, and test reports it', async () => {
    const s = await (await fetch(`${base}/api/llm/settings`)).json();
    expect(s.status.configured).toBe(false);
    expect(s.status.message).toContain('未配置 AI');
    expect(s.available).toEqual(['anthropic', 'openai']); // no fixture provider outside test mode
    const t = await (await fetch(`${base}/api/llm/test`, { method: 'POST' })).json();
    expect(t).toMatchObject({ ok: false, error: { kind: 'not_configured' } });
  });

  it('saves a key without ever echoing it, tests the connection with it, and keeps it out of the logs', async () => {
    const saved = await put({ provider: 'openai', openai: { baseUrl: 'http://api.example/v1', model: 'deepseek-flash', apiKey: KEY } });
    const text = await saved.text();
    expect(text).not.toContain(KEY);
    const view = JSON.parse(text);
    expect(view.openai).toMatchObject({ hasKey: true, mask: 'sk-…abcd', source: 'file', model: 'deepseek-flash' });
    expect(JSON.stringify(await (await fetch(`${base}/api/llm/settings`)).json())).not.toContain(KEY);
    const t = await (await fetch(`${base}/api/llm/test`, { method: 'POST' })).json();
    expect(t).toMatchObject({ ok: true, provider: 'openai', model: 'deepseek-flash' });
    expect(JSON.stringify(t)).not.toContain(KEY);
    expect(fetchCalls.at(-1)).toEqual({ url: 'http://api.example/v1/chat/completions', auth: `Bearer ${KEY}` });
    expect(logs.join('\n')).not.toContain(KEY);
    const onDisk = await fs.readFile(path.join(tmp, 'settings.local.json'), 'utf8');
    expect(onDisk).toContain(KEY); // server-side file only
  });

  it('a refused connection becomes a clear error body, not a hang', async () => {
    await put({ openai: { baseUrl: 'http://refused.local:1234/v1' } }); // the saved key stays; a hosted endpoint without one is "not configured"
    const t = await (await fetch(`${base}/api/llm/test`, { method: 'POST' })).json();
    expect(t.ok).toBe(false);
    expect(t.error.kind).toBe('network');
    expect(t.error.message).toContain('refused.local:1234');
  });

  it('rejects malformed settings and the fixture provider outside test mode', async () => {
    expect((await put({ provider: 'nope' })).status).toBe(400);
    await put({ provider: 'fixture' });
    const s = await (await fetch(`${base}/api/llm/settings`)).json();
    expect(s.provider).not.toBe('fixture');
  });
});

describe('environment defaults', () => {
  it('loadDotEnv strips a BOM, quotes and comments and never overrides real variables', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotenv-'));
    const file = path.join(dir, '.env');
    await fs.writeFile(file, '﻿# comment\nLLM_PROVIDER=openai\nOPENAI_MODEL="deepseek-flash"\nOPENAI_API_KEY=abc123456\nKEEP=file\n');
    const env: Record<string, string | undefined> = { KEEP: 'real' };
    loadDotEnv(file, env);
    expect(env).toMatchObject({ LLM_PROVIDER: 'openai', OPENAI_MODEL: 'deepseek-flash', OPENAI_API_KEY: 'abc123456', KEEP: 'real' });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('env supplies the defaults; a value saved in the panel wins; the fixture provider appears only in test mode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-env-'));
    const env = { LLM_PROVIDER: 'openai', OPENAI_BASE_URL: 'https://api.deepseek.com', OPENAI_MODEL: 'deepseek-flash', OPENAI_API_KEY: 'sk-envkey-0000087b' };
    const s = new LlmSettings({ file: path.join(dir, 's.json'), env });
    const v = s.view();
    expect(v.status).toMatchObject({ configured: true, provider: 'openai', model: 'deepseek-flash' });
    expect(v.openai).toMatchObject({ source: 'env', mask: 'sk-…087b' });
    expect(JSON.stringify(v)).not.toContain('envkey');
    s.patch({ provider: 'anthropic', anthropic: { apiKey: 'sk-ant-xxxxxxxxxxxx' } });
    expect(s.view().provider).toBe('anthropic');
    expect(s.view().anthropic.source).toBe('file');
    expect(s.provider().provider?.model).toBe('claude-sonnet-5-5');
    const t = new LlmSettings({ file: path.join(dir, 't.json'), env: {}, fixtureProvider: () => ({ id: 'fixture', model: 'f' }) as LlmProvider });
    expect(t.view().available).toContain('fixture');
    await fs.rm(dir, { recursive: true, force: true });
  });
});

