import { z } from 'zod';

const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const Sign = z.union([z.literal(1), z.literal(-1), z.literal(0)]);

/**
 * Per-model probe result. All geometry is in model-local canvas pixels (origin top-left, y down),
 * i.e. before any container scale; the container scale is always positive (no flipping).
 */
export const CalibrationSchema = z.object({
  version: z.literal(1),
  modelId: z.string(),
  /** Bounding box of visible drawables in the default pose. */
  bounds: Rect,
  /** Ground contact point (bottom centre of the default-pose bounds). */
  ground: z.object({ x: z.number(), y: z.number() }),
  totalHeight: z.number(),
  head: z.object({
    bbox: Rect,
    center: z.object({ x: z.number(), y: z.number() }),
    /** "Head unit": height of the head bounding box. */
    height: z.number(),
  }),
  /** +1: a positive parameter value moves that part towards screen-right (model faces screen-right). 0: axis missing. */
  headSign: Sign,
  bodySign: Sign,
  eyeSign: Sign,
  hasEyeBallX: z.boolean(),
  /** true once a human confirmed the signs against the rendered L/R demo. */
  verified: z.boolean(),
  probedAt: z.string(),
});
export type Calibration = z.infer<typeof CalibrationSchema>;
export type AxisSigns = Pick<Calibration, 'headSign' | 'bodySign' | 'eyeSign'>;

export const MODEL_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
