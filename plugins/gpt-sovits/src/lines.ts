import type { Beat, BeatVoice, Project } from '../../../shared/schema/project';
import { hasVoice } from './profile';
import type { RefClip, VoiceProfile } from './schema';

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

/** Where the reference clip of a line comes from. */
export type RefSource = 'pinned-custom' | 'pinned-emotion' | 'pinned-default' | 'emotion' | 'default';
export interface ResolvedRef {
  ref: RefClip;
  source: RefSource;
  /** The emotion whose clip is used (pinned or automatic). */
  emotion?: string;
  /** The clip is (path, text and language) the character's main reference: the line is made exactly as before emotion references existed. */
  main: boolean;
}

const emotionRef = (profile: VoiceProfile, emotion: string | undefined): RefClip | null => {
  const r = emotion ? profile.emotionRefs?.[emotion] : undefined;
  return r?.path.trim() ? r : null;
};

/**
 * The reference clip a line is synthesised with: the line's pinned choice, else the clip of the line's emotion, else the main reference.
 * A pinned emotion that has no clip configured (any more) falls back to the main reference.
 */
export function resolveRef(profile: VoiceProfile & { refAudioPath: string }, beat: Pick<Beat, 'emotion' | 'voice'>): ResolvedRef {
  const main: RefClip = { path: profile.refAudioPath, text: profile.promptText, lang: profile.promptLang };
  const done = (ref: RefClip, source: RefSource, emotion?: string): ResolvedRef => ({ ref, source, ...(emotion ? { emotion } : {}), main: ref.path === main.path && ref.text === main.text && ref.lang === main.lang });
  const pin = beat.voice?.ref;
  if (pin && typeof pin === 'object' && pin.path.trim()) return done({ path: pin.path.trim(), text: pin.text, lang: pin.lang || 'ja' }, 'pinned-custom');
  if (pin === 'default') return done(main, 'pinned-default');
  if (typeof pin === 'string' && pin !== 'auto') {
    const r = emotionRef(profile, pin);
    return r ? done(r, 'pinned-emotion', pin) : done(main, 'pinned-default');
  }
  const r = emotionRef(profile, beat.emotion);
  return r ? done(r, 'emotion', beat.emotion) : done(main, 'default');
}

/** What identifies a non-main reference clip in `BeatVoice.refUsed`; empty for the main one. */
export const refSignature = (r: ResolvedRef): string => (r.main ? '' : `${r.ref.path}\n${r.ref.lang}\n${r.ref.text}`);

/** The recording was made with another reference than the one the line resolves to now. */
export const refChanged = (voice: BeatVoice | undefined, r: ResolvedRef): boolean => !!voice?.file && (voice.refUsed ?? '') !== refSignature(r);
