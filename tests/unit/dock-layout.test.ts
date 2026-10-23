import { describe, expect, it } from 'vitest';
import { LAYOUT_KEY, LAYOUT_VERSION, PANEL_IDS, PRESETS, REQUIRED, SHOW_PLACEMENT, forgetLayout, loadSavedLayout, parseSavedLayout, presetProblems, resolvePlacement, saveLayout, serializeLayout, type PanelId } from '../../web/editor/dock/layoutModel';

const leaf = (id: string, views: string[]) => ({ type: 'leaf', data: { id, views, activeView: views[0] }, size: 100 });
const panels = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { id, contentComponent: id, title: id }]));
const layoutOf = (ids: string[], root: unknown = { type: 'branch', data: ids.map((id, i) => leaf(`g${i}`, [id])) }) => ({ grid: { root, width: 1200, height: 800, orientation: 'HORIZONTAL' }, panels: panels(ids) });
const raw = (layout: unknown) => serializeLayout(layout);
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

describe('presets', () => {
  it('every preset is consistent: references come first, ids are unique, the required panels are in', () => {
    for (const p of PRESETS) expect(presetProblems(p), p.id).toEqual([]);
  });
  it('the AI-work preset puts the script, the stage and the assistant side by side', () => {
    const p = PRESETS.find((x) => x.id === 'ai-work')!;
    const at = (id: PanelId) => p.placements.find((x) => x.id === id)!;
    expect(at('sidebar')).toMatchObject({ ref: 'stage', dir: 'left' });
    expect(at('agent')).toMatchObject({ ref: 'stage', dir: 'right' });
  });
  it('flags a broken preset', () => {
    expect(presetProblems({ id: 'x', label: 'x', hint: '', placements: [{ id: 'stage' }, { id: 'sidebar', ref: 'agent', dir: 'left' }] }).length).toBeGreaterThan(0);
  });
  it('every panel has a place to be shown again', () => {
    for (const id of PANEL_IDS) expect(SHOW_PLACEMENT[id].id).toBe(id);
  });
});

describe('resolvePlacement: where a panel goes in the layout that exists now', () => {
  const set = (...ids: PanelId[]) => new Set<PanelId>(ids);
  it('uses the reference when it is present', () => {
    expect(resolvePlacement(SHOW_PLACEMENT.agent, set('stage', 'timeline'))).toEqual({ kind: 'panel', ref: 'stage', dir: 'right' });
  });
  it('falls back to the first present panel when the reference is gone', () => {
    expect(resolvePlacement(SHOW_PLACEMENT.agent, set('timeline'))).toEqual({ kind: 'panel', ref: 'timeline', dir: 'right' });
  });
  it('an edge placement stays at the window edge', () => {
    expect(resolvePlacement(SHOW_PLACEMENT.timeline, set('stage'))).toEqual({ kind: 'edge', dir: 'below' });
  });
  it('the first panel of an empty layout has no neighbour', () => {
    expect(resolvePlacement(SHOW_PLACEMENT.stage, set())).toEqual({ kind: 'first' });
  });
});

describe('saved layout: parsing and fallback', () => {
  const ok = layoutOf(['sidebar', 'stage', 'timeline']);
  it('accepts a valid layout (a closed optional panel is fine)', () => {
    expect(parseSavedLayout(raw(ok))).toEqual(ok);
    expect(parseSavedLayout(raw(layoutOf([...PANEL_IDS])))).not.toBeNull();
  });
  it('accepts panels grouped as tabs', () => {
    const root = { type: 'branch', data: [leaf('a', ['stage', 'storyboard']), leaf('b', ['timeline'])] };
    expect(parseSavedLayout(raw(layoutOf(['stage', 'storyboard', 'timeline'], root)))).not.toBeNull();
  });
  it('rejects junk, other versions and wrong shapes', () => {
    for (const bad of [null, undefined, '', 'not json', '{}', '[]', '{"v":1}', JSON.stringify({ v: LAYOUT_VERSION + 1, layout: ok }), JSON.stringify({ v: LAYOUT_VERSION, layout: 5 })]) expect(parseSavedLayout(bad as string | null), String(bad)).toBeNull();
  });
  it('rejects a layout with a panel that no longer exists', () => {
    expect(parseSavedLayout(raw(layoutOf(['stage', 'timeline', 'removedPanel'])))).toBeNull();
  });
  it('rejects a layout that lacks a required panel', () => {
    for (const r of REQUIRED) expect(parseSavedLayout(raw(layoutOf(PANEL_IDS.filter((x) => x !== r)))), r).toBeNull();
  });
  it('rejects a panel placed twice, a placed panel without a record, or a record that is not placed', () => {
    const twice = layoutOf(['stage', 'timeline'], { type: 'branch', data: [leaf('a', ['stage', 'timeline']), leaf('b', ['stage'])] });
    expect(parseSavedLayout(raw(twice))).toBeNull();
    const unplaced = layoutOf(['stage', 'timeline', 'agent'], { type: 'branch', data: [leaf('a', ['stage']), leaf('b', ['timeline'])] });
    expect(parseSavedLayout(raw(unplaced))).toBeNull();
    const norecord = layoutOf(['stage', 'timeline'], { type: 'branch', data: [leaf('a', ['stage']), leaf('b', ['timeline']), leaf('c', ['agent'])] });
    expect(parseSavedLayout(raw(norecord))).toBeNull();
  });
  it('rejects a broken grid and floating groups', () => {
    expect(parseSavedLayout(raw(layoutOf(['stage', 'timeline'], { type: 'leaf', data: { views: [] } })))).toBeNull();
    expect(parseSavedLayout(raw(layoutOf(['stage', 'timeline'], { type: 'wat' })))).toBeNull();
    expect(parseSavedLayout(raw({ ...ok, floatingGroups: [{ data: {} }] }))).toBeNull();
    expect(parseSavedLayout(raw({ ...ok, grid: { ...ok.grid, width: 0 } }))).toBeNull();
  });
});

describe('saved layout: storage access never throws', () => {
  const layout = layoutOf(['sidebar', 'stage', 'timeline']);
  it('round-trips through storage and can be forgotten', () => {
    const s = memory();
    saveLayout(layout, s);
    expect(s.m.has(LAYOUT_KEY)).toBe(true);
    expect(loadSavedLayout(s)).toEqual(layout);
    forgetLayout(s);
    expect(loadSavedLayout(s)).toBeNull();
  });
  it('a corrupt entry falls back to null', () => {
    const s = memory();
    s.setItem(LAYOUT_KEY, '{"v":1,"layout":{"grid":');
    expect(loadSavedLayout(s)).toBeNull();
  });
  it('blocked storage (every call throws) is harmless', () => {
    const boom = () => {
      throw new Error('blocked');
    };
    const s = { getItem: boom, setItem: boom, removeItem: boom };
    expect(() => saveLayout(layout, s)).not.toThrow();
    expect(() => forgetLayout(s)).not.toThrow();
    expect(loadSavedLayout(s)).toBeNull();
    expect(loadSavedLayout(null)).toBeNull();
  });
});
