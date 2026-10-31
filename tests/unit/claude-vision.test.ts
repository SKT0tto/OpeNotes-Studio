import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgentTurn, type FrameSource } from '../../server/agent/loop';
import { AnthropicProvider, toClaudeMessages } from '../../server/llm/anthropic';
import { TruncatedError } from '../../server/llm/provider';
import { LlmSettings } from '../../server/settings/store';
import { visionCanSee } from '../../shared/schema/settings';
import { cannotSeeImages } from '../../web/editor/panels/ai/aiSettings';
import { cat, directedProject } from './helpers/directorFlow';

const KEY = 'sk-ant-test-0123456789abcdef';
const PIC = 'data:image/jpeg;base64,/9j/AAAA';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text: '看到了' }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 }, ...over,
});
type Body = { model: string; max_tokens: number; system?: Array<Record<string, unknown>>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; tools?: Array<Record<string, unknown>>; tool_choice?: unknown };
function make(replies: Array<Response | Error>, over: Record<string, unknown> = {}) {
  const bodies: Body[] = [];
  const f = (async (_u: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as Body);
    const r = replies.shift()!;
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { p: new AnthropicProvider({ apiKey: KEY, fetch: f, maxRetries: 0, ...over }), bodies };
}

describe('AnthropicProvider.describeImages', () => {
  it('sends text, label and base64 image blocks; returns the text and usage', async () => {
    const { p, bodies } = make([json(message())]);
    const r = await p.describeImages({ prompt: '描述画面', images: [{ dataUrl: PIC, label: '【附图1】' }, { dataUrl: 'data:image/svg+xml;base64,AAAA' }, { dataUrl: 'http://x/y.png' }], maxTokens: 4000 });
    expect(r.text).toBe('看到了');
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 5 });
    expect(bodies[0]!.max_tokens).toBe(4000);
    expect(bodies[0]!.tools).toBeUndefined();
    expect(bodies[0]!.messages).toEqual([{ role: 'user', content: [
      { type: 'text', text: '描述画面' }, { type: 'text', text: '【附图1】' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' } },
    ] }]);
  });
  it('maps HTTP failures and redacts the key', async () => {
    const { p } = make([json({ type: 'error', error: { type: 'authentication_error', message: `bad ${KEY}` } }, 401)]);
    const e = (await p.describeImages({ prompt: 'x', images: [], maxTokens: 10 }).catch((x: Error) => x)) as Error & { kind: string };
    expect(e.kind).toBe('auth');
    expect(e.message).not.toContain(KEY);
  });
  it('takes pictures (imageInput true)', async () => {
    expect(await make([]).p.imageInput()).toBe(true);
  });
});

describe('AnthropicProvider.chatTools', () => {
  const tools = [{ name: 'get_beat', description: '读一句', parameters: z.toJSONSchema(z.object({ beatId: z.string() })) as Record<string, unknown> }];
  const one = [{ role: 'user' as const, content: 'x' }];

  it('maps tools, tool_use / tool_result and images inside user messages', async () => {
    const { p, bodies } = make([json(message({ stop_reason: 'tool_use', content: [{ type: 'text', text: '先读' }, { type: 'tool_use', id: 'toolu_1', name: 'get_beat', input: { beatId: 'b1' } }] }))]);
    const r = await p.chatTools({
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '看图', images: [{ dataUrl: PIC, label: '【附图1】' }] },
        { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_0', name: 'get_beat', arguments: '{"beatId":"b0"}' }] },
        { role: 'tool', content: '结果', toolCallId: 'toolu_0' },
        { role: 'user', content: '截图', images: [{ dataUrl: PIC, label: '帧1' }] },
      ],
      tools, maxTokens: 16000,
    });
    expect(r).toMatchObject({ text: '先读', finish: 'tool_use', toolCalls: [{ id: 'toolu_1', name: 'get_beat', arguments: '{"beatId":"b1"}' }] });
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 5 });
    const b = bodies[0]!;
    expect(b.max_tokens).toBe(16000);
    expect(b.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(b.tool_choice).toEqual({ type: 'auto' });
    expect(b.tools![0]).toMatchObject({ name: 'get_beat', description: '读一句', input_schema: { type: 'object', properties: { beatId: { type: 'string' } } } });
    expect(b.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(b.messages[0]!.content.map((c) => c.type)).toEqual(['text', 'text', 'image']);
    expect(b.messages[1]!.content).toEqual([{ type: 'tool_use', id: 'toolu_0', name: 'get_beat', input: { beatId: 'b0' } }]);
    // the tool result comes first, the screenshots follow in the same user message
    expect(b.messages[2]!.content.map((c) => c.type)).toEqual(['tool_result', 'text', 'text', 'image']);
    expect(b.messages[2]!.content[0]).toMatchObject({ tool_use_id: 'toolu_0', content: '结果' });
  });

  it('broken tool arguments are sent back as an empty object', () => {
    const { messages } = toClaudeMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'x', toolCalls: [{ id: 'a', name: 'n', arguments: '{oops' }] }]);
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'a', name: 'n', input: {} }]);
  });

  it('max_tokens throws TruncatedError, refusal is typed, errors are redacted', async () => {
    await expect(make([json(message({ stop_reason: 'max_tokens' }))]).p.chatTools({ messages: one, tools, maxTokens: 100 })).rejects.toBeInstanceOf(TruncatedError);
    await expect(make([json(message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }))]).p.chatTools({ messages: one, tools, maxTokens: 100 })).rejects.toMatchObject({ kind: 'refusal' });
    const e = (await make([json({ type: 'error', error: { type: 'invalid_request_error', message: `bad ${KEY}` } }, 400)]).p.chatTools({ messages: one, tools, maxTokens: 100 }).catch((x: Error) => x)) as Error & { kind: string };
    expect(e.kind).toBe('bad_request');
    expect(e.message).not.toContain(KEY);
  });

  it('an aborted signal gives kind aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(make([json(message())]).p.chatTools({ messages: one, tools, maxTokens: 100, signal: ctl.signal })).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('streams above 16000 max_tokens (capped at 32768) and reads tool_use from the stream', async () => {
    const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    const { p, bodies } = make([new Response(sse([
      ['message_start', { type: 'message_start', message: message({ content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 1 } }) }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_s', name: 'get_beat', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"beatId":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"b9"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }],
      ['message_stop', { type: 'message_stop' }],
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })]);
    const r = await p.chatTools({ messages: one, tools, maxTokens: 40000 });
    expect(bodies[0]!.max_tokens).toBe(32768);
    expect(r.toolCalls).toEqual([{ id: 'toolu_s', name: 'get_beat', arguments: '{"beatId":"b9"}' }]);
    expect(r.usage.outputTokens).toBe(12);
  });

  it('noteToolsUnsupported turns toolsSupported off', () => {
    const { p } = make([]);
    expect(p.toolsSupported()).toBe(true);
    p.noteToolsUnsupported();
    expect(p.toolsSupported()).toBe(false);
  });
});

describe('agent loop with Claude: tools mode and inline pictures', () => {
  const P = directedProject();
  const S = P.scenes[2]!;
  it('uses native tools, sends the attachment as an image block and the capture_frames shots after the tool result', async () => {
    const beat = S.beats[2]!.id;
    const { p, bodies } = make([
      json(message({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_a', name: 'capture_frames', input: { beatIds: [beat], width: 320 } }] })),
      json(message({ content: [{ type: 'text', text: '看过了' }] })),
    ]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vision-'));
    const settings = new LlmSettings({ file: path.join(tmp, 's.json'), env: {} });
    const vision = await settings.vision(p);
    expect(vision).toEqual({ mode: 'inline', model: 'claude-sonnet-5-5' });
    const frames: FrameSource = { capture: async (_pr, req) => req.frames.map((f) => ({ label: f.label, dataUrl: PIC })) };
    const r = await runAgentTurn({ provider: p, catalog: cat, director: { provider: p, cache: null, catalog: cat, now: () => 5000 }, now: () => 5000, frames, vision }, {
      project: P, selection: { sceneId: S.id, beatId: beat }, instruction: '像这张图这样', attachments: [{ dataUrl: PIC, label: '附图1' }],
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(r.mode).toBe('tools');
    expect(r.summary).toContain('看过了');
    expect(bodies[0]!.tools!.map((t) => t.name)).toContain('capture_frames');
    expect(bodies[0]!.messages[0]!.content.some((c) => c.type === 'image')).toBe(true);
    const last = bodies[1]!.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_a' });
    expect(last.content.some((c) => c.type === 'image')).toBe(true);
    expect(r.usage.outputTokens).toBe(40);
  });
});

describe('vision capability flag', () => {
  const base = { mode: 'auto' as const, provider: 'openai' as const, mainImage: null as boolean | null, separate: false };
  it('only reports false when pictures are known to be dropped', () => {
    expect(visionCanSee({ ...base, provider: 'anthropic' })).toBe(true);
    expect(visionCanSee({ ...base })).toBeNull(); // unknown OpenAI-compatible model: no warning
    expect(visionCanSee({ ...base, mainImage: true })).toBe(true);
    expect(visionCanSee({ ...base, mainImage: false })).toBe(false);
    expect(visionCanSee({ ...base, mainImage: false, separate: true })).toBe(true);
    expect(visionCanSee({ ...base, mode: 'off', provider: 'anthropic' })).toBe(false);
    expect(visionCanSee({ ...base, mode: 'separate' })).toBe(false);
    expect(visionCanSee({ ...base, mode: 'separate', separate: true })).toBe(true);
    expect(visionCanSee({ ...base, mode: 'main', mainImage: false })).toBe(true);
    expect(visionCanSee({ ...base, provider: null })).toBeNull();
  });
  it('settings view: Claude sees; a local model that lists no image input does not (after the endpoint was asked)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vision-'));
    const claude = new LlmSettings({ file: path.join(tmp, 'a.json'), env: { ANTHROPIC_API_KEY: KEY } });
    expect(claude.view().vision.canSee).toBe(true);
    claude.patch({ vision: { mode: 'off' } });
    expect(claude.view().vision.canSee).toBe(false);
    const fetch = (async () => json({ data: [{ id: 'text-only', input_modalities: ['text'] }] })) as unknown as typeof globalThis.fetch;
    const local = new LlmSettings({ file: path.join(tmp, 'b.json'), env: { OPENAI_BASE_URL: 'http://localhost:1999/v1', OPENAI_MODEL: 'text-only', LLM_PROVIDER: 'openai' }, fetch });
    expect(local.view().status.configured).toBe(true);
    expect(local.view().vision.canSee).toBeNull(); // not asked yet: no warning
    await local.probeVision();
    expect(local.view().vision.canSee).toBe(false);
    local.patch({ vision: { mode: 'main' } });
    expect(local.view().vision.canSee).toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  it('the composer refuses pictures only for a configured setup that is known to be blind', () => {
    const s = (configured: boolean, canSee: boolean | null) => ({ loading: false, error: null, settings: { status: { configured }, vision: { canSee } } as never });
    expect(cannotSeeImages(s(true, false))).toBe(true);
    expect(cannotSeeImages(s(true, null))).toBe(false);
    expect(cannotSeeImages(s(true, true))).toBe(false);
    expect(cannotSeeImages(s(false, false))).toBe(false);
    expect(cannotSeeImages({ loading: true, error: null, settings: null })).toBe(false);
    // settings from an older server carry no vision block: no warning, and no crash of the AI panel
    expect(cannotSeeImages({ loading: false, error: null, settings: { status: { configured: true } } as never })).toBe(false);
  });
});
