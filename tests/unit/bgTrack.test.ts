import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import golden from '../fixtures/compile-golden-v014.json';
import demo from '../fixtures/demo-project.json';
import aiA from '../fixtures/ai-generated-project.json';
import aiB from '../fixtures/ai-generated-project-b.json';
import aiC from '../fixtures/ai-generated-project-c.json';
import { ProjectSchema } from '../../shared/schema/project';
import { placeActor } from '../../shared/staging/ground';
import { worldToScreen } from '../../shared/staging/world';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import type { CompileContext } from '../../shared/timeline/types';
import { MINI_CTX, fakeCalibration, fakeContext, miniProject } from './helpers/synthetic';

const ctx: CompileContext = {
  ...MINI_CTX,
  backgrounds: { bg1: { width: 2048, height: 1119 }, bg2: { width: 1600, height: 900 }, white: { width: 256, height: 256 }, sky: { width: 2048, height: 1119, luma: 0.1 } },
};
const bgKey = (id: string, beatId: string, value: Record<string, unknown>, offset = 0) => ({ id, at: { beatId, offset }, value, duration: 0, ease: 'linear' });
const bgTrack = (...keys: ReturnType<typeof bgKey>[]) => ({ id: 'tb', target: { kind: 'stage' }, channel: 'background', keys });
const key = (id: string, beatId: string, offset: number, value: unknown, duration = 0) => ({ id, at: { beatId, offset }, value, duration, ease: 'inOutQuad' });

/** Screen position (in stage heights) of an actor's head centre at time t. */
function headAt(c: ReturnType<typeof compileProject>, castId: string, t: number, H = 720) {
  const sc = c.scenes[0]!;
  const st = evaluate(c, t);
  const a = st.actors.find((x) => x.castId === castId)!;
  const pl = placeActor(fakeCalibration('m'), { slot: a.slot, depth: a.depth }, sc.bg);
  const p = worldToScreen(sc.bg, st.camera, H, { x: pl.headCenter.x + a.shiftX, y: pl.headCenter.y + a.shiftY });
  return { x: p.x / H, y: p.y / H };
}

describe('background track', () => {
  it('switching from a 2048x1119 to a 1600x900 background does not move anybody (head frames change <= 0.005H)', () => {
    const plain = compileProject(miniProject(), ctx);
    const sw = compileProject(miniProject({ tracks: [bgTrack(bgKey('kb', 'b2', { assetId: 'bg2' }))] }), ctx);
    const sc = sw.scenes[0]!;
    expect(sc.bgSegments.map((s) => s.assetId)).toEqual(['bg1', 'bg2']);
    expect(sc.bg).toEqual(plain.scenes[0]!.bg);
    expect(sc.camera).toEqual(plain.scenes[0]!.camera);
    let worst = 0;
    for (let t = 0.05; t < sw.duration; t += 0.1) {
      for (const who of ['a', 'b']) {
        const x = headAt(sw, who, t);
        const y = headAt(plain, who, t);
        worst = Math.max(worst, Math.hypot(x.x - y.x, x.y - y.y));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.005);
    const b2 = sc.beats[1]!.start;
    expect(evaluate(sw, b2 + 0.01).background.assetId).toBe('bg2');
    expect(evaluate(sw, b2 + 0.01).background.src).toEqual({ width: 1600, height: 900 });
    expect(evaluate(sw, b2 - 0.01).background.assetId).toBe('bg1');
  });

  it('a scene without a background track compiles exactly as in v0.1.4 (golden hashes, bgSegments aside)', () => {
    const strip = (c: ReturnType<typeof compileProject>) => JSON.stringify({ ...c, scenes: c.scenes.map((sc) => { const o: Record<string, unknown> = { ...sc }; delete o.bgSegments; return o; }) });
    const sha = (s: string) => createHash('sha1').update(s).digest('hex');
    const variants = {
      plain: miniProject(),
      tracks: miniProject({ tracks: [{ id: 't', target: { kind: 'actor', castId: 'a' }, channel: 'expression', keys: [key('k', 'b2', 0.3, { name: 'exp_smile01' })] }] }),
      transition: miniProject({ transition: { kind: 'crossfade', duration: 1.5 } }),
    };
    for (const [name, p] of Object.entries(variants)) {
      expect(sha(strip(compileProject(p, MINI_CTX))), name).toBe((golden as Record<string, string>)[name]);
      const c = compileProject(p, MINI_CTX).scenes[0]!;
      expect(c.bgSegments).toHaveLength(1);
      expect(c.bgSegments[0]!.assetId).toBe(c.bgAssetId);
    }
  });

  it('a 256 px picture never decides the size of the stage', () => {
    const p = miniProject({ scene: { background: { assetId: 'white' } }, tracks: [bgTrack(bgKey('kb', 'b1', { assetId: 'bg1' }, 0.5))] });
    expect(compileProject(p, ctx).scenes[0]!.bg.width).toBe(2048);
  });

  it('cut / crossfade / dip_black: alpha and fade at the boundary', () => {
    const at = (c: ReturnType<typeof compileProject>, i: number) => c.scenes[0]!.beats[i]!.start;
    const cut = compileProject(miniProject({ tracks: [bgTrack(bgKey('kb', 'b2', { assetId: 'bg2', transition: 'cut' }))] }), ctx);
    expect(evaluate(cut, at(cut, 1) - 0.001).background.assetId).toBe('bg1');
    expect(evaluate(cut, at(cut, 1)).background.assetId).toBe('bg2');
    expect(evaluate(cut, at(cut, 1)).background.next).toBeUndefined();

    const cf = compileProject(miniProject({ tracks: [bgTrack(bgKey('kb', 'b2', { assetId: 'bg2', transition: 'crossfade', transitionSeconds: 1 }))] }), ctx);
    const t0 = at(cf, 1);
    expect(evaluate(cf, t0 - 0.01).background.next).toBeUndefined();
    expect(evaluate(cf, t0).background.next?.alpha).toBeCloseTo(0, 5);
    expect(evaluate(cf, t0 + 0.5).background.next?.alpha).toBeCloseTo(0.5, 5);
    expect(evaluate(cf, t0 + 0.5).background.assetId).toBe('bg1');
    expect(evaluate(cf, t0 + 0.5).background.next?.assetId).toBe('bg2');
    expect(evaluate(cf, t0 + 1.01).background.next).toBeUndefined();
    expect(evaluate(cf, t0 + 1.01).background.assetId).toBe('bg2');

    const dip = compileProject(miniProject({ tracks: [bgTrack(bgKey('kb', 'b2', { assetId: 'bg2', transition: 'dip_black', transitionSeconds: 0.6 }))] }), ctx);
    const d0 = at(dip, 1);
    expect(evaluate(dip, d0 - 0.31).fade.alpha).toBeCloseTo(0, 1);
    expect(evaluate(dip, d0 - 0.001).fade.alpha).toBeGreaterThan(0.95);
    expect(evaluate(dip, d0).fade.alpha).toBeGreaterThan(0.99);
    expect(evaluate(dip, d0 + 0.31).fade.alpha).toBeLessThan(0.01);
    expect(evaluate(dip, d0 + 0.001).background.assetId).toBe('bg2');
  });

  it('an insert segment empties the stage until the next key', () => {
    const p = miniProject({ tracks: [bgTrack(bgKey('k1', 'b2', { assetId: 'sky', purpose: 'insert' }), bgKey('k2', 'b3', { assetId: 'bg1', purpose: 'move' }))] });
    const c = compileProject(p, ctx);
    const sc = c.scenes[0]!;
    expect(evaluate(c, sc.beats[1]!.start + 1).background.assetId).toBe('sky');
    for (const a of sc.actors) expect(a.presence.some((k) => k.value === 0 && Math.abs(k.at - sc.beats[1]!.start) < 1e-6)).toBe(true);
    expect(evaluate(c, sc.beats[2]!.start + 0.1).background.assetId).toBe('bg1');
  });

  it('unknown backgrounds in the track are dropped with a warning; two keys at one instant keep the later', () => {
    const p = miniProject({ tracks: [bgTrack(bgKey('k1', 'b2', { assetId: 'nope' }), bgKey('k2', 'b2', { assetId: 'bg2' }), bgKey('k3', 'b2', { assetId: 'sky' }))] });
    const c = compileProject(p, ctx);
    expect(c.warnings.some((w) => w.includes('nope'))).toBe(true);
    expect(c.scenes[0]!.bgSegments.map((s) => s.assetId)).toEqual(['bg1', 'sky']);
  });

  it('old projects (v0.1.0-v0.1.4 fixtures) load unchanged, have no background track, and compile with one background per scene', () => {
    for (const raw of [demo, aiA, aiB, aiC]) {
      const p = ProjectSchema.parse(raw);
      expect(JSON.parse(JSON.stringify(ProjectSchema.parse(p)))).toEqual(JSON.parse(JSON.stringify(p))); // parse is a fixed point: nothing is migrated
      expect(p.schemaVersion).toBe(1);
      const models = new Set<string>();
      for (const sc of p.scenes) {
        Object.values(sc.wardrobe).forEach((w) => models.add(w.modelId));
        for (const t of sc.tracks) {
          expect(t.channel).not.toBe('background');
          if (t.channel === 'costume') t.keys.forEach((k) => models.add(k.value.modelId));
        }
      }
      const c = compileProject(p, fakeContext([...models], p.scenes.map((sc) => sc.background.assetId)));
      for (const [i, sc] of c.scenes.entries()) {
        expect(sc.bgSegments).toHaveLength(1);
        expect(sc.bgSegments[0]!.assetId).toBe(p.scenes[i]!.background.assetId);
        expect(sc.bgSegments[0]!.end).toBe(sc.end);
        expect(evaluate(c, sc.start + 0.5).background.assetId).toBe(sc.bgAssetId);
        expect(evaluate(c, sc.start + 0.5).background.next).toBeUndefined();
      }
    }
  });
});
