import { describe, expect, it } from 'vitest';
import { LAYOUT_KEY, LAYOUT_VERSION, LEGACY_PANEL_ALIASES, PANEL_IDS, PANEL_TITLE, PRESETS, REQUIRED, SHOW_PLACEMENT, aiRestorePlacement, forgetLayout, loadMigratedLayout, loadSavedLayout, migrateLayout, parseSavedLayout, presetProblems, resolvePlacement, saveLayout, serializeLayout, type PanelId } from '../../web/editor/dock/layoutModel';

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

describe('the AI panel: one panel for the AI director and the assistant', () => {
  it('is titled 「AI」 and the left group no longer names the director', () => {
    expect(PANEL_TITLE.agent).toBe('AI');
    expect(PANEL_TITLE.sidebar).not.toContain('AI');
  });
  it('every preset has the AI panel, so the director is never out of reach (the default one is a background tab next to the inspector)', () => {
    for (const p of PRESETS) expect(p.placements.some((x) => x.id === 'agent'), p.id).toBe(true);
    const dflt = PRESETS.find((x) => x.id === 'default')!;
    expect(dflt.placements.find((x) => x.id === 'agent')).toMatchObject({ ref: 'inspector', dir: 'within', inactive: true });
    const work = PRESETS.find((x) => x.id === 'ai-work')!;
    expect(work.placements.find((x) => x.id === 'agent')).toMatchObject({ ref: 'stage', dir: 'right' });
    expect(work.placements.find((x) => x.id === 'agent')!.inactive).toBeUndefined(); // the AI-work preset shows it
  });
});

describe('saved layout: migration from the layout of the two separate AI panels (version 1)', () => {
  const v1 = (layout: unknown) => JSON.stringify({ v: 1, layout });
  const base = ['sidebar', 'stage', 'inspector', 'timeline'];

  it('a version-1 layout without the assistant loads, and asks for the AI panel (the left 「AI 导演」 tab is gone)', () => {
    const r = migrateLayout(v1(layoutOf(base)));
    expect(r).not.toBeNull();
    expect(r!.needsAiPanel).toBe(true);
    expect(parseSavedLayout(v1(layoutOf(base)))).not.toBeNull();
  });
  it('a version-1 layout that already has the assistant panel keeps it where it was; nothing to add', () => {
    const r = migrateLayout(v1(layoutOf([...base, 'agent'])));
    expect(r!.needsAiPanel).toBe(false);
    expect(Object.keys((r!.layout.panels as Record<string, unknown>)).sort()).toEqual([...base, 'agent'].sort());
  });
  it('a current layout without the AI panel is the person closing it: it is not added back', () => {
    const r = migrateLayout(raw(layoutOf(base)));
    expect(r!.needsAiPanel).toBe(false);
  });
  it('legacy panel ids are renamed to the AI panel instead of rejecting the layout (records, leaf views, active view, no duplicates)', () => {
    expect(LEGACY_PANEL_ALIASES.ai).toBe('agent');
    for (const legacy of Object.keys(LEGACY_PANEL_ALIASES)) {
      const root = { type: 'branch', data: [leaf('g0', ['sidebar']), leaf('g1', ['stage']), { type: 'leaf', data: { id: 'g2', views: ['inspector', legacy], activeView: legacy }, size: 100 }, leaf('g3', ['timeline'])] };
      const r = migrateLayout(v1(layoutOf([...base, legacy], root)));
      expect(r, legacy).not.toBeNull();
      const layout = r!.layout as { panels: Record<string, { id: string; title: string }>; grid: { root: { data: Array<{ data: { views: string[]; activeView?: string } }> } } };
      expect(Object.keys(layout.panels).sort()).toEqual([...base, 'agent'].sort());
      expect(layout.panels.agent!.id).toBe('agent');
      expect(layout.panels.agent!.title).toBe(PANEL_TITLE.agent);
      expect(layout.grid.root.data[2]!.data).toMatchObject({ views: ['inspector', 'agent'], activeView: 'agent' });
      expect(r!.needsAiPanel, legacy).toBe(false);
    }
  });
  it('a legacy id next to the real one leaves one panel, not two', () => {
    const root = { type: 'branch', data: [leaf('g0', ['sidebar']), leaf('g1', ['stage']), leaf('g2', ['inspector', 'agent', 'ai']), leaf('g3', ['timeline'])] };
    const r = migrateLayout(raw(layoutOf([...base, 'agent', 'ai'], root)));
    expect(r).not.toBeNull();
    expect(Object.keys((r!.layout.panels as Record<string, unknown>)).sort()).toEqual([...base, 'agent'].sort());
  });
  it('a panel that never existed still rejects the layout (the default layout is used)', () => {
    expect(migrateLayout(v1(layoutOf([...base, 'removedPanel'])))).toBeNull();
    expect(migrateLayout(JSON.stringify({ v: 3, layout: layoutOf(base) }))).toBeNull();
    expect(migrateLayout(JSON.stringify({ v: 0, layout: layoutOf(base) }))).toBeNull();
  });
  it('is read from storage the same way, and written back as the current version', () => {
    const s = memory();
    s.setItem(LAYOUT_KEY, v1(layoutOf(base)));
    expect(loadMigratedLayout(s)!.needsAiPanel).toBe(true);
    expect(loadSavedLayout(s)).not.toBeNull();
    saveLayout(loadSavedLayout(s), s);
    expect(JSON.parse(s.m.get(LAYOUT_KEY)!).v).toBe(LAYOUT_VERSION);
    expect(loadMigratedLayout(s)!.needsAiPanel).toBe(false);
  });
  it('where the AI panel is added: a background tab next to the inspector, else a column right of the stage', () => {
    const set = (...ids: PanelId[]) => new Set<PanelId>(ids);
    expect(aiRestorePlacement(set('stage', 'inspector', 'timeline'))).toMatchObject({ id: 'agent', ref: 'inspector', dir: 'within', inactive: true });
    expect(aiRestorePlacement(set('stage', 'timeline'))).toMatchObject({ id: 'agent', ref: 'stage', dir: 'right', inactive: true });
    // both resolve against the layout that exists
    expect(resolvePlacement(aiRestorePlacement(set('stage', 'inspector')), set('stage', 'inspector'))).toEqual({ kind: 'panel', ref: 'inspector', dir: 'within' });
    expect(resolvePlacement(aiRestorePlacement(set('stage')), set('stage'))).toEqual({ kind: 'panel', ref: 'stage', dir: 'right' });
  });
});
