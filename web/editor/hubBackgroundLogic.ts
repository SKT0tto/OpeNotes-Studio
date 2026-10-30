/** Pure helpers for the title-screen background choice: stored preference, fallback to 自动, dimming. */
import { BACKGROUND_ID_RE } from '@shared/schema/ground';

export const HUB_BACKGROUND_KEY = 'openotes.hub.background.v1';
export const HUB_BG_MODES = ['auto', 'asset', 'image', 'gradient'] as const;
export type HubBgMode = (typeof HUB_BG_MODES)[number];
export const DIM_MAX = 0.6;

export interface HubBackgroundPrefs {
  mode: HubBgMode;
  /** Background id when `mode` is 'asset'. */
  asset?: string;
  /** Extra darkening over the picture, 0 (today's look) to DIM_MAX. */
  dim: number;
}

export const DEFAULT_BACKGROUND_PREFS: HubBackgroundPrefs = { mode: 'auto', dim: 0 };

const clampDim = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(DIM_MAX, Math.max(0, v)) * 100) / 100 : 0);

/** Read stored prefs; anything malformed falls back to 自动 with no extra dimming. */
export function parseBackgroundPrefs(raw: string | null | undefined): HubBackgroundPrefs {
  if (!raw) return { ...DEFAULT_BACKGROUND_PREFS };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_BACKGROUND_PREFS };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_BACKGROUND_PREFS };
  const o = v as Record<string, unknown>;
  const dim = clampDim(o.dim);
  const mode = HUB_BG_MODES.find((m) => m === o.mode);
  if (!mode) return { mode: 'auto', dim };
  if (mode === 'asset') return typeof o.asset === 'string' && BACKGROUND_ID_RE.test(o.asset) ? { mode, asset: o.asset, dim } : { mode: 'auto', dim };
  return { mode, dim };
}

export function serializeBackgroundPrefs(p: HubBackgroundPrefs): string {
  return JSON.stringify({ mode: p.mode, ...(p.mode === 'asset' && p.asset ? { asset: p.asset } : {}), dim: clampDim(p.dim) });
}

export interface HubImageInfo { exists: boolean; version?: string }

export type HubBackgroundChoice =
  | { kind: 'auto' }
  | { kind: 'gradient' }
  /** `url` is null while the catalogue / image info is still loading: show the gradient meanwhile (no layout shift, no flash of 自动). */
  | { kind: 'asset' | 'image'; url: string | null };

export const hubImageUrl = (info: HubImageInfo) => `/api/hub/background/image?v=${encodeURIComponent(info.version ?? '0')}`;

/**
 * What to show. A choice whose source is gone (library changed, file deleted) silently becomes 自动.
 * `backgrounds` / `image` are null while still loading.
 */
export function resolveHubBackground(
  prefs: HubBackgroundPrefs,
  backgrounds: ReadonlyArray<{ id: string; url: string }> | null,
  image: HubImageInfo | null,
): HubBackgroundChoice {
  if (prefs.mode === 'gradient') return { kind: 'gradient' };
  if (prefs.mode === 'asset') {
    if (!backgrounds) return { kind: 'asset', url: null };
    const hit = backgrounds.find((b) => b.id === prefs.asset);
    return hit ? { kind: 'asset', url: hit.url } : { kind: 'auto' };
  }
  if (prefs.mode === 'image') {
    if (!image) return { kind: 'image', url: null };
    return image.exists ? { kind: 'image', url: hubImageUrl(image) } : { kind: 'auto' };
  }
  return { kind: 'auto' };
}

/**
 * The preference as it really applies: a choice whose source is gone (the personal picture was deleted, the library background vanished)
 * is 自动, so the menu's check mark follows what is on screen. Nothing changes while the sources are still loading (null).
 */
export function effectiveBackgroundPrefs(
  prefs: HubBackgroundPrefs,
  backgrounds: ReadonlyArray<{ id: string; url: string }> | null,
  image: HubImageInfo | null,
): HubBackgroundPrefs {
  if (prefs.mode !== 'asset' && prefs.mode !== 'image') return prefs;
  return resolveHubBackground(prefs, backgrounds, image).kind === 'auto' ? { mode: 'auto', dim: prefs.dim } : prefs;
}
