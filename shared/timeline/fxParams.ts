/**
 * Fixed numbers of the screen effects added in v0.4 (memory, dim, flash, shake, daze). They live here, not in the style presets: a style
 * value would be copied into `CompiledScene.ui` and so change the compiled JSON of every old project. Everything is a pure constant;
 * the effects are functions of the evaluated strengths only (no clock, no Math.random).
 */
import type { MemoryEdge, MemoryTone } from '../schema/project';

export const MEMORY_DEFAULT_TONE: MemoryTone = 'cool';
/** The maintainer's choice: the soft fog edge (the original's frame_fog) is the default, the white bands are an option. */
export const MEMORY_DEFAULT_EDGE: MemoryEdge = 'fog';

/** White bands (letterbox_white): 70/1080 of the height, 85 % white, hard edge. */
export const MEMORY_BAND_H = 0.065;
export const MEMORY_BAND_ALPHA = 0.85;

/**
 * Fog edge (frame_fog): alpha = a0 * (1 - smoothstep(0, 1, d/D))^1.3 * (1 + 1.1 (n - 0.5)), with d the distance to the nearest edge, n a static fbm noise
 * (cloud-like undulation of about +-40 % along the edge, measured). Depth D: top / bottom 15 % of the height, sides 10.5 % of the width.
 */
export const MEMORY_FOG_DEPTH_V = 0.15;
export const MEMORY_FOG_DEPTH_H = 0.105;
export const MEMORY_FOG_ALPHA_V = 0.6;
export const MEMORY_FOG_ALPHA_H = 0.7;
export const MEMORY_FOG_POWER = 1.3;
export const MEMORY_FOG_UNDULATION = 1.1;

/** Dim (the inner-voice darkening, the original's brightness 0.5): the scene (not the dialogue, HUD or banner) is multiplied by 1 - level * strength. */
export const DIM_LEVEL = 0.5;

/** Flash (a white fade up to FLASH_PEAK in FLASH_RISE seconds and back down; FLASH_SECONDS is the length when the key has none). */
export const FLASH_PEAK = 0.85;
export const FLASH_RISE = 0.08;
export const FLASH_SECONDS = 0.8;

/** Shake (the original's 0.5 s shake): amplitude = strength * SHAKE_AMPLITUDE * stage height, decaying as exp(-SHAKE_DECAY * progress). */
export const SHAKE_AMPLITUDE = 0.02;
export const SHAKE_DECAY = 3;
export const SHAKE_SECONDS = 0.5;

/** Daze (the original's full-screen blur, DoF focus 0.1 m): blur radius share of the stage height at strength 1, the saturation it takes away, the eyelid feather. */
export const DAZE_BLUR = 20 / 1080;
export const DAZE_DESAT = 0.2;
export const DAZE_LID_FEATHER = 0.15;

/** The background is blurred a little while a memory is on (share of the stage height; reuses the background's own blur). */
export const MEMORY_BG_BLUR = 2.5 / 1080;

/** Dip through white (a strong light, into / out of a memory): longer than the black blink, as in the original (about 1 s of white in all). */
export const DIP_WHITE = { out: 0.5, hold: 0.1, in: 0.5 } as const;
