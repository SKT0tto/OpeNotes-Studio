/** Pure helpers for the hub (title screen) Live2D character: model choice, placement maths, persistence, click-vs-drag and reactions. */
import type { CompactCatalog, CompactModel, ExpressionEntry, MotionEntry } from '@shared/schema/assets';
import { MODEL_ID_RE } from '@shared/schema/calibration';

export const DEFAULT_HUB_MODEL = '001_casual_spring_01';
export const HUB_CHARACTER_KEY = 'openotes.hub.character.v1';

/**
 * Where the character stands, in fractions of the stage so it survives resizes:
 * `x` = the model's ground point (horizontal centre), `y` = the top of its visible bounds, `scale` = multiplier on the default size.
 */
export interface HubPlacement {
  x: number;
  y: number;
  scale: number;
}

/** `model`: undefined = default model, null = 不显示角色, string = the chosen model id. */
export interface HubCharacterPrefs extends HubPlacement {
  model?: string | null;
}

export const DEFAULT_PLACEMENT: HubPlacement = { x: 0.74, y: 0.07, scale: 1 };
export const SCALE_MIN = 0.45;
export const SCALE_MAX = 2.2;
/** The default on-screen height of the model, relative to the stage height (legs run off the bottom like a title screen). */
export const BASE_HEIGHT = 1.32;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep the character reachable: its centre stays on stage and at least its head (or its feet) stays visible. */
export function clampPlacement(p: HubPlacement): HubPlacement {
  const scale = clamp(Number.isFinite(p.scale) ? p.scale : 1, SCALE_MIN, SCALE_MAX);
  const height = BASE_HEIGHT * scale; // model height in stage heights
  return {
    x: clamp(Number.isFinite(p.x) ? p.x : DEFAULT_PLACEMENT.x, 0.04, 0.96),
    // top no lower than 85% of the stage (head visible); bottom no higher than 15% of the stage (feet visible)
    y: clamp(Number.isFinite(p.y) ? p.y : DEFAULT_PLACEMENT.y, Math.min(0, 0.15 - height), 0.85),
    scale,
  };
}

/** Read stored prefs; anything malformed falls back to the defaults. */
export function parsePrefs(raw: string | null | undefined): HubCharacterPrefs {
  if (!raw) return { ...DEFAULT_PLACEMENT };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PLACEMENT };
  }
  if (!v || typeof v !== 'object') return { ...DEFAULT_PLACEMENT };
  const o = v as Record<string, unknown>;
  const num = (k: keyof HubPlacement) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : DEFAULT_PLACEMENT[k]);
  const out: HubCharacterPrefs = clampPlacement({ x: num('x'), y: num('y'), scale: num('scale') });
  if (o.model === null) out.model = null;
  else if (typeof o.model === 'string' && MODEL_ID_RE.test(o.model)) out.model = o.model;
  return out;
}

export function serializePrefs(p: HubCharacterPrefs): string {
  const c = clampPlacement(p);
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return JSON.stringify({ ...(p.model !== undefined ? { model: p.model } : {}), x: round(c.x), y: round(c.y), scale: round(c.scale) });
}

/** A press that barely moved and was short is a click (a reaction); anything else is a drag. */
export function isClick(dx: number, dy: number, ms: number, threshold = 6): boolean {
  return Math.hypot(dx, dy) < threshold && ms < 700;
}

/** Move by a pixel delta on a stage of `w` × `h`. */
export function dragBy(p: HubPlacement, dx: number, dy: number, w: number, h: number): HubPlacement {
  return clampPlacement({ ...p, x: p.x + dx / Math.max(1, w), y: p.y + dy / Math.max(1, h) });
}

/** Scale by `factor`, keeping the stage point (px, py) under the pointer fixed. */
export function zoomAt(p: HubPlacement, factor: number, px: number, py: number, w: number, h: number): HubPlacement {
  const next = clampPlacement({ ...p, scale: p.scale * factor });
  const k = next.scale / p.scale;
  const ax = p.x * w;
  const ay = p.y * h;
  return clampPlacement({ scale: next.scale, x: (px - (px - ax) * k) / Math.max(1, w), y: (py - (py - ay) * k) / Math.max(1, h) });
}

/** Animated, full-quality ADV models (the ones that can idle on the title screen). */
export function usableHubModels(catalog: CompactCatalog): CompactModel[] {
  return catalog.models.filter((m) => m.mode === 'adv' && !m.still && m.quality === '' && m.motionCount > 0);
}

/** The model to show: the stored choice when it still exists, else the default, else the first usable main-cast model. */
export function resolveHubModel(catalog: CompactCatalog, pref: string | null | undefined): string | null {
  if (pref === null) return null;
  const usable = usableHubModels(catalog);
  if (pref && catalog.models.some((m) => m.id === pref)) return pref;
  const rank = (base: string) => (base === 'casual' ? 0 : base === 'school' ? 1 : 2);
  return usable.find((m) => m.id === DEFAULT_HUB_MODEL)?.id ?? [...usable].filter((m) => !m.isSub).sort((a, b) => rank(a.costumeInfo.base) - rank(b.costumeInfo.base))[0]?.id ?? null;
}

export type HitZone = 'head' | 'body' | null;

/** Hit-area names from model3.json (`Head`, `Body`, `HitAreaHead`, …) to a zone. */
export function hitZone(names: readonly string[]): HitZone {
  if (names.some((n) => /head|face/i.test(n))) return 'head';
  if (names.some((n) => /body|bust|chest/i.test(n))) return 'body';
  return null;
}

const MOTION_STEMS: Record<'head' | 'body', string[]> = { head: ['nod', 'smile', 'surprised', 'question', 'kime'], body: ['surprised', 'nervous', 'denial', 'angry', 'question'] };
const EXPRESSION_FAMILIES: Record<'head' | 'body', string[]> = { head: ['smile', 'shy', 'surprised', 'grinning'], body: ['shy', 'surprised', 'angry', 'bsmile'] };
const stem = (family: string) => family.replace(/\d+$/, '').replace(/_$/, '');

/** Reaction candidates the model actually has, preferring front-facing (side C / none) motions. */
export function reactionPool(motions: readonly MotionEntry[], expressions: readonly ExpressionEntry[], zone: HitZone): { motions: string[]; expressions: string[] } {
  const zones = zone ? [zone] : (['head', 'body'] as const);
  const wantM = new Set(zones.flatMap((z) => MOTION_STEMS[z]));
  const wantE = new Set(zones.flatMap((z) => EXPRESSION_FAMILIES[z]));
  const candidates = motions.filter((m) => wantM.has(stem(m.family)));
  const front = candidates.filter((m) => m.side === 'C' || m.side === null);
  return { motions: (front.length ? front : candidates).map((m) => m.name), expressions: expressions.filter((e) => wantE.has(e.family)).map((e) => e.name) };
}

/** Choose one motion and/or one expression (at least one when the model has any). `rand` is injectable for tests. */
export function pickReaction(pool: { motions: string[]; expressions: string[] }, rand: () => number = Math.random): { motion: string | null; expression: string | null } {
  const pick = (a: string[]) => (a.length ? a[Math.min(a.length - 1, Math.floor(rand() * a.length))]! : null);
  return { motion: pick(pool.motions), expression: pick(pool.expressions) };
}
