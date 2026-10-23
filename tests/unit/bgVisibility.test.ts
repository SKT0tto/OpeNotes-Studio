import { describe, expect, it } from 'vitest';
import demo from '../fixtures/demo-project.json';
import aiA from '../fixtures/ai-generated-project.json';
import aiB from '../fixtures/ai-generated-project-b.json';
import aiC from '../fixtures/ai-generated-project-c.json';
import { beatDetail, sceneTable } from '../../shared/agent/compact';
import { bgSwitchValue } from '../../shared/director/bgKeys';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { scenePresence } from '../../shared/timeline/presence';
import { sampleNum } from '../../shared/timeline/sample';
import { evaluate } from '../../shared/timeline/evaluate';
import { call, makeEnv, sceneOf } from './helpers/agentEnv';
import { directedProject } from './helpers/directorFlow';
import { fakeContext, miniProject } from './helpers/synthetic';

const ctx = fakeContext(['mA', 'mB'], ['bg1', 'bg2']);
const bgTrack = (purpose: string, beatId = 'b2') => ({ id: 'tb', target: { kind: 'stage' }, channel: 'background', keys: [{ id: 'kb', at: { beatId, offset: 0 }, value: bgSwitchValue('bg2', 'cut', purpose as 'move'), duration: 0, ease: 'linear' }] });
const mid = (c: ReturnType<typeof compileProject>, i: number) => { const b = c.scenes[0]!.beats[i]!; return (b.start + b.end) / 2; };
const seen = (c: ReturnType<typeof compileProject>, t: number) => evaluate(c, t).actors.filter((a) => a.opacity > 0.5).map((a) => a.castId).sort();

function contextFor(p: Project) {
  const models = new Set<string>();
  const bgs = new Set<string>();
  for (const sc of p.scenes) {
    bgs.add(sc.background.assetId);
    Object.values(sc.wardrobe).forEach((w) => models.add(w.modelId));
    for (const t of sc.tracks) for (const k of t.keys) {
      if (t.channel === 'costume') models.add((k.value as { modelId: string }).modelId);
      if (t.channel === 'background') bgs.add((k.value as { assetId: string }).assetId);
    }
  }
  return fakeContext([...models], [...bgs]);
}

describe('a background change at a mid-scene beat', () => {
  for (const system of ['classic', 'travel'] as const) {
    it(`${system}: the editor's default switch (purpose move / time) keeps everybody on screen; only an empty shot (insert) hides them`, () => {
      // travel single shots show only their focus (the shot, not the background, decides that), so compare with the unswitched scene
      const plain = compileProject(miniProject({ scene: { cameraSystem: system } }), ctx);
      for (const purpose of ['move', 'time']) {
        const c = compileProject(miniProject({ scene: { cameraSystem: system }, tracks: [bgTrack(purpose)] }), ctx);
        expect(c.scenes[0]!.bgSegments.map((s) => s.assetId)).toEqual(['bg1', 'bg2']);
        for (const i of [0, 1, 2]) expect(seen(c, mid(c, i)), `${purpose} beat ${i + 1}`).toEqual(seen(plain, mid(plain, i)));
        expect(seen(c, mid(c, 1))).toContain('b');
        expect(evaluate(c, mid(c, 1)).background.assetId).toBe('bg2');
      }
      const ins = compileProject(miniProject({ scene: { cameraSystem: system }, tracks: [bgTrack('insert')] }), ctx);
      expect(seen(ins, mid(ins, 0))).toEqual(['a', 'b']);
      expect(seen(ins, mid(ins, 1))).toEqual([]);
    });
  }
});

describe('scenePresence: who is on screen, as the compiler decides it', () => {
  it('agrees with the compiled presence x opacity on every beat of the fixtures and of a directed project with background switches', () => {
    const directed = directedProject();
    const s3 = directed.scenes.find((s) => s.id === 's_3')!;
    const key = (id: string, i: number, purpose: string) => ({ id, at: { beatId: s3.beats[i]!.id, offset: 0 }, value: bgSwitchValue(s3.background.assetId === 'bgX' ? 'bgY' : 'bgX', 'cut', purpose as 'move'), duration: 0, ease: 'linear' as const, meta: s3.meta });
    s3.tracks.push({ id: 'tb', target: { kind: 'stage' }, channel: 'background', meta: s3.meta, keys: [key('k1', 3, 'insert'), key('k2', 4, 'move'), key('k3', 9, 'time'), key('k4', 15, 'insert')] } as never);
    const projects = [...[demo, aiA, aiB, aiC].map((r) => ProjectSchema.parse(r)), ProjectSchema.parse(directed)];
    let checked = 0;
    let hidden = 0;
    for (const p of projects) {
      const c = compileProject(p, contextFor(p));
      p.scenes.forEach((sc, si) => {
        const cs = c.scenes[si]!;
        const pres = scenePresence(p, sc.id);
        sc.beats.forEach((b, bi) => {
          const bt = cs.beats.find((x) => x.id === b.id)!;
          const t = (bt.start + bt.end) / 2;
          const want = cs.actors.filter((a) => sampleNum(a.presence, t, 1) * sampleNum(a.opacity, t, 1) > 0.02).map((a) => a.castId).sort();
          expect([...pres[bi]!.visible].sort(), `${p.id} ${sc.id} ${b.id}`).toEqual(want);
          checked++;
          if (Object.keys(pres[bi]!.hidden).length) hidden++;
        });
      });
    }
    expect(checked).toBeGreaterThan(100);
    expect(hidden).toBeGreaterThan(3);
  });
});

describe('agent: set_background at a beat, and what the assistant reads back', () => {
  it('the default switch keeps the people; the read-back and get_scene say who is on screen', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const at = s.beats[10]!.id;
    const out = call(env, 'set_background', { at, assetId: 'bg_ring_night', reason: 'r' }) as Record<string, unknown>;
    expect(s.tracks.find((t) => t.channel === 'background')!.keys.find((k) => k.at.beatId === at)!.value).toMatchObject({ purpose: 'move' });
    const visible = scenePresence(env.sandbox, s.id)[10]!.visible;
    expect(visible.length).toBeGreaterThan(0);
    expect((out.画面上的人 as string[])[0]).toMatch(/^第11句：/);
    expect((out.画面上的人 as string[])[0]).not.toContain('无人');
    const row = sceneTable(env.sandbox, s.id, { from: 11, to: 11 }).split('\n').at(-1)!;
    expect(row.split('|').at(-1)).not.toMatch(/无人|隐藏/);
  });

  it('"insert" is not accepted any more; an explicit empty_shot hides everybody and every view says so', () => {
    const env = makeEnv();
    const s = sceneOf(env);
    const at = s.beats[10]!.id;
    const bad = call(env, 'set_background', { at, assetId: 'bg_ring_night', purpose: 'insert', reason: 'r' }) as Record<string, unknown>;
    expect(JSON.stringify(bad.错误)).toContain('purpose');
    const out = call(env, 'set_background', { at, assetId: 'bg_ring_night', purpose: 'empty_shot', reason: 'r' }) as Record<string, unknown>;
    expect(s.tracks.find((t) => t.channel === 'background')!.keys.find((k) => k.at.beatId === at)!.value).toMatchObject({ purpose: 'insert' });
    expect(JSON.stringify(out.提示)).toContain('空镜');
    expect((out.画面上的人 as string[])[0]).toMatch(/^第11句：无人；隐藏：/);
    expect(scenePresence(env.sandbox, s.id)[10]!.visible).toEqual([]);
    const row = sceneTable(env.sandbox, s.id, { from: 11, to: 11 }).split('\n').at(-1)!;
    expect(row.split('|').at(-1)).toBe('无人(隐藏:空镜背景)');
    expect(sceneTable(env.sandbox, s.id)).toContain('第11句→bg_ring_night(空镜(无人))');
    expect(beatDetail(env.sandbox, s.id, at)).toContain('画面上实际看得见：无人');
  });
});
