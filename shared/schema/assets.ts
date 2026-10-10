import { z } from 'zod';
import { BgLabelSchema, LabelRulesSchema } from './assetLabels';

/** Nominal value of one parameter inside a motion (first frame and time-weighted mean). */
export const ParamStatSchema = z.object({ first: z.number(), mean: z.number() });
export type ParamStat = z.infer<typeof ParamStatSchema>;

export const MotionStatsSchema = z.object({
  duration: z.number(),
  fps: z.number(),
  loop: z.boolean(),
  angleX: ParamStatSchema.nullable(),
  bodyAngleX: ParamStatSchema.nullable(),
  eyeBallX: ParamStatSchema.nullable(),
});
export type MotionStats = z.infer<typeof MotionStatsSchema>;

export const MotionEntrySchema = z.object({
  /** Motion group name exactly as the key in model3.json (may contain `%20`). */
  name: z.string(),
  /** Path relative to the model directory, as written in model3.json. */
  file: z.string(),
  family: z.string(),
  side: z.enum(['L', 'C', 'R']).nullable(),
  variant: z.string(),
  /** null when the motion file is missing or unreadable. */
  stats: MotionStatsSchema.nullable(),
});
export type MotionEntry = z.infer<typeof MotionEntrySchema>;

export const ExpressionEntrySchema = z.object({
  name: z.string(),
  file: z.string(),
  family: z.string(),
  index: z.number().nullable(),
});
export type ExpressionEntry = z.infer<typeof ExpressionEntrySchema>;

export const CostumeInfoSchema = z.object({
  base: z.enum(['casual', 'school', 'roomwear', 'live', 'suits', 'virtual', 'other']),
  season: z.enum(['spring', 'summer', 'winter']).optional(),
  school: z.enum(['hs', 'jhs']).optional(),
  grade: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  glasses: z.boolean(),
  quality: z.enum(['', 'low']),
  mode: z.enum(['adv', 'live']),
  still: z.boolean(),
  tags: z.array(z.string()),
});

export const ModelEntrySchema = z.object({
  id: z.string(),
  characterKey: z.string(),
  isSub: z.boolean(),
  costume: z.string(),
  costumeInfo: CostumeInfoSchema,
  mode: z.enum(['adv', 'live']),
  quality: z.enum(['', 'low']),
  still: z.boolean(),
  hasPhysics: z.boolean(),
  /** URL path of model3.json (served read-only by the server). */
  url: z.string(),
  preview: z.string().nullable(),
  textureCount: z.number(),
  motions: z.array(MotionEntrySchema),
  expressions: z.array(ExpressionEntrySchema),
  /** Files referenced by model3.json that are absent on disk. */
  missingFiles: z.array(z.string()),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

export const BackgroundEntrySchema = z.object({
  id: z.string(),
  url: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  name: z.string(),
  aliases: z.array(z.string()),
  kind: z.string().nullable(),
  location: z.string().nullable(),
  category: z.string().nullable(),
  setting: z.string().nullable(),
  time: z.string().nullable(),
  weather: z.string().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  /** Band / place labels from asset-labels/backgrounds.json (absent = unlabelled, treated as generic). */
  labels: BgLabelSchema.optional(),
});
export type BackgroundEntry = z.infer<typeof BackgroundEntrySchema>;

export const AudioEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  /** `media` for the asset library, `user` for AUDIO_ROOTS imports. */
  source: z.enum(['media', 'user']),
  ext: z.string(),
  bytes: z.number(),
});
export type AudioEntry = z.infer<typeof AudioEntrySchema>;

export const CharacterEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  nickname: z.string().nullable(),
  bandKey: z.string().nullable(),
  bandName: z.string(),
  role: z.string().nullable(),
  color: z.string().nullable(),
  isSub: z.boolean(),
  aliases: z.array(z.string()),
  modelIds: z.array(z.string()),
});
export type CharacterEntry = z.infer<typeof CharacterEntrySchema>;

export const BandEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  memberKeys: z.array(z.string()),
  /** Editable default stage formation: x -1..1 (left..right), depth 0 (front)..1 (back). */
  formation: z.array(z.object({ key: z.string(), x: z.number(), depth: z.number() })),
});
export type BandEntry = z.infer<typeof BandEntrySchema>;

export const CatalogSchema = z.object({
  /** Hash over every id and file signature; changes whenever the library changes. */
  version: z.string(),
  generatedAt: z.number(),
  models: z.array(ModelEntrySchema),
  backgrounds: z.array(BackgroundEntrySchema),
  audio: z.array(AudioEntrySchema),
  characters: z.array(CharacterEntrySchema),
  bands: z.array(BandEntrySchema),
  warnings: z.array(z.string()),
  labelRules: LabelRulesSchema.optional(),
});
export type Catalog = z.infer<typeof CatalogSchema>;

/** Compact model for list views: only counts, no per-motion data. */
export type CompactModel = Omit<ModelEntry, 'motions' | 'expressions' | 'missingFiles'> & {
  motionCount: number;
  expressionCount: number;
  missingFileCount: number;
};

export type CompactCatalog = Omit<Catalog, 'models'> & { models: CompactModel[] };

export function toCompactCatalog(catalog: Catalog): CompactCatalog {
  return {
    ...catalog,
    models: catalog.models.map((m) => {
      const { motions, expressions, missingFiles, ...rest } = m;
      return { ...rest, motionCount: motions.length, expressionCount: expressions.length, missingFileCount: missingFiles.length };
    }),
  };
}
