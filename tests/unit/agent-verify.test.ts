import { describe, expect, it } from 'vitest';
import { runAgentTurn, type FrameSource } from '../../server/agent/loop';
import { changesPicture } from '../../shared/agent/verify';
import { cat, directedProject } from './helpers/directorFlow';
import { ScriptedProvider, call, reply } from './helpers/scriptedProvider';

const P = directedProject();
const S = P.scenes[2]!;
const b = (i: number) => S.beats[i]!;
const PIC = 'data:image/jpeg;base64,/9j/AAAA';
const director = (provider: ScriptedProvider) => ({ provider, cache: null, catalog: cat, now: () => 5000 });
const frames = () => {
  const asked: string[][] = [];
  const src: FrameSource = { capture: async (_p, req) => { asked.push(req.frames.map((f) => f.label)); return req.frames.map((f) => ({ label: f.label, dataUrl: PIC })); } };
  return { src, asked };
};
const run = (p: ScriptedProvider, o: { vision?: boolean; frames?: FrameSource | undefined }) =>
  runAgentTurn({ provider: p, catalog: cat, director: director(p), now: () => 5000, frames: o.frames, vision: o.vision === false ? null : { mode: 'inline' } }, { project: P, selection: { sceneId: 's_3', beatId: b(2).id }, instruction: '推到大特写' });
const shot = (type: string) => call('set_shot', { beatIds: [b(2).id], type });
const capture = () => call('capture_frames', { beatIds: [b(2).id] });
const read = () => call('get_beat', { beatId: b(2).id });
const isForce = (m: { role: string; content: string }) => m.role === 'user' && m.content.includes('请截图核对刚才的画面改动');

describe('picture check: edits that change the picture are looked at', () => {
  it('classifies ops', () => {
    expect(changesPicture({ op: 'shot_set', sceneId: 's', beatId: 'b', set: { dof: 2 } })).toBe(true);
    expect(changesPicture({ op: 'bg_set', sceneId: 's', at: 'start', assetId: 'x' })).toBe(true);
    expect(changesPicture({ op: 'key_set', sceneId: 's', target: { kind: 'camera' }, channel: 'camera' })).toBe(true);
    expect(changesPicture({ op: 'key_set', sceneId: 's', target: { kind: 'actor', castId: 'c' }, channel: 'expression' })).toBe(false);
    expect(changesPicture({ op: 'beat_set', sceneId: 's', beatId: 'b', set: { text: 'x' } })).toBe(false);
    expect(changesPicture({ op: 'timing', sceneId: 's', beatIds: ['b'], set: {} })).toBe(false);
  });

  it('forces a capture when the model stops after a picture edit, and the card gets the frames', async () => {
    const f = frames();
    const p = new ScriptedProvider([reply('', [shot('ecu')]), reply('', [read()]), reply('改好了。'), reply('', [capture()]), reply('核对过了，是大特写。')]);
    const r = await run(p, { frames: f.src });
    expect(f.asked).toHaveLength(1);
    expect(p.toolRequests[3]!.messages.some(isForce)).toBe(true);
    expect(r.verification).toMatchObject({ status: 'verified', forced: 1 });
    expect(r.verification.frames).toHaveLength(1);
    expect(r.summary).toContain('核对过了');
  });

  it('does not force again when the model already captured after its last edit', async () => {
    const f = frames();
    const p = new ScriptedProvider([reply('', [shot('ecu')]), reply('', [capture()]), reply('', [read()]), reply('好了。')]);
    const r = await run(p, { frames: f.src });
    expect(p.toolRequests.flatMap((q) => q.messages).some(isForce)).toBe(false);
    expect(r.verification).toMatchObject({ status: 'verified', forced: 0 });
  });

  it('a text-only edit is not captured', async () => {
    const f = frames();
    const p = new ScriptedProvider([reply('', [call('edit_beat', { beatId: b(2).id, text: '改一下文字' })]), reply('', [read()]), reply('改了文字。')]);
    const r = await run(p, { frames: f.src });
    expect(f.asked).toHaveLength(0);
    expect(p.toolRequests.flatMap((q) => q.messages).some(isForce)).toBe(false);
    expect(r.verification.status).toBe('none');
  });

  it('skips when vision is off or there is no stage to render, and says so', async () => {
    const f = frames();
    for (const o of [{ vision: false, frames: f.src }, { vision: true, frames: undefined }]) {
      const p = new ScriptedProvider([reply('', [shot('ecu')]), reply('', [read()]), reply('改好了。')]);
      const r = await run(p, o);
      expect(p.toolRequests.flatMap((q) => q.messages).some(isForce)).toBe(false);
      expect(r.verification).toMatchObject({ status: 'unavailable', forced: 0 });
    }
    expect(f.asked).toHaveLength(0);
  });

  it('cap: one verification round plus two fix-and-recheck rounds; then it stops and reports it was not checked', async () => {
    const f = frames();
    const p = new ScriptedProvider([
      reply('', [shot('ecu')]), reply('', [read()]), reply('好了。'),
      reply('', [capture()]), reply('不对。', [shot('cu')]), reply('', [read()]), reply('修了。'), // forced 1 (check) -> fix, stop again
      reply('', [capture()]), reply('还不对。', [shot('mcu')]), reply('', [read()]), reply('再修。'), // forced 2 (recheck) -> fix, stop again
      reply('', [capture()]), reply('仍不对。', [shot('ecu')]), reply('', [read()]), reply('最后一次。'), // forced 3 (recheck) -> fix, stop: cap reached
    ]);
    const r = await run(p, { frames: f.src });
    expect(r.verification.forced).toBe(3);
    expect(r.verification.status).toBe('unchecked');
    expect(f.asked).toHaveLength(3);
    expect(r.summary).toBe('最后一次。');
  });

  it('a fix that is looked at again is reported as fixed', async () => {
    const f = frames();
    const p = new ScriptedProvider([reply('', [shot('ecu')]), reply('', [read()]), reply('好了。'), reply('', [capture()]), reply('太近了。', [shot('cu')]), reply('', [read()]), reply('改过了。'), reply('', [capture()]), reply('这回对了。')]);
    const r = await run(p, { frames: f.src });
    expect(r.verification).toMatchObject({ status: 'fixed', forced: 2 });
  });

  it('a renderer that fails is not asked again and again: the edit is reported as not checked', async () => {
    const src: FrameSource = { capture: async () => { throw new Error('unknown background'); } };
    const p = new ScriptedProvider([reply('', [shot('ecu')]), reply('', [read()]), reply('好了。'), reply('', [capture()]), reply('截图失败，没能核对。')]);
    const r = await run(p, { frames: src });
    expect(r.verification).toMatchObject({ status: 'unchecked', forced: 1 });
    expect(r.summary).toContain('没能核对');
  });
});
