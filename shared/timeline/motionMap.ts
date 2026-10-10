/**
 * Motion / expression resolution that never leaves an actor without activity.
 *
 * Pure helpers shared by the AI validator (repair at generation time) and the compiler (re-mapping when an outfit
 * changes, or when a project was edited by hand): an id that the actor's CURRENT model does not have is mapped to the
 * closest available one (same family -> same kind -> keyword category -> emotion table -> a gentle generic gesture)
 * instead of being dropped, and every model has a looping idle to fall back to.
 */
import type { MotionEntry } from '../schema/assets';

/** Gesture families the rule director picks from, per emotion tag (first available wins, rotating). */
export const EMOTION_GESTURE: Record<string, string[]> = {
  happy: ['smile01', 'nod01', 'smile02'],
  sad: ['sad01', 'cry01'],
  angry: ['angry01'],
  surprised: ['surprised01', 'question01'],
  shy: ['kime01', 'smile02'],
  thinking: ['thinking01', 'check01', 'question01'],
  serious: ['serious01', 'nod02'],
  neutral: ['nod01', 'look01', 'check01', 'nod02'],
};

/**
 * What a bystander does while somebody else speaks (STYLE_REFERENCE: listeners are not frozen: small nods, a glance,
 * a shy smile, a thoughtful tilt). Small gestures only; the loud ones (angry, cry, surprised) stay with the speaker.
 */
export const LISTENER_REACTION: Record<string, string[]> = {
  happy: ['smile01', 'nod01', 'smile02', 'nod02'],
  sad: ['sad01', 'look01', 'nod01', 'check01'],
  angry: ['serious01', 'nod02', 'look01'],
  surprised: ['question01', 'look01', 'nod01'],
  shy: ['kime01', 'smile02', 'look01', 'check01'],
  thinking: ['thinking01', 'check01', 'nod01', 'question01'],
  serious: ['nod02', 'serious01', 'look01', 'check01'],
  neutral: ['nod01', 'look01', 'check01', 'nod02', 'smile01'],
};

/** Mild gestures every everyday model has, used when nothing closer exists. */
const GENERIC_GESTURES = ['nod01', 'look01', 'check01', 'nod02', 'smile01', 'thinking01', 'question01', 'serious01'];

/** Keyword -> preferred families (matched on the wanted name, lower case). */
const CATEGORY: Array<[RegExp, string[]]> = [
  [/smile|happy|laugh|joy|cheer|wink|grin/, ['smile01', 'smile02', 'smile03', 'nod01']],
  [/cry|tear|sad|sorrow|sob|depress/, ['sad01', 'cry01', 'sad02']],
  [/angry|mad|rage|furious|scream|sneer/, ['angry01', 'serious01', 'angry02']],
  [/surpris|shock|amaze|startle|panic|gasp/, ['surprised01', 'surprised02', 'question01']],
  [/shy|blush|embarrass|kime|bashful/, ['kime01', 'kime02', 'smile02']],
  [/think|ponder|doubt|wonder|question|puzzl|hmm/, ['thinking01', 'question01', 'check01']],
  [/nod|agree|^yes|understand|^ok$/, ['nod01', 'nod02', 'nod03']],
  [/look|glance|gaze|stare|watch/, ['look01', 'look02', 'check01']],
  [/denial|deny|shake|refuse|reject|^no\d*$/, ['denial01', 'denial02', 'serious01']],
  [/bye|wave|greet|hello|join/, ['bye01', 'join01', 'nod01']],
  [/nervous|worr|anxi|fear|afraid|scare/, ['nervous01', 'kime01', 'check01']],
  [/serious|stern|resolve|determin/, ['serious01', 'nod02']],
  [/check|note|write|read/, ['check01', 'note01', 'look01']],
];

const SIDE_RE = /^(.+?)_([LCR])(\d*)(?:_(.+))?$/;

/** Motion family of a model3.json group name: `mtn_nod01_L` -> `nod01`, `mtn_idle_01` -> `idle_01`. */
export function familyOfName(name: string): string {
  const stem = name.trim().replace(/^mtn_/, '');
  return SIDE_RE.exec(stem)?.[1] ?? stem;
}

/** Comparable form of a family: `idle_01` and `idle01` are the same thing. */
export const canon = (family: string): string => familyOfName(family).replace(/_/g, '').toLowerCase();

export const isIdleFamily = (family: string): boolean => /^idle/i.test(family);
/** Families that run as a loop until something replaces them: idles and the instrument-playing motions of live-mode models. */
export const isLoopFamily = (family: string): boolean => /^(idle|play)/i.test(family);
/** Motions that are expression files, tears and other effects rather than body gestures. */
const NOT_A_GESTURE = /^(exp_|misc_|idle|forget|haruhikage|habit|ide\d|spray|maskoff|spin|jitabata|sing|confrict)/i;
const LIVE_FAMILY = /^(play|action|finish)/i;

const families = (motions: readonly MotionEntry[]): string[] => [...new Set(motions.map((m) => m.family))];
/** Live-mode models play the instrument; they have play / action / finish motions and no everyday gestures. */
export const isLiveSet = (motions: readonly MotionEntry[]): boolean => families(motions).some((f) => /^play/i.test(f));

/**
 * The family a model idles in. `idle01` when present (the default breathing loop of everyday models), else the first
 * family that starts with `idle` (live-mode models call it `idle_01`), else null.
 */
export function idleFamilyOf(motions: readonly MotionEntry[]): string | null {
  const idles = families(motions).filter(isIdleFamily).sort();
  return idles.find((f) => canon(f) === 'idle01') ?? idles[0] ?? null;
}

/** Families a wanted motion may map to: gestures of an everyday model, play / action / finish of a live-mode one. */
export function gesturePool(motions: readonly MotionEntry[]): string[] {
  const live = isLiveSet(motions);
  return families(motions).filter((f) => (live ? LIVE_FAMILY.test(f) : !NOT_A_GESTURE.test(f))).sort();
}

const firstOf = (pool: readonly string[], wanted: readonly string[]): string | null => {
  for (const w of wanted) {
    const hit = pool.find((p) => canon(p) === canon(w));
    if (hit) return hit;
  }
  return null;
};

const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.codePointAt(0)!) >>> 0, 7);

/**
 * The closest family that exists in `motions` for a wanted motion name. Order: the family itself, the same kind with another
 * number (`nod07` -> `nod01`), keyword category (`happy_wave` -> smile01), the emotion table, a mild generic gesture, any
 * gesture. Returns null only for a model that has nothing but idles (then the idle is the answer).
 * `salt` makes the choice among equals deterministic but varied (several actors asking for the same unknown id).
 */
export function mapMotionFamily(motions: readonly MotionEntry[], wanted: string, emotion = 'neutral', salt = ''): string | null {
  const pool = gesturePool(motions);
  const w = canon(wanted.trim());
  if (isIdleFamily(w)) return idleFamilyOf(motions);
  const exact = firstOf(pool, [w]);
  if (exact) return exact;
  const numbered = w ? pool.filter((f) => canon(f).startsWith(w)).sort() : []; // `play02` -> play02_01
  if (numbered.length > 0) return numbered[0]!;
  const prefix = /^[a-z]+/.exec(w)?.[0];
  const same = prefix ? pool.filter((f) => canon(f).startsWith(prefix)).sort() : [];
  if (same.length > 0) return same[0]!;
  if (isLiveSet(motions)) return pool.find((f) => /^play/i.test(f)) ?? pool[0] ?? null;
  const key = wanted.toLowerCase();
  for (const [re, fams] of CATEGORY) {
    if (!re.test(key)) continue;
    const hit = firstOf(pool, fams);
    if (hit) return hit;
  }
  const byEmotion = firstOf(pool, EMOTION_GESTURE[emotion] ?? []);
  if (byEmotion) return byEmotion;
  const generic = GENERIC_GESTURES.filter((g) => firstOf(pool, [g]));
  if (generic.length > 0) return firstOf(pool, [generic[hash(salt || wanted) % generic.length]!]);
  return pool.length > 0 ? pool[hash(salt || wanted) % pool.length]! : null;
}

const EXPR_KEYWORD: Array<[RegExp, string[]]> = [
  [/smile|happy|laugh|joy|cheer|grin/, ['exp_smile01', 'exp_bsmile01', 'exp_smile02']],
  [/cry|tear|sad|sorrow|dispair|depress/, ['exp_sad01', 'exp_cry01', 'exp_sad02']],
  [/angry|mad|rage|hatred|furious/, ['exp_angry01', 'exp_serious01']],
  [/surpris|shock|amaze|panic|gasp/, ['exp_surprised01', 'exp_amazed01', 'exp_surprised02']],
  [/shy|blush|kime|embarrass/, ['exp_shy01', 'exp_kime01', 'exp_smile01']],
  [/think|ponder|question|puzzl|doubt/, ['exp_serious01', 'exp_question01', 'exp_puzzled01', 'exp_idle02']],
  [/serious|stern|resolve/, ['exp_serious01', 'exp_serious02']],
];

/** The closest expression that exists, or null for a model without expressions (live-mode). Never an empty answer for an everyday model. */
export function mapExpressionName(names: readonly string[], wanted: string, emotion: string, emotionTable: Record<string, string[]>): string | null {
  if (names.length === 0) return null;
  const w = wanted.trim().startsWith('exp_') ? wanted.trim() : `exp_${wanted.trim()}`;
  if (names.includes(w)) return w;
  const prefix = /^(exp_[a-z]+)/.exec(w)?.[1];
  const same = prefix ? names.filter((n) => n.startsWith(prefix)).sort() : [];
  if (same.length > 0) return same[0]!;
  const key = wanted.toLowerCase();
  for (const [re, list] of EXPR_KEYWORD) {
    if (re.test(key)) {
      const hit = list.find((n) => names.includes(n));
      if (hit) return hit;
    }
  }
  const byEmotion = (emotionTable[emotion] ?? []).find((e) => names.includes(e));
  if (byEmotion) return byEmotion;
  return names.find((n) => n === 'exp_idle01') ?? null;
}

/** Reaction gesture family for a bystander (deterministic, rotating through the emotion's list, never the same twice in a row). */
export function pickReaction(motions: readonly MotionEntry[], emotion: string, rot: number, avoid = ''): string | null {
  const pool = gesturePool(motions);
  if (isLiveSet(motions)) return null; // musicians keep playing
  const list = LISTENER_REACTION[emotion] ?? LISTENER_REACTION.neutral!;
  const have = list.map((f) => firstOf(pool, [f])).filter((f): f is string => !!f);
  const fresh = have.filter((f) => f !== avoid);
  const from = fresh.length > 0 ? fresh : have;
  if (from.length > 0) return from[rot % from.length]!;
  const generic = GENERIC_GESTURES.map((f) => firstOf(pool, [f])).filter((f): f is string => !!f && f !== avoid);
  return generic.length > 0 ? generic[rot % generic.length]! : null;
}

/**
 * The idle to run when nothing else is playing, from the raw motion group names of a loaded model
 * (`mtn_idle01_C` preferred, else any idle: `mtn_idle_01` of live-mode models), or null when the model has none.
 */
export function idleNameOf(names: readonly string[]): string | null {
  const idles = names.filter((n) => isIdleFamily(familyOfName(n))).sort();
  return idles.find((n) => canon(n) === 'idle01' && /_C$/.test(n)) ?? idles.find((n) => canon(n) === 'idle01') ?? idles[0] ?? null;
}
