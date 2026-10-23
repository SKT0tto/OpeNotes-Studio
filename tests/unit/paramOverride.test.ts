import { describe, expect, it } from 'vitest';
import { addClamped, mapIntents, ParamOverride, type ParamAccess } from '../../web/engine/ParamOverride';

const IDS = ['ParamAngleX', 'ParamBodyAngleX', 'ParamEyeBallX'];
const RANGE: Record<string, [number, number]> = { ParamAngleX: [-30, 30], ParamBodyAngleX: [-10, 10], ParamEyeBallX: [-1, 1] };

function fake(values: number[], ids = IDS): ParamAccess {
  return {
    indexOf: (id) => ids.indexOf(id),
    get: (i) => values[i]!,
    set: (i, v) => void (values[i] = v),
    min: (i) => RANGE[ids[i]!]?.[0] ?? -1,
    max: (i) => RANGE[ids[i]!]?.[1] ?? 1,
  };
}
const signs = (h: 1 | -1 | 0 = 1, b: 1 | -1 | 0 = 1, e: 1 | -1 | 0 = 1) => ({ headSign: h, bodySign: b, eyeSign: e });

describe('mapIntents', () => {
  it('maps intents through the calibrated signs', () => {
    const m = Object.fromEntries(mapIntents({ headYaw: 0.5, bodyYaw: 1, gazeX: -1, gazeY: 0 }, signs(-1, 1, 1)).map((d) => [d.id, d.delta]));
    expect(m.ParamAngleX).toBe(-15);
    expect(m.ParamBodyAngleX).toBe(10);
    expect(m.ParamEyeBallX).toBe(-1);
  });
  it('head pitch drives ParamAngleY (negative = head down) and only when set', () => {
    const m = mapIntents({ headYaw: 0, headPitch: -0.6, bodyYaw: 0, gazeX: 0, gazeY: 0 }, signs());
    expect(m.find((d) => d.id === 'ParamAngleY')?.delta).toBeCloseTo(-12, 5);
    expect(mapIntents({ headYaw: 0, bodyYaw: 0, gazeX: 0, gazeY: 0 }, signs()).find((d) => d.id === 'ParamAngleY')).toBeUndefined();
  });
  it('clamps intents and skips axes with sign 0', () => {
    const m = mapIntents({ headYaw: 5, bodyYaw: 0, gazeX: 1, gazeY: 0 }, signs(1, 0, 0));
    expect(m.find((d) => d.id === 'ParamAngleX')?.delta).toBe(30);
    expect(m.find((d) => d.id === 'ParamBodyAngleX')).toBeUndefined();
    expect(m.find((d) => d.id === 'ParamEyeBallX')).toBeUndefined();
  });
});

describe('addClamped', () => {
  it('clamps to the real range but never drags an out-of-range value inwards', () => {
    expect(addClamped(25, 20, -30, 30)).toBe(30);
    expect(addClamped(0, -50, -30, 30)).toBe(-30);
    expect(addClamped(31, 5, -30, 30)).toBe(31);
  });
});

describe('ParamOverride', () => {
  it('is additive on the live value and does not accumulate when the base is restored each frame', () => {
    const v = [2, 0, 0];
    const ov = new ParamOverride(fake(v), signs());
    ov.setTarget({ headYaw: 0.5 }, 0);
    for (let frame = 0; frame < 100; frame++) {
      v[0] = 2; // the engine restores the saved motion value every frame
      ov.step(1 / 60);
      ov.apply();
    }
    expect(v[0]).toBeCloseTo(17);
    ov.setTarget({ headYaw: 0 }, 0);
    v[0] = 2;
    ov.apply();
    expect(v[0]).toBe(2);
  });

  it('eases in over the duration and ends exactly on target', () => {
    const ov = new ParamOverride(fake([0, 0, 0]), signs());
    ov.setTarget({ headYaw: 1 }, 0.5);
    ov.step(0.25);
    expect(ov.current.headYaw).toBeCloseTo(0.5);
    ov.step(1);
    expect(ov.current.headYaw).toBe(1);
  });

  it('never touches parameters the model does not have', () => {
    const v = [1];
    const ov = new ParamOverride(fake(v, ['ParamOther']), signs());
    ov.setTarget({ headYaw: 1, bodyYaw: 1, gazeX: 1, gazeY: 1 }, 0);
    ov.apply();
    expect(v).toEqual([1]);
  });
});
