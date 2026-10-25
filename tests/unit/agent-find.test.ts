import { describe, expect, it } from 'vitest';
import { findBeats } from '../../shared/agent/compact';
import { directedProject } from './helpers/directorFlow';

describe('find_beats: a quote remembered slightly wrong still finds its line', () => {
  it('falls back to an approximate match, best first', () => {
    const p = directedProject();
    const b = p.scenes[2]!.beats.find((x) => [...x.text].length >= 8 && x.kind === 'dialogue')!;
    const chars = [...b.text.replace(/[「」“”…。，、！？!?,.\s]/g, '')];
    const misquote = [...chars.slice(0, 3), ...chars.slice(4, 9)].join(''); // one character dropped
    const r = findBeats(p, { text: misquote });
    expect(r[0]?.beatId).toBe(b.id);
    expect(r[0]?.approx).toBeGreaterThan(0.7);
    expect(findBeats(p, { text: '完全不存在的一句话啊' })).toEqual([]);
  });
});

describe('scene table: what blurs or shifts the picture is visible', () => {
  it('shows depth of field and per-person offsets next to the shot size', async () => {
    const { sceneTable } = await import('../../shared/agent/compact');
    const p = directedProject();
    const b = p.scenes[2]!.beats[2]!;
    b.shot.dof = 6;
    b.shot.offsets = { [b.shot.focus[0] ?? 'c_001']: { x: 0.7, y: 0 } };
    const row = sceneTable(p, 's_3').split('\n').find((l) => l.includes(b.id))!;
    expect(row).toContain(`${b.shot.type}·景深6·偏移(`);
    expect(row).toContain('+0.7');
  });
});

describe('a beat id names its scene', () => {
  it('a call without sceneId about beats of one other scene goes to that scene; mixed scenes are refused with the way out', async () => {
    const { call, makeEnv } = await import('./helpers/agentEnv');
    const env = makeEnv(undefined, { sceneId: 's_1' });
    const s3 = env.sandbox.scenes[2]!;
    const b = s3.beats.find((x) => x.kind === 'dialogue')!;
    expect(String(call(env, 'get_beat', { beatId: b.id }))).toContain(`所在场景 ${s3.id}`);
    const r = call(env, 'set_timing', { beatIds: [b.id], gapSteps: 1 }) as Record<string, unknown>;
    expect(r.已放入变更集).toBeDefined();
    expect(env.applied[0]!.op.sceneId).toBe(s3.id);
    const mixed = call(env, 'set_timing', { beatIds: [b.id, env.sandbox.scenes[0]!.beats[0]!.id], gapSteps: 1, sceneId: 's_1' }) as { 错误: string[] };
    expect(mixed.错误[0]).toContain(`在场景 ${s3.id}`);
    expect(mixed.错误[0]).toContain('分开调用');
  });
});
