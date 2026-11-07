/** The few runtime helpers the browser side needs, kept free of zod so the web bundle stays small. */
import type { VoiceProfile } from './schema';

/** Default address of GPT-SoVITS `api_v2.py`. */
export const DEFAULT_SOVITS_ENDPOINT = 'http://127.0.0.1:9880';

export const hasVoice = (p: VoiceProfile | undefined): p is VoiceProfile & { refAudioPath: string } => !!p?.refAudioPath?.trim();
