import { describe, expect, it } from 'vitest';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import {
  decideTravel, inferTravelIntent, lateralPeople, moveGeometry, moveSeconds, moveSizeFactor, type Density, type TravelDecision, type TravelInput, type TravelShotInfo,
} from '../../shared/timeline/travelPolicy';

const tv = OURNOTES_STYLE.travel;
const H = 1119;
const PITCH = 120;
const ZOOM = { group: 5.3, two_shot: 5, ms: 4, mcu: 6.7, cu: 9, ecu: 12 } as const;
const shot = (type: TravelShotInfo['type'], ids = ['a'], over: Partial<TravelShotInfo> & { x?: number; zoom?: number } = {}): TravelShotInfo => {
  const x = over.x ?? 1000;
  const zoom = over.zoom ?? (ZOOM as Record<string, number>)[type] ?? 1;
  const { x: _x, zoom: _z, ...rest } = over;
  void _x;
  void _z;
  return { type, ids, bgSeg: 0, pose: { x, y: 560, zoom }, anchor: { x, y: 500 }, ...rest };
};
/** A sideways move between two neighbours (one pitch apart): mcu a at x 1000, mcu b 120 world units to the right (about 0.40 W). */
const LAT_PREV = shot('mcu', ['a']);
const LAT_CUR = shot('mcu', ['b'], { x: 1120 });
const withDensity = (d: Density) => ({ ...tv, density: d });
const input = (over: Partial<TravelInput> = {}): TravelInput => ({
  cutIn: 'cut', move: 'static', userTransition: undefined, prev: LAT_PREV, cur: LAT_CUR,
  afterEmpty: false, trueEnter: false, span: 6, pitch: PITCH, aspect: 16 / 9, H, tv: withDensity('more'), ...over,
});
const move = (d: TravelDecision) => d as Extract<TravelDecision, { seconds: number }>;
describe('narrative travel: motivation, geometry and rhythm', () => {
  it('identical geometry can exchange attention, but continuation/reaction/rupture stay still', () => {
    expect(decideTravel(input({ intent: 'exchange' })).kind).toBe('lateral');
    for (const intent of ['continue', 'reaction', 'rupture'] as const) {
      const d = decideTravel(input({ intent }));
      expect(d.kind, intent).toBe('cut');
      expect(d.reason).not.toContain('例外');
    }
  });
  it('v11: an exchange between stage neighbours (adjacent slot rank) moves whatever the measured spacing; others keep the distance rule; the width cap stays', () => {
    const prev = shot('mcu', ['a'], { ranks: [0] });
    const far = (rank: number, x = 1250) => shot('mcu', ['b'], { x, ranks: [rank] });
    expect(decideTravel(input({ prev, cur: far(2), intent: 'exchange' }))).toMatchObject({ kind: 'cut', reason: expect.stringContaining('交接距离太远') });
    expect(decideTravel(input({ prev: LAT_PREV, cur: shot('mcu', ['b'], { x: 1250 }), intent: 'exchange' })).kind).toBe('cut');
    expect(decideTravel(input({ prev, cur: far(1), intent: 'exchange' })).kind).toBe('lateral');
    expect(decideTravel(input({ prev, cur: far(1, 1700), intent: 'exchange' }))).toMatchObject({ kind: 'cut', reason: expect.stringContaining('太远') });
  });
  it('renaming any scene or beat cannot alter the automatic choice', () => {
    for (const density of ['original', 'less', 'more', 'off'] as const) {
      const baseline = decideTravel(input({ intent: 'exchange', tv: withDensity(density) }));
      for (let n = 0; n < 100; n++) expect(decideTravel(input({ intent: 'exchange', tv: withDensity(density), seed: `renamed:${n}` }))).toEqual(baseline);
    }
  });
  it('push/pull motivation and the displayed direction use real zoom, even when shot ranks disagree', () => {
    const prev = shot('group', ['a', 'b'], { zoom: 6 });
    const cur = shot('ms', ['a'], { zoom: 4 });
    // a label that contradicts the geometry is rewritten from the geometry, not rejected (v10), for group / two-shot / ms landings
    expect(decideTravel(input({ prev, cur, intent: 'emphasis' }))).toMatchObject({ kind: 'regroup', reason: expect.stringMatching(/拉远.*改写/) });
    expect(decideTravel(input({ prev, cur, intent: 'release' }))).toMatchObject({ kind: 'regroup', reason: expect.stringContaining('拉远') });
    expect(decideTravel(input({ prev: cur, cur: prev, intent: 'release' }))).toMatchObject({ kind: 'regroup', reason: expect.stringMatching(/推近.*改写/) });
    // close landings keep the strict label rules
    expect(decideTravel(input({ prev: shot('mcu', ['a'], { zoom: 4 }), cur: shot('cu', ['a'], { zoom: 6 }), intent: 'release' }))).toMatchObject({ kind: 'cut', reason: expect.stringContaining('真实拉远') });
    expect(decideTravel(input({ prev: cur, cur: prev, intent: 'emphasis' }))).toMatchObject({ kind: 'regroup', reason: expect.stringContaining('推近') });
  });
  it('v10: landing on a two-shot / ms / group with the same or a neighbouring person moves, whatever the label says', () => {
    const two = shot('two_shot', ['a', 'b'], { x: 1060, zoom: 5 });
    const ms = shot('ms', ['b'], { x: 1120, zoom: 4 });
    for (const intent of ['release', 'continue', 'emphasis', 'exchange'] as const) {
      const d = decideTravel(input({ prev: ms, cur: two, intent }));
      expect(d.kind, intent).not.toBe('cut');
      expect(d.reason).toMatch(/推近|横移|拉远/);
    }
    const back = decideTravel(input({ prev: two, cur: ms, intent: 'continue' }));
    expect(back.kind).not.toBe('cut');
    expect(back.reason).toContain('改写');
    // the same framing with a continue label stays still; density off / less are honoured
    expect(decideTravel(input({ prev: ms, cur: shot('ms', ['b'], { x: 1120, zoom: 4.05 }), intent: 'continue' })).kind).toBe('cut');
    expect(decideTravel(input({ prev: ms, cur: two, intent: 'release', tv: withDensity('off') })).kind).toBe('cut');
    expect(decideTravel(input({ prev: two, cur: ms, intent: 'continue', tv: withDensity('less') })).kind).toBe('cut');
    // reaction / rupture and a far target stay hard cuts
    expect(decideTravel(input({ prev: ms, cur: two, intent: 'reaction' })).kind).toBe('cut');
    expect(decideTravel(input({ prev: ms, cur: shot('two_shot', ['c', 'd'], { x: 1700, zoom: 5 }), intent: 'release' })).kind).toBe('cut');
  });
  it('reveals need a new focus, attention transfers need adjacent people even at more density', () => {
    expect(decideTravel(input({ prev: shot('mcu'), cur: shot('cu'), intent: 'reveal' })).reason).toContain('没有新增可见焦点');
    expect(decideTravel(input({ intent: 'reveal' })).kind).toBe('lateral');
    expect(decideTravel(input({ intent: 'exchange', cur: shot('ms', ['c'], { x: 1280 }), tv: { ...withDensity('more'), maxTravelW: 3 } })).reason).toContain('交接距离太远');
  });
  it('density means eligibility and resting time, never a chance quota', () => {
    expect(decideTravel(input({ intent: 'exchange', tv: withDensity('less') })).kind).toBe('cut');
    expect(decideTravel(input({ intent: 'exchange', tv: withDensity('original') })).kind).toBe('lateral');
    expect(decideTravel(input({ intent: 'exchange', tv: withDensity('off') })).kind).toBe('cut');
    expect(decideTravel(input({ intent: 'exchange', consecutiveMoves: 2 })).reason).toContain('稳定观看');
    expect(decideTravel(input({ intent: 'emphasis', prev: shot('mcu'), cur: shot('cu'), consecutiveMoves: 1, tv: withDensity('less') })).reason).toContain('稳定观看');
  });
  it('AI flow move cannot bypass motivation, density or rhythm and is never called a user request', () => {
    expect(decideTravel(input({ intent: 'reaction', userTransition: 'travel', transitionSource: 'ai' })).kind).toBe('cut');
    expect(decideTravel(input({ intent: 'exchange', userTransition: 'travel', transitionSource: 'ai', tv: withDensity('off') })).kind).toBe('cut');
    const d = decideTravel(input({ intent: 'exchange', userTransition: 'travel', transitionSource: 'ai' }));
    expect(d.kind).toBe('lateral'); expect(d.reason).not.toContain('用户');
  });
  it('v10: an AI flow=cut is a suggestion; a user / locked cut is absolute', () => {
    const two = shot('two_shot', ['a', 'b'], { x: 1060, zoom: 5 });
    const ms = shot('ms', ['b'], { x: 1120, zoom: 4 });
    // honoured: reaction, rupture, a different person entering a close-up
    expect(decideTravel(input({ intent: 'reaction', userTransition: 'cut', transitionSource: 'ai' })).reason).toContain('AI指定');
    expect(decideTravel(input({ intent: 'rupture', userTransition: 'cut', transitionSource: 'ai' })).reason).toContain('AI指定');
    expect(decideTravel(input({ prev: ms, cur: shot('cu', ['a'], { x: 1000 }), intent: 'emphasis', userTransition: 'cut', transitionSource: 'ai' })).reason).toContain('AI指定');
    // otherwise the structural rules decide
    expect(decideTravel(input({ prev: ms, cur: two, intent: 'exchange', userTransition: 'cut', transitionSource: 'ai' })).kind).not.toBe('cut');
    expect(decideTravel(input({ prev: ms, cur: two, intent: 'exchange', userTransition: 'cut', transitionSource: 'ai', tv: withDensity('off') })).reason).not.toContain('AI指定');
    // user / locked: absolute
    expect(decideTravel(input({ prev: ms, cur: two, intent: 'exchange', userTransition: 'cut', transitionSource: 'user' })).reason).toContain('用户指定硬切');
  });
  it('explicit user choices override narrative preferences, but not background/blackout/manual keys', () => {
    expect(decideTravel(input({ intent: 'reaction', userTransition: 'travel', transitionSource: 'user', tv: withDensity('off') })).kind).toBe('lateral');
    expect(decideTravel(input({ userTransition: 'cut' })).reason).toContain('用户指定');
    expect(decideTravel(input({ userTransition: 'glide' })).kind).toBe('glide');
    expect(decideTravel(input({ userTransition: 'glide', glideSeconds: 2, manualIn: (seconds) => seconds >= 2 })).reason).toContain('手动相机');
    for (const userTransition of ['travel', 'glide'] as const) {
      expect(decideTravel(input({ userTransition, cur: shot('mcu', ['b'], { bgSeg: 1 }) })).reason).toContain('跨背景');
      expect(decideTravel(input({ userTransition, cutIn: 'dip_black' })).reason).toContain('黑场');
      expect(decideTravel(input({ userTransition, manualIn: () => true })).reason).toContain('手动相机');
    }
  });
  it('safety downgrades retain both motivation and the concrete failure reason', () => {
    for (const [over, why] of [
      [{ span: 0.7 }, '停留'], [{ prev: null }, '没有上一个镜头'],
      [{ cur: shot('mcu', ['b'], { x: 1600 }) }, '太远'],
      [{ cur: shot('ecu', ['a'], { zoom: 30 }) }, '推拉比例'],
      [{ prev: shot('insert') }, '不是人物景别'],
      [{ cur: LAT_PREV }, '机位相同'],
      [{ manualIn: () => true }, '手动相机'],
    ] as Array<[Partial<TravelInput>, string]>) {
      const d = decideTravel(input({ ...over, intent: 'exchange' }));
      expect(d.kind, why).toBe('cut'); expect(d.reason).toContain('交接注意'); expect(d.reason).toContain(why);
    }
  });
  it('a scene opening settles only to reveal the space, never decorates a reaction or a short beat', () => {
    expect(decideTravel(input({ prev: null, afterEmpty: true })).kind).toBe('settle');
    for (const over of [{ intent: 'reaction' as const }, { span: 0.7 }, { tv: withDensity('off') }, { manualIn: () => true }]) {
      expect(decideTravel(input({ prev: null, afterEmpty: true, ...over })).kind).toBe('cut');
    }
  });
  it('old projects infer from structure and real zoom without parsing prose', () => {
    expect(inferTravelIntent(shot('group', ['a', 'b'], { zoom: 6 }), shot('ms', ['a'], { zoom: 4 }))).toBe('exchange');
    expect(inferTravelIntent(shot('ms'), shot('cu'))).toBe('emphasis');
    expect(inferTravelIntent(shot('cu'), shot('ms'))).toBe('release');
    expect(inferTravelIntent(shot('ms'), shot('cu', ['b']))).toBe('reaction');
    // v11: a speaker change into a close-up is a handoff; a silent listener, or the same speaker staying, is a reaction
    expect(inferTravelIntent(shot('ms', ['a'], { speaker: 'a' }), shot('cu', ['b'], { speaker: 'b' }))).toBe('exchange');
    expect(inferTravelIntent(shot('ms', ['a'], { speaker: 'a' }), shot('cu', ['b'], { speaker: 'a' }))).toBe('reaction');
    expect(inferTravelIntent(shot('ms', ['a'], { speaker: 'a' }), shot('cu', ['b'], { speaker: null }))).toBe('reaction');
    expect(inferTravelIntent(shot('ms', ['a'], { speaker: 'a' }), shot('ecu', ['b'], { speaker: 'b' }))).toBe('exchange');
  });
  it('landing defaults and geometric durations remain unchanged', () => {
    const d = move(decideTravel(input({ intent: 'exchange' })));
    expect(d.land).toBeUndefined();
    expect(move(decideTravel(input({ tv: { ...withDensity('more'), landPush: 1.1 } }))).land).toBe(1.1);
    expect(d.seconds).toBeLessThanOrEqual(6 * 0.6);
    expect(lateralPeople(LAT_PREV, LAT_CUR, PITCH)).toBe(1);
  });
});

describe('travel policy v3: durations of the original', () => {
  const s = (type: TravelShotInfo['type'], ids = ['a']) => shot(type, ids);
  const sec = (kind: 'distance' | 'regroup' | 'lateral', prev: TravelShotInfo, cur: TravelShotInfo, lat = 1, over: Partial<typeof tv> = {}) => moveSeconds(kind, prev, cur, lat, { ...tv, ...over });
  it('one value per kind of move, as measured in the MyGO scripts', () => {
    expect(sec('lateral', s('mcu'), s('mcu', ['b']), 1)).toBe(1.0);
    expect(sec('lateral', s('mcu'), s('mcu', ['b']), 1.7)).toBe(1.2);
    expect(sec('lateral', s('mcu'), s('mcu', ['b']), 3)).toBe(1.3);
    expect(sec('distance', s('mcu'), s('cu'))).toBe(1.3);
    expect(sec('distance', s('mcu'), s('ecu'))).toBe(1.5);
    expect(sec('distance', s('cu'), s('mcu'))).toBe(1.0);
    expect(sec('distance', s('ecu'), s('mcu'))).toBe(1.5);
    expect(sec('regroup', s('mcu'), s('two_shot', ['a', 'b']))).toBe(1.0);
    expect(sec('regroup', s('two_shot', ['a', 'b']), s('mcu'))).toBe(1.2);
  });
  it('the tempo multiplies but never goes below 0.4 s or above moveMax', () => {
    expect(sec('lateral', s('mcu'), s('mcu', ['b']), 1, { tempo: 0.5 })).toBe(0.5);
    expect(sec('distance', s('mcu'), s('cu'), 1, { tempo: 0.5 })).toBeCloseTo(0.65, 9);
    expect(sec('lateral', s('mcu'), s('mcu', ['b']), 1, { tempo: 0.3 })).toBe(0.4);
    expect(sec('distance', s('ecu'), s('mcu'), 1, { tempo: 2 })).toBe(tv.moveMax);
  });
  it('decideTravel uses the table, outQuad, and the span cap on top', () => {
    const d = move(decideTravel(input({ span: 10 })));
    expect(d.seconds).toBeCloseTo(1.0 * moveSizeFactor(moveGeometry(LAT_PREV, LAT_CUR, H, 16 / 9)), 9);
    expect(d.ease).toBe('outQuad');
    expect(tv.ease).toBe('outQuad');
    expect(tv.moveEase).toBe('outQuad');
    expect(tv.settleSeconds).toBe(1);
    expect(move(decideTravel(input({ span: 1.4 }))).seconds).toBeCloseTo(0.84, 9);
  });
  it('by size: a hop is quicker than a typical move, a sweep or a big push / pull slower; the same input always gives the same time', () => {
    const f = (d: number, r: number) => moveSizeFactor({ d, r });
    expect(f(0.25, 1)).toBeCloseTo(1, 9);
    expect(f(0.1, 1)).toBeLessThan(0.6);
    expect(f(0.6, 1)).toBeGreaterThan(1.5);
    expect(f(0.1, 2.25)).toBeCloseTo(f(0.1, 1 / 2.25), 9);
    expect(f(0.1, 2.25)).toBeGreaterThan(1.5);
    expect(f(0, 1)).toBeGreaterThan(0.2);
    expect(f(5, 1)).toBe(f(9, 1));
    const a = shot('mcu', ['a']);
    const b = shot('mcu', ['b'], { x: 1120 });
    const near = shot('mcu', ['b'], { x: 1030 });
    const g = (c: TravelShotInfo) => moveSeconds('lateral', a, c, 1, tv, moveGeometry(a, c, H, 16 / 9));
    expect(g(near)).toBeLessThan(g(b));
    expect(g(b)).toBe(g(b));
    expect(g(near)).toBeGreaterThanOrEqual(0.4);
    expect(g(shot('mcu', ['b'], { x: 1500 }))).toBeLessThanOrEqual(tv.moveMax);
  });
});
