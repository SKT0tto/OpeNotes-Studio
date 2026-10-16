import { describe, expect, it } from 'vitest';
import { rollCoverScale } from '../../shared/staging/roll';
import { OURNOTES_STYLE, PRESETS, STYLE_FIELDS, coerceStyleValue, getStylePath, resolveStyle, styleField } from '../../shared/style/ournotes';

const leaves = (o: unknown, prefix = ''): string[] =>
  Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (v !== null && typeof v === 'object' ? leaves(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

describe('style table (V1-V8 numbers live here, editable)', () => {
  it('every default value has a field definition and every field points at a default value', () => {
    const defaults = leaves(OURNOTES_STYLE).sort();
    const fields = STYLE_FIELDS.map((f) => f.path).sort();
    expect(fields).toEqual(defaults);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it('retired cut drift stays compatible with stored overrides but has no editor control', () => {
    expect(styleField('travel.cutDrift')?.hidden).toBe(true);
    expect(resolveStyle({ preset: 'ournotes', overrides: { 'travel.cutDrift': false } }).values.travel.cutDrift).toBe(false);
  });

  it('every default lies inside its own field range and has the right kind', () => {
    for (const f of STYLE_FIELDS) {
      const v = getStylePath(OURNOTES_STYLE, f.path);
      expect(coerceStyleValue(f, v), f.path).toBe(v);
    }
  });

  it('defaults carry the STYLE_REFERENCE numbers', () => {
    const s = OURNOTES_STYLE;
    expect([s.shots.group.headH, s.shots.two_shot.headH, s.shots.mcu.headH, s.shots.cu.headH, s.shots.ecu.headH]).toEqual([0.4, 0.39, 0.52, 0.7, 0.95]);
    expect([s.shots.group.eyeY, s.shots.two_shot.eyeY, s.shots.mcu.eyeY, s.shots.cu.eyeY, s.shots.ecu.eyeY]).toEqual([0.32, 0.37, 0.4, 0.43, 0.42]);
    expect(s.shots.mcu.topMargin).toBeGreaterThanOrEqual(0);
    expect(s.shots.mcu.topMargin).toBeLessThanOrEqual(0.08);
    // background magnification 1.45x for two-shots / MCU-ish, >=2.5x for close-ups
    expect(s.shots.two_shot.bgZoom).toBeCloseTo(1.45);
    expect(s.shots.cu.bgZoom).toBeGreaterThanOrEqual(2.5);
    // dof table: establishing 0, group/two_shot/mcu 2, cu 5, ecu 6
    expect([s.shots.establishing.dof, s.shots.group.dof, s.shots.two_shot.dof, s.shots.mcu.dof, s.shots.cu.dof, s.shots.ecu.dof]).toEqual([0, 2, 2, 2, 5, 6]);
    expect(s.stage.actorTint).toBeCloseTo(0.92);
    // rhythm
    expect([s.rhythm.textSpeedCps, s.rhythm.readingCps, s.rhythm.minLine, s.rhythm.tail, s.rhythm.minShotSeconds]).toEqual([10, 6.5, 1.8, 0.8, 4]);
    // dialogue area at 1080: gradient 756 -> 896, #1A1030 at 0.75, name 32 px, text 34 px / 45 px, rule 847 px #A2B6CE
    const px = (v: number) => Math.round(v * 1080);
    expect([px(s.dialog.gradientY0), px(s.dialog.gradientY1)]).toEqual([756, 896]);
    expect(s.dialog.color).toBe('#1A1030');
    expect(s.dialog.maxAlpha).toBe(0.75);
    expect([px(s.dialog.nameSize), px(s.dialog.textSize), px(s.dialog.lineHeight), px(s.dialog.nameBaseline), px(s.dialog.ruleY), px(s.dialog.textTop)]).toEqual([32, 34, 45, 835, 847, 881]);
    expect(s.dialog.ruleColor).toBe('#A2B6CE');
    expect(s.dialog.maxLines).toBe(2);
    // menu button 0.10H, centre 0.135H from the right and 0.064H from the top (centre, so top edge = 0.064H - ... measured at the centre)
    expect([s.hud.menuDiameter, s.hud.menuRight, s.hud.menuTop]).toEqual([0.1, 0.135, 0.064]);
    // place banner: centre 0.5H, 58 px high, #7F9BEA at 0.75, appears 0.9 s after the fade-in, 0.25 in / 1.9 hold / 0.2 out
    expect(px(s.location.height)).toBe(58);
    expect([s.location.color, s.location.alpha, s.location.delay, s.location.slideIn, s.location.hold, s.location.slideOut]).toEqual(['#7F9BEA', 0.75, 0.9, 0.25, 1.9, 0.2]);
    // transitions: dip 0.2 / 0.2 / 0.25 (0.65 in the 0.6-0.8 s band), scene change 0.5 pause + 0.8 out + 1.2 black + 0.9 in
    expect(s.transitions.dipOut + s.transitions.dipHold + s.transitions.dipIn).toBeGreaterThanOrEqual(0.6);
    expect(s.transitions.dipOut + s.transitions.dipHold + s.transitions.dipIn).toBeLessThanOrEqual(0.8);
    expect([s.transitions.scenePause, s.transitions.sceneOut, s.transitions.sceneHold, s.transitions.sceneIn]).toEqual([0.5, 0.8, 1.2, 0.9]);
    // performance: enter 0.2 s + 0.04H slide, exit 0.25 s, reframe 0.8 s
    expect([s.performance.enterSeconds, s.performance.enterSlide, s.performance.exitSeconds, s.performance.reframeSeconds]).toEqual([0.2, 0.04, 0.25, 0.8]);
    expect(s.fx.dutchRoll).toBeGreaterThanOrEqual(8);
    expect(s.fx.dutchRoll).toBeLessThanOrEqual(12);
  });
});

describe('three-layer inheritance: preset -> project -> scene -> beat', () => {
  it('without layers the preset applies and every origin is "preset"', () => {
    const r = resolveStyle(null);
    expect(r.values).toEqual(OURNOTES_STYLE);
    expect(new Set(Object.values(r.origin))).toEqual(new Set(['preset']));
  });

  it('later layers win and the origin says which layer set the value', () => {
    const r = resolveStyle(
      { overrides: { 'dialog.nameSize': 0.04, 'rhythm.tail': 1, 'shots.mcu.headH': 0.6 } },
      { overrides: { 'rhythm.tail': 2, 'shots.mcu.headH': 0.55 } },
      { overrides: { 'shots.mcu.headH': 0.5 } },
    );
    expect(r.values.dialog.nameSize).toBe(0.04);
    expect(r.origin['dialog.nameSize']).toBe('project');
    expect(r.values.rhythm.tail).toBe(2);
    expect(r.origin['rhythm.tail']).toBe('scene');
    expect(r.values.shots.mcu.headH).toBe(0.5);
    expect(r.origin['shots.mcu.headH']).toBe('beat');
    expect(r.origin['shots.cu.headH']).toBe('preset');
  });

  it('removing an override restores the inherited value', () => {
    const project = { overrides: { 'rhythm.tail': 1 } };
    expect(resolveStyle(project, { overrides: { 'rhythm.tail': 3 } }).values.rhythm.tail).toBe(3);
    expect(resolveStyle(project, { overrides: {} }).values.rhythm.tail).toBe(1);
  });

  it('invalid overrides are ignored and reported, out-of-range numbers are clamped, the input is never mutated', () => {
    const layer = { overrides: { 'nope.x': 1, 'dialog.color': 'red', 'rhythm.minLine': 'x', 'dialog.maxLines': 99, 'dialog.maxAlpha': 3 } as Record<string, unknown> };
    const before = JSON.stringify(layer);
    const r = resolveStyle(layer);
    expect(r.issues).toHaveLength(3);
    expect(r.values.dialog.color).toBe('#1A1030');
    expect(r.values.dialog.maxLines).toBe(6);
    expect(r.values.dialog.maxAlpha).toBe(1);
    expect(JSON.stringify(layer)).toBe(before);
    expect(OURNOTES_STYLE.dialog.maxLines).toBe(2);
  });

  it('presets: "bandori-plate" keeps the old look as a theme; unknown presets fall back', () => {
    expect(Object.keys(PRESETS)).toEqual(['ournotes', 'bandori-plate']);
    expect(resolveStyle({ preset: 'bandori-plate' }).values.dialog.theme).toBe('plate');
    expect(resolveStyle({ preset: 'bandori-plate', overrides: { 'dialog.theme': 'ournotes' } }).values.dialog.theme).toBe('ournotes');
    expect(resolveStyle({ preset: 'nope' }).values.dialog.theme).toBe('ournotes');
  });

  it('the field table is what the inspector shows: label, group and range for a field', () => {
    const f = styleField('shots.cu.headH')!;
    expect(f.group).toBe('景别');
    expect(f.kind).toBe('number');
    expect(f.min).toBeLessThan(0.7);
    expect(f.max).toBeGreaterThan(0.7);
  });
});

describe('Dutch angle cover scale', () => {
  it('is 1 without roll and grows with the angle so a rotated frame still covers the corners', () => {
    expect(rollCoverScale(0, 16 / 9)).toBe(1);
    const s10 = rollCoverScale(10, 16 / 9);
    expect(s10).toBeGreaterThan(1.25);
    // brute force: the four corners of the screen, mapped back through the inverse rotation / scale, lie inside the stage
    const a = (10 * Math.PI) / 180;
    const w = 16;
    const h = 9;
    for (const [cx, cy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const) {
      const x = (cx * Math.cos(a) + cy * Math.sin(a)) / s10;
      const y = (-cx * Math.sin(a) + cy * Math.cos(a)) / s10;
      expect(Math.abs(x)).toBeLessThanOrEqual(w / 2 + 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(h / 2 + 1e-9);
    }
    expect(rollCoverScale(-10, 16 / 9)).toBeCloseTo(s10);
  });
});

describe('E1: memory glow defaults', () => {
  it('the glow is brighter than the first version and the dialogue gradient keeps a share of its opacity', () => {
    const v = resolveStyle().values;
    expect(v.fx.glowBlackLift).toBeGreaterThanOrEqual(0.22);
    expect(v.fx.glowBloom).toBeGreaterThanOrEqual(0.5);
    expect(v.fx.glowDialogAlpha).toBeGreaterThan(0.3);
    expect(v.fx.glowDialogAlpha).toBeLessThan(0.8);
    expect(styleField('fx.glowDialogAlpha')).toBeTruthy();
  });
});
