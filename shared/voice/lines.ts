import type { Beat } from '../schema/project';

/** The recording of a beat when it may be used: it exists and was made for the line's present text. */
export function usableVoice(b: Pick<Beat, 'text' | 'voice'>): { file: string; seconds: number } | null {
  const v = b.voice;
  if (!v?.file || v.seconds === undefined) return null;
  if (v.src !== b.text) return null;
  return { file: v.file, seconds: v.seconds };
}
