/** Background labels: which bands may use a background (bands / residents / exclusive), where it is, whether it is a stage. */
import { z } from 'zod';

export const BG_ACCESS = ['public', 'school', 'band', 'private', 'abstract'] as const;
export const BG_CONFIDENCE = ['confirmed', 'likely', 'unknown'] as const;
export const GENERIC_BAND = 'generic';
export const BG_CATEGORIES = ['scene', 'insert', 'decor', 'event'] as const;
export type BgCategory = (typeof BG_CATEGORIES)[number];

/** One pending review suggestion: `field` is what it is about (name, placeType, owner ...), `question` marks a doubt that has no one-click fix. */
export const BgFixSchema = z.object({
  field: z.string(),
  current: z.string().optional(),
  suggest: z.string().optional(),
  question: z.string().optional(),
  reason: z.string().optional(),
});
export type BgFix = z.infer<typeof BgFixSchema>;

export const BgLabelSchema = z.object({
  /** Band keys that may use it; ["generic"] = anyone; [] = unknown (never chosen automatically unless the rules allow). */
  bands: z.array(z.string()),
  /** Soft preference only: bands for which this is the home ground. */
  affinity: z.array(z.string()).optional(),
  access: z.enum(BG_ACCESS),
  placeType: z.string(),
  placeName: z.string().nullable(),
  indoor: z.enum(['indoor', 'outdoor', 'abstract', 'screen']),
  time: z.enum(['day', 'dusk', 'night', 'unspecified']),
  stage: z.boolean(),
  confidence: z.enum(BG_CONFIDENCE),
  evidence: z.string(),
  question: z.string().nullable().optional(),
  location: z.string().nullable(),
  /** Display name of the owner of a private home. */
  owner: z.string().nullable(),
  ownerKey: z.string().nullable().optional(),
  /** Characters who live there: a private home is used only when one of them is on stage (or is the host of a visit). */
  residents: z.array(z.string()).optional(),
  /** Hard constraint: only the bands in `bands` may use it as home ground. */
  exclusive: z.boolean(),
  homeBand: z.string().nullable(),
  answer: z.string().optional(),
  students: z.array(z.string()).optional(),
  /** Usage conditions: when set, the background is only a candidate if the scene's mood/activity match (rarity 'rare' = seldom used). */
  usage: z.object({ moods: z.array(z.string()), activity: z.enum(['singing', 'sleeping', 'studying', 'streaming']).nullable(), rarity: z.enum(['common', 'rare']) }).optional(),
  /** P20: what the picture shows. `title` (unique, short) wins over `nameOverride` and the manifest name. */
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** scene = story background; insert = cut-away only (sky, signal, crossing); decor = logo / plain colour / UI (never chosen automatically); event = dream, virtual stage ... */
  category: z.enum(BG_CATEGORIES).optional(),
  /** Id of the master copy when this is a lower-resolution duplicate of the same picture. */
  duplicateOf: z.string().nullable().optional(),
  /** Review suggestions imported from the content pass. NEVER applied automatically; the workbench accepts / rejects them one by one. */
  fixes: z.array(BgFixSchema).optional(),
  /** True once the content pass has queued its suggestions here (so a fix the user dismissed does not come back on a re-import). */
  fixesImported: z.boolean().optional(),
  nameOverride: z.string().optional(),
  descriptionOverride: z.string().optional(),
  source: z.enum(['draft', 'user']).default('draft'),
  updatedAt: z.string().optional(),
});
export type BgLabel = z.infer<typeof BgLabelSchema>;

/** What to do with backgrounds of unknown ownership. */
export const UNKNOWN_POLICIES = ['avoid', 'allow', 'forbid'] as const;
export const LabelRulesSchema = z.object({
  /** avoid: only as a last resort, with a continuity warning; allow: like generic; forbid: never. */
  unknownPolicy: z.enum(UNKNOWN_POLICIES).default('avoid'),
});
export type LabelRules = z.infer<typeof LabelRulesSchema>;

export const LabelFileSchema = z.object({
  version: z.literal(1),
  rules: LabelRulesSchema.default({ unknownPolicy: 'avoid' }),
  labels: z.record(z.string(), BgLabelSchema),
});
export type LabelFile = z.infer<typeof LabelFileSchema>;

/** Editable subset (PUT replaces these; PATCH merges). */
export const BgLabelPatchSchema = BgLabelSchema.omit({ source: true, updatedAt: true }).partial();
export type BgLabelPatch = z.infer<typeof BgLabelPatchSchema>;

export const emptyLabelFile = (): LabelFile => ({ version: 1, rules: { unknownPolicy: 'avoid' }, labels: {} });
