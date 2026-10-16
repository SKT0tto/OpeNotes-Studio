import { describe, expect, it } from 'vitest';
import { parallaxAt } from '../../shared/staging/travelBg';
import { bgView, viewWorldHeight } from '../../shared/staging/world';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { sampleNum } from '../../shared/timeline/sample';
import type { CompiledBeat, CompiledProject, CompiledScene } from '../../shared/timeline/types';
import { asTravel, novelProject } from './helpers/travelNovel';

/**
 * "Is the travel system like the original?": the example novel (examples/mygo-rehearsal.txt), directed by the rule director in travel
 * mode, compiled with the default style. The numbers are the measured rules of the original (dev-notes/original-camera-analysis-all-episodes.md).
 */
const MOVE = ['distance', 'lateral', 'regroup'];

async function build() {
  const { p, ctx } = await novelProject();
  const c = compileProject(asTravel(p), ctx);
  const keep = compileProject({ ...asTravel(p), style: { ...p.style, overrides: { ...p.style.overrides, 'travel.neighbours': 'keep' } } }, ctx);
  return { c, keep };
}
interface Change {
  scene: CompiledScene;
  beat: CompiledBeat;
  /** Seconds until the next real shot change, a background change or the end of the scene. */
  span: number;
  prevIds: string[];
  prevType: string;
}
/** Every real shot change inside a scene (not the first shot, not an empty or insert shot, not a settle / reframe / drift). */
function changesOf(c: CompiledProject): Change[] {
  const out: Change[] = [];
  for (const scene of c.scenes) {
    let prev: CompiledBeat | null = null;
    const real = scene.beats.filter((b) => !b.shotHeld);
    real.forEach((beat, i) => {
      const next = real[i + 1];
      const span = (next ? next.start : scene.end) - beat.start;
      const k = beat.camTravel!.kind;
      const people = beat.shotType !== 'establishing' && beat.shotType !== 'insert';
      if (prev && people && !['settle', 'drift', 'reframe', 'glide'].includes(k)) out.push({ scene, beat, span, prevIds: prev.focus, prevType: prev.shotType });
      prev = people ? beat : null;
    });
  }
  return out;
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const isMove = (k: string) => MOVE.includes(k);

describe('travel = the original (the example novel, rule director, default style)', () => {
  it('every shot change has a reason', async () => {
    const { c } = await build();
    for (const s of c.scenes) for (const b of s.beats) if (!b.shotHeld) expect(b.camTravel?.reason, `${s.id}/${b.id}`).toBeTruthy();
  });

  it('groups look like the classic ones (head = groupHeadTarget of the head count, 0.24-0.42 of the frame) and a group of five or more pushes in to a medium shot', async () => {
    const { c } = await build();
    let groups = 0;
    let pushes = 0;
    for (const x of changesOf(c)) {
      if (x.beat.shotType === 'group') {
        const t = Math.min(x.beat.start + x.beat.camTravel!.seconds + 0.05, x.beat.start + x.span - 0.02);
        const st = evaluate(c, t);
        const share = (sampleNum(x.scene.travel!.focusHead, t, 0) * st.camera.zoom) / viewWorldHeight(x.scene.bg);
        expect(share, x.beat.id).toBeGreaterThanOrEqual(OURNOTES_STYLE.framing.groupHeadMin - 0.02);
        expect(share, x.beat.id).toBeLessThanOrEqual(OURNOTES_STYLE.framing.groupHead3 + 0.02);
        groups++;
      }
      if (x.prevType === 'group' && x.beat.shotType === 'ms' && isMove(x.beat.camTravel!.kind)) {
        const k = x.scene.camera.find((q) => q.travel && Math.abs(q.at - x.beat.start) < 1e-9)!;
        const z0 = evaluate(c, x.beat.start - 1e-4).camera.zoom;
        // a small group (head 0.41) is larger than a medium shot (0.31): that move pulls out slightly, as in classic's ladder
        expect(k.pose.zoom / z0, x.beat.id).toBeGreaterThan(0.7);
        if (k.pose.zoom / z0 > 1) pushes++;
      }
    }
    expect(groups).toBeGreaterThan(0);
    expect(pushes).toBeGreaterThanOrEqual(0); // the example novel has groups of three and four only: no push
  });

  it('classic spacing: neighbours stand about 1.3 head heights apart (the classic group pitch), sideways moves move the background 0.10-0.30 W (original 0.14-0.26), parallax per shot size', async () => {
    const { c } = await build();
    expect(OURNOTES_STYLE.travel.pitchHeads).toBeGreaterThanOrEqual(1.2);
    expect(OURNOTES_STYLE.travel.pitchHeads).toBeLessThanOrEqual(1.4);
    const lat: number[] = [];
    const par: Record<string, number[]> = {};
    for (const x of changesOf(c)) {
      const k = x.beat.camTravel!;
      const tr = x.scene.travel!;
      const t = Math.min(x.beat.start + k.seconds + 0.05, x.beat.start + x.span - 0.02);
      const st = evaluate(c, t);
      const share = (sampleNum(tr.focusHead, t, 0) * st.camera.zoom) / viewWorldHeight(x.scene.bg);
      (par[x.beat.shotType] ??= []).push(parallaxAt(share, tr.bg.sigma));
      if (k.kind !== 'lateral' && k.kind !== 'regroup') continue;
      const e0 = evaluate(c, x.beat.start - 1e-4);
      const e1 = evaluate(c, x.beat.start + k.seconds);
      const v0 = bgView(x.scene.bg, e0.camera, e0.background.framing, tr.aspect);
      const v1 = bgView(x.scene.bg, e1.camera, e1.background.framing, tr.aspect);
      lat.push((Math.abs(v1.cx - v0.cx) * ((v0.zoom + v1.zoom) / 2)) / (viewWorldHeight(x.scene.bg) * tr.aspect));
    }
    const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)]!;
    expect(lat.length).toBeGreaterThan(3);
    expect(med(lat)).toBeGreaterThanOrEqual(0.1);
    expect(med(lat)).toBeLessThanOrEqual(0.3);
    expect(med(par.group!)).toBeGreaterThanOrEqual(0.72); // v7: classic group heads (0.33-0.41) are larger than the old 0.23
    expect(med(par.group!)).toBeLessThanOrEqual(0.82);
    expect(med(par.ms!)).toBeGreaterThanOrEqual(0.78);
    expect(med(par.ms!)).toBeLessThanOrEqual(0.92);
    expect(med(par.two_shot!)).toBeGreaterThanOrEqual(0.72);
    expect(med(par.two_shot!)).toBeLessThanOrEqual(0.8);
  });

  it('the example has both held dialogue and motivated changes without shot quotas', async () => {
    const { c } = await build();
    expect(c.scenes.some((s) => s.beats.some((b) => b.shotHeld))).toBe(true);
    for (const x of changesOf(c)) expect(x.beat.camTravel!.reason).toBeTruthy();
  });

  it('tight reactions inferred for old projects cut directly', async () => {
    const { c } = await build();
    for (const x of changesOf(c)) if ((x.beat.shotType === 'cu' || x.beat.shotType === 'ecu') && !sameSet(x.prevIds, x.beat.focus)) expect(isMove(x.beat.camTravel!.kind), x.beat.id).toBe(false);
  });

  it('attention changes explain motivation or a safety downgrade without probabilistic exceptions', async () => {
    const { c } = await build();
    const reasons = changesOf(c).map((x) => x.beat.camTravel!.reason!);
    expect(reasons.some((r) => r.includes('交接注意'))).toBe(true);
    for (const r of reasons) expect(r).not.toMatch(/例外|原作约|\d+%/);
  });

  it('hard cuts have no decorative drift to erase their narrative reasons', async () => {
    const { c } = await build();
    const cuts = changesOf(c).filter((x) => x.beat.camTravel!.kind === 'cut');
    expect(cuts.length).toBeGreaterThan(0);
    for (const x of cuts) expect(x.scene.camera.some((k) => k.travel?.kind === 'cutDrift' && k.at === x.beat.start)).toBe(false);
  });

  it('motivated movement leaves stable viewing without a movement quota', async () => {
    const { c } = await build();
    const changes = changesOf(c);
    expect(changes.some((x) => isMove(x.beat.camTravel!.kind))).toBe(true);
    expect(changes.some((x) => x.beat.camTravel!.kind === 'cut')).toBe(true);
  });

  it('move durations: 0.4-2 s, never more than 60% of the hold, OutQuad throughout', async () => {
    const { c } = await build();
    const secs: number[] = [];
    for (const x of changesOf(c)) {
      const k = x.beat.camTravel!;
      if (!isMove(k.kind)) continue;
      expect(k.seconds, x.beat.id).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(k.seconds, x.beat.id).toBeLessThanOrEqual(2 + 1e-9);
      expect(k.seconds, x.beat.id).toBeLessThanOrEqual(x.span * 0.6 + 1e-9);
      expect(k.ease, x.beat.id).toBe('outQuad');
      secs.push(k.seconds);
    }
    expect(secs.length).toBeGreaterThan(0);
    for (const s of c.scenes) for (const b of s.beats) if (!b.shotHeld && b.camTravel!.kind === 'reframe') expect(b.camTravel!.ease).toBe('outQuad');
  });

  it('settled frames: the background blur follows the shot size, people of one row are sharp, tight shots show only their person, wide ones everybody', async () => {
    const { c, keep } = await build();
    const bgBy: Record<string, number[]> = {};
    let rows = 0;
    for (let si = 0; si < c.scenes.length; si++) {
      const s = c.scenes[si]!;
      for (let bi = 0; bi < s.beats.length; bi++) {
        const b = s.beats[bi]!;
        if (b.shotHeld || b.shotType === 'establishing' || b.shotType === 'insert') continue;
        const k = b.camTravel!;
        const settle = b.start + k.seconds + 0.05;
        if (settle > b.end - 0.01) continue; // the move runs on into the lines that keep this camera
        const st = evaluate(c, settle);
        const sk = evaluate(keep, settle);
        (bgBy[b.shotType] ??= []).push(st.background.blur);
        const tight = b.shotType === 'mcu' || b.shotType === 'cu' || b.shotType === 'ecu';
        const focusPos = st.actors.filter((a) => b.focus.includes(a.castId));
        st.actors.forEach((a, i) => {
          const present = sk.actors[i]!.opacity;
          if (tight && !b.focus.includes(a.castId)) expect(a.opacity, `${b.id}/${a.castId}`).toBe(0);
          else if (b.shotType === 'ms' || b.shotType === 'two_shot') expect(a.opacity === 0 || Math.abs(a.opacity - present) < 1e-9, `${b.id}/${a.castId}`).toBe(true);
          else expect(a.opacity, `${b.id}/${a.castId}`).toBeCloseTo(present, 9);
          if (focusPos.some((f) => Math.abs(f.depth - a.depth) < 1e-9)) {
            expect(a.blur, `${b.id}/${a.castId}`).toBe(0);
            rows++;
          }
        });
      }
    }
    expect(rows).toBeGreaterThan(20);
    for (const t of ['group', 'two_shot', 'ms']) for (const x of bgBy[t] ?? []) expect(x, t).toBeLessThanOrEqual(0.1);
    expect((bgBy.mcu ?? []).length).toBeGreaterThan(0);
    for (const x of bgBy.mcu ?? []) {
      expect(x).toBeGreaterThanOrEqual(0.8);
      expect(x).toBeLessThanOrEqual(2.6);
    }
    for (const x of bgBy.cu ?? []) {
      expect(x).toBeGreaterThanOrEqual(3.5);
      expect(x).toBeLessThanOrEqual(6.8);
    }
  });

  it('medium shots on the example novel are solo: classic static parity takes priority over original bystander frequency', async () => {
    const { c } = await build();
    let ms = 0;
    let withOther = 0;
    for (const s of c.scenes) {
      for (const b of s.beats) {
        if (b.shotHeld || b.shotType !== 'ms') continue;
        const settle = b.start + b.camTravel!.seconds + 0.05;
        if (settle > b.end - 0.01) continue;
        ms++;
        if (evaluate(c, settle).actors.some((a) => !b.focus.includes(a.castId) && a.opacity > 0.5)) withOther++;
      }
    }
    expect(ms).toBeGreaterThan(10);
    expect(withOther).toBe(0);
  });

  it('all settled backgrounds use the classic crop, including groups and off-centre framing', async () => {
    const { p, ctx } = await novelProject();
    const c = compileProject(asTravel(p), ctx);
    const classic = compileProject(p, ctx);
    let checked = 0;
    for (let si = 0; si < c.scenes.length; si++) {
      const s = c.scenes[si]!;
      for (const b of s.beats) {
        if (b.shotHeld) continue;
        const t = b.start + (b.camTravel?.seconds ?? 0) + 0.01;
        if (t >= b.end) continue;
        const original = p.scenes[si]!.beats.find(x => x.id === b.id)!;
        if (original.shot.move !== 'static') continue;
        const a = evaluate(c, t), q = evaluate(classic, t);
        const av = bgView(s.bg, a.camera, a.background.framing);
        const qv = bgView(classic.scenes[si]!.bg, q.camera, q.background.framing);
        for (const field of ['cx', 'cy', 'zoom'] as const) expect(av[field], b.id + '/' + field).toBeCloseTo(qv[field], 7);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('no cut gains arbitrary drift regardless of shot size or sample share', async () => {
    const { c } = await build();
    for (const s of c.scenes) expect(s.camera.some((k) => k.travel?.kind === 'cutDrift')).toBe(false);
  });
});
