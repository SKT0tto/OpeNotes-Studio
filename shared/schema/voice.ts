import { z } from 'zod';

/** Default address of GPT-SoVITS `api_v2.py`. */
export const DEFAULT_SOVITS_ENDPOINT = 'http://127.0.0.1:9880';

/** A character's voice (keyed by cast `characterKey`, shared by every project). A profile without `refAudioPath` = the character is not voiced. */
export const VoiceProfileSchema = z.object({
  /** Paths on the GPT-SoVITS machine; absent = keep whatever the server has loaded. */
  gptWeights: z.string().optional(),
  sovitsWeights: z.string().optional(),
  refAudioPath: z.string().optional(),
  promptText: z.string().default(''),
  promptLang: z.string().default('ja'),
  speed: z.number().min(0.5).max(2).default(1),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export const VoiceSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default(DEFAULT_SOVITS_ENDPOINT),
  volume: z.number().min(0).max(1).default(1),
  textLang: z.string().default('ja'),
  profiles: z.record(z.string(), VoiceProfileSchema).default({}),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/** What a client may change: every field optional; a profile entry set to `null` is removed. */
export const VoiceSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().optional(),
  volume: z.number().min(0).max(1).optional(),
  textLang: z.string().optional(),
  profiles: z.record(z.string(), VoiceProfileSchema.nullable()).optional(),
});
export type VoiceSettingsPatch = z.infer<typeof VoiceSettingsPatchSchema>;

export const hasVoice = (p: VoiceProfile | undefined): p is VoiceProfile & { refAudioPath: string } => !!p?.refAudioPath?.trim();

/** One line the model translates. */
export const VoiceTranslationSchema = z.object({
  lines: z.array(z.object({ id: z.string(), ja: z.string() })),
});
export type VoiceTranslation = z.infer<typeof VoiceTranslationSchema>;

export type VoiceJobState = 'running' | 'done' | 'cancelled' | 'failed';
export interface VoiceJobItem {
  beatId: string;
  state: 'pending' | 'translating' | 'synth' | 'done' | 'skipped' | 'error';
  message?: string;
}
/** The result for one beat, to be applied by the editor in one undo step. */
export interface VoiceBeatResult {
  sceneId: string;
  beatId: string;
  voice: { ja: string; jaEdited?: boolean; src?: string; file?: string; seconds?: number; hash?: string };
}
export interface VoiceJobView {
  id: string;
  state: VoiceJobState;
  /** Overall message ("翻译中…", "合成 3/10"). */
  message: string;
  total: number;
  done: number;
  errors: Array<{ beatId: string; message: string }>;
  results: VoiceBeatResult[];
  /** Fatal reason when `state` is `failed`. */
  error?: string;
}
export type VoiceScope = { kind: 'project' } | { kind: 'scene'; sceneId: string } | { kind: 'beat'; sceneId: string; beatId: string };
