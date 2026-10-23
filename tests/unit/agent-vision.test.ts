import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentTurn, type FrameSource } from '../../server/agent/loop';
import { OpenAiCompatProvider } from '../../server/llm/openaiCompat';
import { zeroUsage, type DescribeImagesRequest } from '../../server/llm/provider';
import { LlmSettings } from '../../server/settings/store';
import { frameTimes, planFrames, videoSampleTimes } from '../../shared/agent/frames';
import type { Project } from '../../shared/schema/project';
import { cat, directedProject } from './helpers/directorFlow';
import { ScriptedProvider, call, reply } from './helpers/scriptedProvider';

const P = directedProject();
const S = P.scenes[2]!;
const b = (i: number) => S.beats[i]!;
const PIC = 'data:image/jpeg;base64,/9j/AAAA';
const director = (provider: ScriptedProvider) => ({ provider, cache: null, catalog: cat, now: () => 5000 });

/** A frame source that records what it was asked to render. */
function fakeFrames() {
  const seen: Array<{ project: Project; labels: string[]; width: number }> = [];
  const src: FrameSource = { capture: async (project, req) => { seen.push({ project, labels: req.frames.map((f) => f.label), width: req.width }); return req.frames.map((f) => ({ label: f.label, dataUrl: PIC })); } };
  return { src, seen };
}

describe('frames: what capture_frames asks the renderer for', () => {
  it('one frame per beat at its middle, or samples spread over the beat; at most 8; times map onto the compiled beats', () => {
    const no = (id: string) => (id === 'x' ? null : `第1场${id}`);
    expect(planFrames({ beatIds: ['a'] }, no).requests).toEqual([{ beatId: 'a', at: 'mid', label: '第1场a（中间）' }]);
    const three = planFrames({ beatIds: ['a'], samples: 3 }, no).requests as Array<{ at: number }>;
    expect(three.map((r) => r.at)).toEqual([0.08, 0.5, 0.92]);
    expect(planFrames({ beatIds: ['x'] }, no).problems[0]).toContain('不存在');
    expect(planFrames({ beatIds: ['a', 'b', 'c'], samples: 4 }, no).requests).toHaveLength(8);
    const compiled = { duration: 10, scenes: [{ beats: [{ id: 'a', start: 2, end: 4 }] }] } as never;
    expect(frameTimes(compiled, [{ beatId: 'a', at: 'mid', label: '' }, { beatId: 'a', at: 0.25, label: '' }, { beatId: 'a', at: 1.5, label: '' }, { beatId: 'zz', label: '' }, { time: 99, label: '' }])).toEqual([3, 2.5, 3.5, null, 9.96]);
    expect(videoSampleTimes(10, 4)).toEqual([0.5, 3.5, 6.5, 9.5]);
  });
});

describe('OpenAI-compatible pictures', () => {
  it('a user turn with pictures is sent as content parts (text, label, image_url)', async () => {
    let body: { messages: Array<{ role: string; content: unknown }> } | null = null;
    const fetch = (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const p = new OpenAiCompatProvider({ baseUrl: 'http://x/v1', model: 'm', fetch, modeMemory: false, toolsMemory: false });
    await p.chatTools({ messages: [{ role: 'user', content: '看图', images: [{ dataUrl: PIC, label: '【附图1】' }] }, { role: 'user', content: '纯文字' }], tools: [], maxTokens: 100 });
    expect(body!.messages[0]!.content).toEqual([{ type: 'text', text: '看图' }, { type: 'text', text: '【附图1】' }, { type: 'image_url', image_url: { url: PIC } }]);
    expect(body!.messages[1]!.content).toBe('纯文字');
  });
  it('whether the model takes pictures comes from the endpoint model list (cached); unknown stays null', async () => {
    let calls = 0;
    const fetch = (async () => { calls++; return new Response(JSON.stringify({ data: [{ id: 'eyes', input_modalities: ['text', 'image'] }, { id: 'blind', input_modalities: ['text'] }] }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const mk = (model: string) => new OpenAiCompatProvider({ baseUrl: 'http://models-test/v1', model, fetch });
    expect(await mk('eyes').imageInput()).toBe(true);
    expect(await mk('eyes').imageInput()).toBe(true);
    expect(await mk('blind').imageInput()).toBe(false);
    expect(await mk('other').imageInput()).toBe(null);
    expect(calls).toBe(3);
  });
});

describe('agent loop: the assistant sees the stage and the pictures the user attaches', () => {
  it('capture_frames renders the sandbox (with this turn\'s edits) and the pictures follow the tool results', async () => {
    const { src, seen } = fakeFrames();
    const p = new ScriptedProvider([
      reply('', [call('set_shot', { beatIds: [b(2).id], type: 'ecu' })]),
      reply('', [call('capture_frames', { beatIds: [b(2).id], samples: 2, width: 320 })]),
      reply('', [call('get_beat', { beatId: b(2).id })]),
      reply('截图看过了，是大特写。'),
    ]);
    const r = await runAgentTurn({ provider: p, catalog: cat, director: director(p), now: () => 5000, frames: src, vision: { mode: 'inline' } }, { project: P, selection: { sceneId: 's_3', beatId: b(2).id }, instruction: '推到大特写，然后看一眼' });
    expect(p.toolRequests[0]!.tools.map((t) => t.name)).toContain('capture_frames');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.width).toBe(320);
    expect(seen[0]!.labels).toHaveLength(2);
    expect(seen[0]!.project.scenes[2]!.beats[2]!.shot.type).toBe('ecu');
    const third = p.toolRequests[2]!.messages;
    expect(third.at(-2)).toMatchObject({ role: 'tool' });
    expect(third.at(-1)).toMatchObject({ role: 'user', images: [{ dataUrl: PIC }, { dataUrl: PIC }] });
    expect(r.stats.framesCaptured).toBe(2);
  });

  it('without a frame source or without eyes the tool is not offered; attached pictures are then announced as unseen', async () => {
    const p = new ScriptedProvider([reply('我看不到图。')]);
    await runAgentTurn({ provider: p, catalog: cat, director: director(p), now: () => 5000, frames: fakeFrames().src, vision: null }, { project: P, selection: { sceneId: 's_3' }, instruction: '像这张图这样', attachments: [{ dataUrl: PIC, label: '附图1' }] });
    const req = p.toolRequests[0]!;
    expect(req.tools.map((t) => t.name)).not.toContain('capture_frames');
    expect(req.messages.at(-1)!.content).toContain('没有可用的视觉模型');
    expect(req.messages.at(-1)!.images).toBeUndefined();
  });

  it('inline: attached pictures go with the instruction; describe: a separate vision model turns them (and captures) into words', async () => {
    const inline = new ScriptedProvider([reply('看到了。')]);
    await runAgentTurn({ provider: inline, catalog: cat, director: director(inline), now: () => 5000, vision: { mode: 'inline' } }, { project: P, selection: { sceneId: 's_3' }, instruction: '像这张图这样', attachments: [{ dataUrl: PIC, label: '附图1' }] });
    expect(inline.toolRequests[0]!.messages.at(-1)).toMatchObject({ images: [{ dataUrl: PIC, label: '附图1' }] });

    const asked: DescribeImagesRequest[] = [];
    const eyes = { id: 'openai' as const, model: 'eyes', generateStructured: () => { throw new Error('no'); }, test: async () => ({ model: 'eyes', latencyMs: 1 }), describeImages: async (q: DescribeImagesRequest) => { asked.push(q); return { text: '两个人，左边粉发', usage: { ...zeroUsage(), inputTokens: 300 } }; } };
    const { src } = fakeFrames();
    const p = new ScriptedProvider([reply('', [call('capture_frames', { beatIds: [b(2).id], question: '谁在画面里？' })]), reply('好的。')]);
    const r = await runAgentTurn({ provider: p, catalog: cat, director: director(p), now: () => 5000, frames: src, vision: { mode: 'describe', provider: eyes } }, { project: P, selection: { sceneId: 's_3', beatId: b(2).id }, instruction: '像这张图这样', attachments: [{ dataUrl: PIC, label: '附图1' }] });
    expect(asked).toHaveLength(2);
    expect(p.toolRequests[0]!.messages.at(-1)!.content).toContain('两个人，左边粉发');
    expect(p.toolRequests[0]!.messages.at(-1)!.images).toBeUndefined();
    expect(p.toolRequests[1]!.messages.at(-1)).toMatchObject({ role: 'tool' });
    expect(p.toolRequests[1]!.messages.at(-1)!.content).toContain('视觉模型的描述');
    expect(asked[1]!.prompt).toContain('谁在画面里？');
    expect(r.usage.inputTokens).toBeGreaterThanOrEqual(600);
  });
});

describe('settings: which eyes the assistant gets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-'));
  const main = (takesPictures: boolean | null) => Object.assign(new ScriptedProvider([]), { imageInput: async () => takesPictures });
  it('auto uses the main model when it takes pictures, else the separate one, else none; off / main / separate are honoured', async () => {
    const plain = new LlmSettings({ file: path.join(tmp, 'a.json'), env: {} });
    expect(await plain.vision(main(true))).toMatchObject({ mode: 'inline' });
    expect(await plain.vision(main(false))).toBeNull();
    const sep = new LlmSettings({ file: path.join(tmp, 'b.json'), env: { VISION_BASE_URL: 'http://localhost:1234/v1', VISION_MODEL: 'llava' } });
    expect(await sep.vision(main(null))).toMatchObject({ mode: 'describe', model: 'llava' });
    expect(await sep.vision(main(true))).toMatchObject({ mode: 'inline' });
    sep.patch({ vision: { mode: 'separate' } });
    expect(await sep.vision(main(true))).toMatchObject({ mode: 'describe' });
    sep.patch({ vision: { mode: 'off' } });
    expect(await sep.vision(main(true))).toBeNull();
    sep.patch({ vision: { mode: 'main' } });
    expect(await sep.vision(main(null))).toMatchObject({ mode: 'inline' });
    expect(sep.view().vision).toMatchObject({ mode: 'main', model: 'llava', hasKey: false });
    // a remote vision endpoint needs a key
    const remote = new LlmSettings({ file: path.join(tmp, 'c.json'), env: { VISION_BASE_URL: 'https://api.example.com/v1', VISION_MODEL: 'v' } });
    expect(await remote.vision(main(false))).toBeNull();
  });
});
