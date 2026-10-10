import { z } from 'zod';

/** Per-background ground override (world = background pixels). Stored under data/backgrounds/<id>.json. */
export const GroundOverrideSchema = z
  .object({
    horizonY: z.number().min(0).max(4000),
    floorY: z.number().min(0).max(4000),
  })
  .refine((g) => g.floorY > g.horizonY, { message: 'floorY must be below horizonY' });
export type GroundOverride = z.infer<typeof GroundOverrideSchema>;

export const BACKGROUND_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
