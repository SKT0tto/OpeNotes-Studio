import { describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD, autoScrollDelta, exceedsThreshold, hitItems, marqueePick, marqueePrimary, normRect, touches, type Item } from '../../web/editor/marquee';

const rows = (n: number, h = 30, gap = 4): Item[] => Array.from({ length: n }, (_, i) => ({ id: `b${i + 1}`, rect: { left: 0, top: i * (h + gap), right: 300, bottom: i * (h + gap) + h } }));
const order = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

describe('rectangles', () => {
  it('normalises a band dragged in any direction', () => {
    expect(normRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ left: 10, top: 20, right: 50, bottom: 80 });
  });
  it('touches: overlap, edge contact and containment count, a gap does not', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(touches(a, { left: 5, top: 5, right: 20, bottom: 20 })).toBe(true);
    expect(touches(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(true);
    expect(touches(a, { left: 2, top: 2, right: 3, bottom: 3 })).toBe(true);
    expect(touches(a, { left: 11, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(touches(a, { left: 0, top: 11, right: 10, bottom: 20 })).toBe(false);
  });
});

describe('hit-testing', () => {
  const items = rows(6); // tops 0, 34, 68, ...
  it('selects every row the band touches, in item order', () => {
    expect(hitItems(normRect({ x: 5, y: 40 }, { x: 5, y: 110 }), items)).toEqual(['b2', 'b3', 'b4']);
  });
  it('a band that only grazes the bottom edge of a row still selects it', () => {
    expect(hitItems({ left: 0, top: 29, right: 5, bottom: 31 }, items)).toEqual(['b1']);
  });
  it('a band in the gap between rows selects nothing; outside the list selects nothing', () => {
    expect(hitItems({ left: 0, top: 31, right: 5, bottom: 33 }, items)).toEqual([]);
    expect(hitItems({ left: 400, top: 0, right: 500, bottom: 500 }, items)).toEqual([]);
  });
  it('works for a grid of cards (two dimensions)', () => {
    const cards: Item[] = [0, 1, 2, 3].map((i) => ({ id: `c${i}`, rect: { left: (i % 2) * 110, top: Math.floor(i / 2) * 110, right: (i % 2) * 110 + 100, bottom: Math.floor(i / 2) * 110 + 100 } }));
    expect(hitItems({ left: 90, top: 90, right: 120, bottom: 120 }, cards)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(hitItems({ left: 0, top: 0, right: 50, bottom: 50 }, cards)).toEqual(['c0']);
  });
});

describe('drag threshold', () => {
  it('a tiny movement is a click', () => {
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 2, y: 1 })).toBe(false);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: DRAG_THRESHOLD, y: 0 })).toBe(true);
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 13, y: 13 })).toBe(true);
  });
});

describe('edge auto-scroll', () => {
  it('does not scroll in the middle of the viewport', () => {
    expect(autoScrollDelta(300, 100, 500)).toBe(0);
  });
  it('scrolls up near / above the top and down near / below the bottom, faster the further out', () => {
    expect(autoScrollDelta(110, 100, 500)).toBeLessThan(0);
    expect(autoScrollDelta(50, 100, 500)).toBeLessThan(autoScrollDelta(120, 100, 500));
    expect(autoScrollDelta(490, 100, 500)).toBeGreaterThan(0);
    expect(autoScrollDelta(560, 100, 500)).toBeGreaterThan(autoScrollDelta(470, 100, 500));
  });
  it('is capped', () => {
    expect(Math.abs(autoScrollDelta(-5000, 100, 500))).toBeLessThanOrEqual(22);
    expect(autoScrollDelta(5000, 100, 500)).toBeLessThanOrEqual(22);
  });
});

describe('how the hit set joins the selection', () => {
  it('a plain marquee replaces the selection', () => {
    expect(marqueePick(order, { ids: ['b1'], primary: 'b1' }, ['b3', 'b4'], false).ids).toEqual(['b3', 'b4']);
  });
  it('Ctrl / Shift adds to what was selected before the drag, in script order, without duplicates', () => {
    expect(marqueePick(order, { ids: ['b1', 'b5'], primary: 'b5' }, ['b3', 'b5'], true).ids).toEqual(['b1', 'b3', 'b5']);
  });
  it('adding with only a primary beat keeps that beat', () => {
    expect(marqueePick(order, { ids: [], primary: 'b2' }, ['b4'], true).ids).toEqual(['b2', 'b4']);
  });
  it('an empty plain marquee clears the multi-selection but keeps the primary beat', () => {
    expect(marqueePick(order, { ids: ['b1', 'b2'], primary: 'b2' }, [], false)).toEqual({ ids: [], primary: 'b2' });
  });
  it('ids that no longer exist are dropped', () => {
    expect(marqueePick(order, { ids: ['gone'], primary: null }, ['b2'], true).ids).toEqual(['b2']);
  });
  it('the primary beat becomes the last touched beat, or stays when nothing was touched', () => {
    expect(marqueePrimary(order, { ids: [], primary: 'b1' }, ['b4', 'b3'])).toBe('b4');
    expect(marqueePrimary(order, { ids: [], primary: 'b1' }, [])).toBe('b1');
    expect(marqueePrimary(order, { ids: [], primary: null }, [])).toBeNull();
  });
});
