import { describe, expect, it } from 'vitest';
import type { CompactCatalog, CompactModel, ExpressionEntry, MotionEntry } from '../../shared/schema/assets';
import {
  DEFAULT_PLACEMENT, SCALE_MAX, SCALE_MIN, clampPlacement, dragBy, gesturesFor, hitZone, resizeFromHandle, isClick, parsePrefs, pickReaction, reactionPool, resolveHubModel,
  serializePrefs, zoomAt,
} from '../../web/editor/hubCharacterLogic';

const model = (id: string, over: Partial<CompactModel> = {}): CompactModel => ({
  id, characterKey: id.split('_')[0]!, isSub: false, costume: 'casual_spring_01',
  costumeInfo: { base: 'casual', glasses: false, quality: '', mode: 'adv', still: false, tags: [] },
  mode: 'adv', quality: '', still: false, hasPhysics: true, url: `/m/${id}.model3.json`, preview: null, textureCount: 1,
  motionCount: 10, expressionCount: 5, missingFileCount: 0, ...over,
});
const catalog = (models: CompactModel[]) => ({ models } as unknown as CompactCatalog);

describe('clampPlacement', () => {
  it('keeps the defaults as they are', () => expect(clampPlacement(DEFAULT_PLACEMENT)).toEqual(DEFAULT_PLACEMENT));
  it('clamps scale and keeps the character on stage', () => {
    expect(clampPlacement({ x: 5, y: 5, scale: 99 })).toEqual({ x: 0.96, y: 0.85, scale: SCALE_MAX });
    const low = clampPlacement({ x: -3, y: -9, scale: 0.01 });
    expect(low.scale).toBe(SCALE_MIN);
    expect(low.x).toBe(0.04);
    // the feet stay visible: top + height >= 0.15
    expect(low.y + 1.32 * low.scale).toBeGreaterThanOrEqual(0.15 - 1e-9);
  });
  it('repairs non-finite values', () => expect(clampPlacement({ x: NaN, y: Infinity, scale: NaN })).toEqual({ x: DEFAULT_PLACEMENT.x, y: DEFAULT_PLACEMENT.y, scale: 1 }));
});

describe('prefs persistence', () => {
  it('falls back to the defaults on missing or broken data', () => {
    for (const raw of [null, '', 'not json', '42', 'null', '[1,2]']) expect(parsePrefs(raw)).toEqual(DEFAULT_PLACEMENT);
  });
  it('round-trips a choice, position and scale', () => {
    const p = { model: '012_school_winter_hs_01', x: 0.3, y: 0.1, scale: 1.4 };
    expect(parsePrefs(serializePrefs(p))).toEqual(p);
  });
  it('keeps 不显示角色 (null) apart from the default (absent)', () => {
    expect(parsePrefs(serializePrefs({ ...DEFAULT_PLACEMENT, model: null })).model).toBeNull();
    expect('model' in parsePrefs(serializePrefs({ ...DEFAULT_PLACEMENT }))).toBe(false);
  });
  it('drops invalid model ids and clamps stored numbers', () => {
    const p = parsePrefs(JSON.stringify({ model: '../etc/passwd', x: 9, y: 'a', scale: 0 }));
    expect(p.model).toBeUndefined();
    expect(p).toMatchObject({ x: 0.96, y: DEFAULT_PLACEMENT.y, scale: SCALE_MIN });
  });
});

describe('click vs drag', () => {
  it('a short press without movement is a click', () => expect(isClick(2, 3, 150)).toBe(true));
  it('movement past the threshold is a drag', () => expect(isClick(6, 0, 100)).toBe(false));
  it('a long press is not a click', () => expect(isClick(0, 0, 1200)).toBe(false));
});

describe('drag and zoom', () => {
  it('drags by a pixel delta as a fraction of the stage', () => {
    expect(dragBy({ x: 0.5, y: 0.1, scale: 1 }, 100, -50, 1000, 500)).toEqual({ x: 0.6, y: 0, scale: 1 });
  });
  it('zooming keeps the point under the pointer fixed', () => {
    const p = { x: 0.5, y: 0.1, scale: 1 };
    const z = zoomAt(p, 1.5, 600, 300, 1000, 1000);
    // anchor moves away from the pointer by the scale ratio
    expect(z.scale).toBeCloseTo(1.5);
    expect(z.x * 1000).toBeCloseTo(600 - (600 - 500) * 1.5);
    expect(z.y * 1000).toBeCloseTo(300 - (300 - 100) * 1.5);
  });
  it('zoom stops at the limits without drifting', () => {
    const p = { x: 0.5, y: 0.1, scale: SCALE_MAX };
    expect(zoomAt(p, 2, 100, 100, 1000, 1000)).toEqual(p);
  });
});

describe('modes', () => {
  it('normal mode only reacts to clicks', () => expect(gesturesFor('normal')).toEqual({ react: true, drag: false, zoom: false, reset: false }));
  it('adjust mode moves, scales and resets, without reactions', () => expect(gesturesFor('adjust')).toEqual({ react: false, drag: true, zoom: true, reset: true }));
});

describe('resizeFromHandle', () => {
  const p = { x: 0.5, y: 0.1, scale: 1 };
  it('dragging the handle away from the centre line scales up, towards it scales down; centre and top stay', () => {
    expect(resizeFromHandle(p, 600, 650, 1000)).toEqual({ x: 0.5, y: 0.1, scale: 1.5 });
    expect(resizeFromHandle(p, 600, 570, 1000).scale).toBeCloseTo(0.7);
  });
  it('clamps, and ignores a handle on the centre line', () => {
    expect(resizeFromHandle(p, 600, 2000, 1000).scale).toBe(SCALE_MAX);
    expect(resizeFromHandle(p, 600, 300, 1000).scale).toBe(SCALE_MIN);
    expect(resizeFromHandle(p, 501, 700, 1000)).toBe(p);
  });
});

describe('resolveHubModel', () => {
  const c = catalog([model('002_casual_spring_01'), model('001_casual_spring_01'), model('003_still', { still: true })]);
  it('honours a stored choice that exists', () => expect(resolveHubModel(c, '002_casual_spring_01')).toBe('002_casual_spring_01'));
  it('null hides the character', () => expect(resolveHubModel(c, null)).toBeNull());
  it('falls back to the default model, then to the first usable one', () => {
    expect(resolveHubModel(c, undefined)).toBe('001_casual_spring_01');
    expect(resolveHubModel(c, 'gone_model')).toBe('001_casual_spring_01');
    expect(resolveHubModel(catalog([model('003_still', { still: true }), model('004_school_winter_hs', { costumeInfo: { base: 'school', glasses: false, quality: '', mode: 'adv', still: false, tags: [] } })]), undefined)).toBe('004_school_winter_hs');
    expect(resolveHubModel(catalog([]), undefined)).toBeNull();
  });
});

describe('reactions', () => {
  const mtn = (name: string, family: string, side: MotionEntry['side']): MotionEntry => ({ name, file: `${name}.motion3.json`, family, side, variant: '', stats: null });
  const exp = (name: string, family: string): ExpressionEntry => ({ name, file: `${name}.exp3.json`, family, index: 1 });
  const motions = [mtn('mtn_idle01', 'idle01', null), mtn('mtn_nod01_L', 'nod01', 'L'), mtn('mtn_nod01_C', 'nod01', 'C'), mtn('mtn_surprised01_R', 'surprised01', 'R'), mtn('mtn_nervous01_L', 'nervous01', 'L')];
  const expressions = [exp('exp_smile01', 'smile'), exp('exp_angry01', 'angry'), exp('exp_idle01', 'idle')];

  it('maps hit-area names to zones', () => {
    expect(hitZone(['HitAreaHead'])).toBe('head');
    expect(hitZone(['Body'])).toBe('body');
    expect(hitZone([])).toBeNull();
  });
  it('prefers front-facing motions the model has, for the zone', () => {
    expect(reactionPool(motions, expressions, 'head')).toEqual({ motions: ['mtn_nod01_C'], expressions: ['exp_smile01'] });
    expect(reactionPool(motions, expressions, 'body')).toEqual({ motions: ['mtn_surprised01_R', 'mtn_nervous01_L'], expressions: ['exp_angry01'] });
  });
  it('without hit areas any reaction may be picked; idle is never one', () => {
    const pool = reactionPool(motions, expressions, null);
    expect(pool.motions).toContain('mtn_nod01_C');
    expect(pool.motions).not.toContain('mtn_idle01');
    expect(pool.expressions).not.toContain('exp_idle01');
  });
  it('picks with the given random source, and copes with an empty pool', () => {
    expect(pickReaction({ motions: ['a', 'b'], expressions: ['x'] }, () => 0.99)).toEqual({ motion: 'b', expression: 'x' });
    expect(pickReaction({ motions: [], expressions: [] })).toEqual({ motion: null, expression: null });
  });
});
