/** P7.3 on the demo with the real model calibrations (skipped where the local data folder is absent). */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CalibrationSchema, type Calibration } from '../../shared/schema/calibration';
import { ProjectSchema } from '../../shared/schema/project';
import { headScreenMetrics } from '../../shared/staging/framing';
import { placeActor } from '../../shared/staging/ground';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import demo from '../fixtures/demo-project.json';
import { fakeContext } from '../unit/helpers/synthetic';

const dir = path.join(process.cwd(), 'data', 'calibration');
const project = ProjectSchema.parse(demo);
const modelIds = new Set<string>();
for (const s of project.scenes) {
  Object.values(s.wardrobe).forEach((w) => modelIds.add(w.modelId));
  for (const t of s.tracks) if (t.channel === 'costume') t.keys.forEach((k) => modelIds.add(k.value.modelId));
}
const cals: Record<string, Calibration> = {};
for (const id of modelIds) {
  const f = path.join(dir, `${id}.json`);
  if (fs.existsSync(f)) cals[id] = CalibrationSchema.parse(JSON.parse(fs.readFileSync(f, 'utf8')));
}
const available = [...modelIds].every((id) => cals[id]);

describe.skipIf(!available)('N3 / N4 / N5 on the demo with real calibrations', () => {
  const bgs = [...new Set(project.scenes.map((s) => s.background.assetId))];
  const ctx = fakeContext([...modelIds], bgs);
  ctx.calibrations = cals;
  const out = compileProject(project, ctx);
  const bg = (i: number) => out.scenes[i]!.bg;

  /** Screen metrics of every actor of a beat after its entrance has settled, camera and shot offsets applied. */
  const metricsAt = (si: number, beatId: string) => {
    const sc = out.scenes[si]!;
    const b = sc.beats.find((x) => x.id === beatId)!;
    const t = Math.min(b.start + 1.0, b.end - 0.01); // after any entrance reframing has settled
    const st = evaluate(out, t);
    return st.actors.filter((a) => st.actors.length > 0 && a.opacity > 0.99).map((a) => {
      const p = placeActor(cals[a.modelId]!, { slot: a.slot, depth: a.depth }, bg(si));
      const c = p.headCenter;
      const sh = (r: typeof p.headBox) => ({ x: c.x + (r.x - c.x) * a.shiftS + a.shiftX, y: c.y + (r.y - c.y) * a.shiftS + a.shiftY, w: r.w * a.shiftS, h: r.h * a.shiftS });
      return { id: a.castId, m: headScreenMetrics({ id: a.castId, head: sh(p.headBox), body: sh(p.bodyBox), yaw: 0 }, bg(si), { ...st.camera, zoom: st.camera.zoom }) };
    });
  };

  it('two-shots: head height 0.39H, faces at +-0.47H, eye lines within 0.07H', () => {
    const twos = out.scenes.flatMap((s, si) => s.beats.filter((b) => b.shotType === 'two_shot' && !b.shotHeld && b.focus.length >= 2).map((b) => ({ si, id: b.id })));
    expect(twos.length).toBeGreaterThan(0);
    for (const { si, id } of twos) {
      const two = metricsAt(si, id).filter((x) => out.scenes[si]!.beats.find((b) => b.id === id)!.focus.includes(x.id));
      expect(two).toHaveLength(2);
      for (const { m } of two) {
        expect(Math.abs(m.headH - 0.39), `${id} headH ${m.headH}`).toBeLessThanOrEqual(0.03);
        expect(Math.abs(Math.abs(m.centerX) - 0.47), `${id} faceX ${m.centerX}`).toBeLessThanOrEqual(0.04);
      }
      expect(Math.abs(two[0]!.m.eyeY - two[1]!.m.eyeY), `${id} eye gap`).toBeLessThanOrEqual(0.07);
    }
  });

  it('groups: the front row has head height 0.40H', () => {
    const groups = out.scenes.flatMap((s, si) => s.beats.filter((b) => b.shotType === 'group' && !b.shotHeld).map((b) => ({ si, id: b.id })));
    expect(groups.length).toBeGreaterThan(0);
    for (const { si, id } of groups) {
      const front = Math.max(...metricsAt(si, id).map((x) => x.m.headH));
      expect(Math.abs(front - 0.4), `${id} front headH ${front}`).toBeLessThanOrEqual(0.04);
    }
  });

  it('N5: the climax of the demo (s3b6) is a close-up, not swallowed by the minimum-shot rule', () => {
    const b = out.scenes[2]!.beats.find((x) => x.id === 's3b6')!;
    expect(b.shotType).toBe('cu');
    expect(b.shotHeld).toBe(false);
  });

  it('N4: a person who would stand half-cut at the frame edge of a single-person shot is hidden for that shot', () => {
    for (const [si, sc] of out.scenes.entries()) {
      for (const b of sc.beats) {
        if (b.focus.length !== 1 || b.shotType === 'establishing' || b.shotHeld) continue;
        const st = evaluate(out, Math.min(b.start + 1.0, b.end - 0.01));
        const cam = st.camera;
        for (const a of st.actors) {
          if (a.castId === b.focus[0] || a.opacity < 0.5) continue;
          const p = placeActor(cals[a.modelId]!, { slot: a.slot, depth: a.depth }, bg(si));
          const half = (bg(si).height / cam.zoom) * (16 / 9) / 2;
          const left = cam.x - half;
          const right = cam.x + half;
          const box = { x0: Math.min(p.bodyBox.x, p.headBox.x - p.headBox.w * 0.9), x1: Math.max(p.bodyBox.x + p.bodyBox.w, p.headBox.x + p.headBox.w * 1.9) };
          const share = Math.max(0, Math.min(box.x1, right) - Math.max(box.x0, left)) / (box.x1 - box.x0);
          expect(share <= 0.05 || share >= 0.7, `${b.id}: ${a.castId} visible share ${share}`).toBe(true);
        }
      }
    }
  });
});
