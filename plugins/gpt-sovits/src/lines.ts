import type { Beat, Project } from '../../../shared/schema/project';
import { hasVoice } from './profile';
import type { VoiceProfile } from './schema';

/** A beat the plugin voices: a spoken line (any variant) with a speaker. Narration, actions, pauses ... are never voiced. */
export const isSpokenBeat = (b: Pick<Beat, 'kind' | 'speakerId'>): boolean => b.kind === 'dialogue' && !!b.speakerId;

/** The voice profile of a beat's speaker, when it has one (profile with a reference audio). */
export function profileOfBeat(project: Pick<Project, 'cast'>, beat: Pick<Beat, 'kind' | 'speakerId'>, profiles: Record<string, VoiceProfile>): { characterKey: string; displayName: string; profile: VoiceProfile & { refAudioPath: string } } | null {
  if (!isSpokenBeat(beat)) return null;
  const member = project.cast.find((c) => c.id === beat.speakerId);
  const profile = member ? profiles[member.characterKey] : undefined;
  return member && hasVoice(profile) ? { characterKey: member.characterKey, displayName: member.displayName, profile } : null;
}

/** Only the words that are spoken: bracket wrappers of a monologue, name plates ("名字：") and stage-direction brackets are removed. */
export function spokenText(text: string, names: readonly string[] = []): string {
  let t = text.trim();
  t = t.replace(/^[（(［[【「『]+/, '').replace(/[）)］\]】」』]+$/, '');
  t = t.replace(/[（(][^）)]*[）)]/g, '');
  for (const n of names) if (n && t.startsWith(n) && /^[：:]/.test(t.slice(n.length))) t = t.slice(n.length + 1).trim();
  return t.trim();
}

/** Beats are voiced only with a real sound: more than punctuation. */
export const hasWords = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);
