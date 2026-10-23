/**
 * The dock layout, as pure data: the panels, the presets (lists of placements), the persisted-layout validation and the
 * placement fallback. Nothing here touches dockview or the DOM, so it is unit-tested on its own; `Dock.tsx` applies it.
 */

export const PANEL_IDS = ['sidebar', 'stage', 'storyboard', 'agent', 'inspector', 'timeline'] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const isPanelId = (v: unknown): v is PanelId => typeof v === 'string' && (PANEL_IDS as readonly string[]).includes(v);

export const PANEL_TITLE: Record<PanelId, string> = {
  sidebar: '剧本 · 素材 · AI 导演',
  stage: '预览',
  storyboard: '分镜',
  agent: 'AI 助手',
  inspector: '检查器',
  timeline: '时间线',
};

/** Panels that cannot be closed (and that a saved layout must contain): the stage and the timeline are the editor itself. */
export const REQUIRED: readonly PanelId[] = ['stage', 'timeline'];

/** Smallest size of a panel (px); the dock never shrinks a group below it. */
export const PANEL_MIN: Record<PanelId, { w: number; h: number }> = {
  sidebar: { w: 180, h: 120 },
  stage: { w: 400, h: 200 },
  storyboard: { w: 300, h: 160 },
  agent: { w: 220, h: 160 },
  inspector: { w: 200, h: 120 },
  timeline: { w: 300, h: 100 },
};

export type Dir = 'left' | 'right' | 'above' | 'below' | 'within';

/** One panel to add. `ref` = relative to that panel (`dir` defaults to 'within'); without `ref`, `dir` is an edge of the whole window. */
export interface Placement {
  id: PanelId;
  ref?: PanelId;
  dir?: Dir;
  /** initial size of the new group, px */
  w?: number;
  h?: number;
  /** add without activating (a background tab) */
  inactive?: boolean;
}

export interface Preset {
  id: string;
  label: string;
  hint: string;
  placements: Placement[];
}

export const PRESETS: Preset[] = [
  {
    id: 'default',
    label: '默认布局',
    hint: '剧本在左，预览居中（与分镜同一组标签），检查器在右，时间线在底部',
    placements: [
      { id: 'stage' },
      { id: 'storyboard', ref: 'stage', dir: 'within', inactive: true },
      { id: 'sidebar', ref: 'stage', dir: 'left', w: 320 },
      { id: 'inspector', ref: 'stage', dir: 'right', w: 340 },
      { id: 'timeline', dir: 'below', h: 290 },
    ],
  },
  {
    id: 'ai-work',
    label: 'AI 工作',
    hint: '剧本、预览、AI 助手并排；检查器与助手同组；时间线收窄',
    placements: [
      { id: 'stage' },
      { id: 'storyboard', ref: 'stage', dir: 'within', inactive: true },
      { id: 'sidebar', ref: 'stage', dir: 'left', w: 380 },
      { id: 'agent', ref: 'stage', dir: 'right', w: 400 },
      { id: 'inspector', ref: 'agent', dir: 'within', inactive: true },
      { id: 'timeline', dir: 'below', h: 200 },
    ],
  },
  {
    id: 'storyboard',
    label: '分镜审阅',
    hint: '分镜占据中央，预览和检查器叠放在右侧',
    placements: [
      { id: 'storyboard' },
      { id: 'sidebar', ref: 'storyboard', dir: 'left', w: 300 },
      { id: 'stage', ref: 'storyboard', dir: 'right', w: 520 },
      { id: 'inspector', ref: 'stage', dir: 'below', h: 300 },
      { id: 'timeline', dir: 'below', h: 200 },
    ],
  },
];

export const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;

/** Where a single panel goes when it is shown again (top-bar toggles, the layout menu), if the layout has the neighbour. */
export const SHOW_PLACEMENT: Record<PanelId, Placement> = {
  sidebar: { id: 'sidebar', ref: 'stage', dir: 'left', w: 320 },
  stage: { id: 'stage' },
  storyboard: { id: 'storyboard', ref: 'stage', dir: 'within' },
  agent: { id: 'agent', ref: 'stage', dir: 'right', w: 340 },
  inspector: { id: 'inspector', ref: 'stage', dir: 'right', w: 340 },
  timeline: { id: 'timeline', dir: 'below', h: 290 },
};

export type Target = { kind: 'panel'; ref: PanelId; dir: Dir } | { kind: 'edge'; dir: Exclude<Dir, 'within'> } | { kind: 'first' };

/** Resolves a placement against the panels that exist now: its reference if present, otherwise any present panel, otherwise the window edge / first. */
export function resolvePlacement(p: Placement, present: ReadonlySet<PanelId>): Target {
  if (p.ref && present.has(p.ref)) return { kind: 'panel', ref: p.ref, dir: p.dir ?? 'within' };
  if (present.size === 0) return { kind: 'first' };
  if (!p.ref && p.dir && p.dir !== 'within') return { kind: 'edge', dir: p.dir };
  // reference gone: dock next to the first panel that is there, on the same side
  const any = PANEL_IDS.find((x) => present.has(x))!;
  return { kind: 'panel', ref: any, dir: p.dir ?? 'within' };
}

/** A preset is consistent when every reference was added before it, ids are unique and the required panels are in. */
export function presetProblems(p: Preset): string[] {
  const out: string[] = [];
  const seen = new Set<PanelId>();
  p.placements.forEach((pl, i) => {
    if (seen.has(pl.id)) out.push(`${pl.id} listed twice`);
    if (pl.ref && !seen.has(pl.ref)) out.push(`${pl.id} refers to ${pl.ref} before it exists`);
    if (!pl.ref && i > 0 && (!pl.dir || pl.dir === 'within')) out.push(`${pl.id} has no place`);
    seen.add(pl.id);
  });
  for (const r of REQUIRED) if (!seen.has(r)) out.push(`${r} missing`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- persistence

export const LAYOUT_KEY = 'studio.dock.layout';
export const LAYOUT_VERSION = 1;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Collects the panel ids of every leaf; false when the tree is malformed. */
function leafViews(node: unknown, out: string[], depth = 0): boolean {
  if (!isObj(node) || depth > 24) return false;
  if (node.type === 'leaf') {
    const data = node.data;
    if (!isObj(data) || !Array.isArray(data.views) || data.views.length === 0) return false;
    for (const v of data.views) {
      if (typeof v !== 'string') return false;
      out.push(v);
    }
    return true;
  }
  if (node.type === 'branch') {
    const data = node.data;
    if (!Array.isArray(data) || data.length === 0) return false;
    return data.every((c) => leafViews(c, out, depth + 1));
  }
  return false;
}

/**
 * Parses a persisted layout. Returns the layout object to hand to `fromJSON`, or null when it is unusable: not JSON, another
 * version, a panel that no longer exists, a required panel missing, a panel in two places or in none, or a broken grid.
 * (Whether dockview itself accepts it is checked by trying; the caller falls back to the default preset on a throw.)
 */
export function parseSavedLayout(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(parsed) || parsed.v !== LAYOUT_VERSION || !isObj(parsed.layout)) return null;
  const layout = parsed.layout;
  const grid = layout.grid;
  const panels = layout.panels;
  if (!isObj(grid) || !isObj(panels)) return null;
  if (typeof grid.width !== 'number' || typeof grid.height !== 'number' || !(grid.width > 0) || !(grid.height > 0)) return null;
  if (Array.isArray(layout.floatingGroups) && layout.floatingGroups.length > 0) return null;
  if (Array.isArray(layout.popoutGroups) && layout.popoutGroups.length > 0) return null;
  const ids = Object.keys(panels);
  for (const id of ids) {
    const p = panels[id];
    if (!isPanelId(id) || !isObj(p) || p.id !== id) return null;
  }
  for (const r of REQUIRED) if (!ids.includes(r)) return null;
  const views: string[] = [];
  if (!leafViews(grid.root, views)) return null;
  if (new Set(views).size !== views.length) return null;
  if (views.length !== ids.length || !views.every((v) => ids.includes(v))) return null;
  return layout;
}

export function serializeLayout(layout: unknown): string {
  return JSON.stringify({ v: LAYOUT_VERSION, layout });
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

/** localStorage may be missing or throw (private window, blocked site data): every access is guarded. */
export function loadSavedLayout(s: Store | null = defaultStore()): Record<string, unknown> | null {
  try {
    return parseSavedLayout(s?.getItem(LAYOUT_KEY));
  } catch {
    return null;
  }
}
export function saveLayout(layout: unknown, s: Store | null = defaultStore()): void {
  try {
    s?.setItem(LAYOUT_KEY, serializeLayout(layout));
  } catch {
    /* the layout just is not remembered */
  }
}
export function forgetLayout(s: Store | null = defaultStore()): void {
  try {
    s?.removeItem(LAYOUT_KEY);
  } catch {
    /* nothing to forget */
  }
}
