import { z } from 'zod';

export const PACK_FILE = 'openotes-pack.json';

/**
 * Optional description of an asset pack (a zip or folder in this project's native layout:
 * `models/`, `backgrounds/`, `media/`, `manifest.json` at the root or inside one wrapper directory).
 * When present, the importer validates counts / sizes and, if `files` is given, every listed SHA-256.
 */
export const PackSchema = z.object({
  format: z.literal('openotes-pack'),
  version: z.literal(1),
  generatedAt: z.string(),
  generator: z.string().optional(),
  counts: z.object({ models: z.number().int().min(0), backgrounds: z.number().int().min(0), media: z.number().int().min(0) }),
  totalBytes: z.number().int().min(0),
  /** Paths are relative to the pack root, forward slashes. */
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).optional(),
});
export type Pack = z.infer<typeof PackSchema>;
