/**
 * 「按文件名标签自动填」: proposes which of a character's scanned reference clips goes with which emotion, from the delivery tag at the
 * start of the file name (开心, 发牢骚, 叙述 ...). Pure: it only builds a proposal, the person reviews it and saves.
 *
 * Rules: a tag equal to the emotion's own label always wins; then close synonyms. A clip whose delivery is extreme (a tearful 真情吐露, 哭腔,
 * 惊慌失措 ...) is never offered for an emotion it does not match, and for an emotion it does match it is used only when nothing better exists
 * (flagged `weak`). An emotion with no fitting clip stays empty (= the default reference): a wrong-mood clip is worse than none.
 */
import type { RefCandidate } from './match';
import type { RefClip } from '../schema';

/** The Chinese label the app shows for each emotion (same as `EMOTION_LABEL`). */
export const EMOTION_TAG_LABEL: Record<string, string> = { happy: '开心', sad: '难过', angry: '生气', surprised: '惊讶', shy: '害羞', thinking: '思考', serious: '认真', neutral: '平静' };

interface Words {
  /** Close synonyms of the label. */
  near: readonly string[];
  /** Extreme deliveries that do match this emotion: used only when nothing else fits. */
  weak?: readonly string[];
}
export const EMOTION_TAG_WORDS: Record<string, Words> = {
  happy: { near: ['兴奋', '唐笑', '愉快', '开朗', '赞叹', '赞扬', '感叹', '感谢'], weak: ['大笑'] },
  sad: { near: ['悲伤', '安慰', '叹气', '无奈', '不甘', '松口气'], weak: ['哭腔', '真情吐露'] },
  angry: { near: ['发牢骚', '吐槽', '愤怒', '责难', '调侃', '抗拒'] },
  surprised: { near: ['震惊', '惊慌'], weak: ['惊慌失措'] },
  shy: { near: ['犹豫', '不自信', '吐露'], weak: ['颤颤巍巍'] },
  thinking: { near: ['疑问', '疑惑', '困惑', '反问', '回忆', '自言自语', '喃喃自语', '内心独白'] },
  serious: { near: ['劝导', '劝告', '忠告', '提醒', '讲道理', '认可与确定', '确认', '总结', '提议'] },
  neutral: { near: ['叙述', '标准', '正常', '通常', '普通'] },
};
/** Deliveries that are poor references to clone from; allowed only for the emotions that list them as `weak`. */
const EXTREME = ['真情吐露', '哭腔', '悲伤', '惊慌失措', '颤颤巍巍', '夹子音', '哈？', '大笑', '企鹅追人', '不演了', '低沉', '发誓', '哭'];
const EMOTION_ORDER = ['neutral', 'happy', 'angry', 'sad', 'surprised', 'shy', 'thinking', 'serious'] as const;

export interface EmotionPick extends RefClip {
  /** The clip is an extreme delivery that only just fits this emotion (the row shows a ⚠). */
  weak: boolean;
}

/** How well a tag says `emotion` (null = it does not, or it must not be used for it). */
export function tagFit(tag: string, emotion: string): { score: number; weak: boolean } | null {
  const w = EMOTION_TAG_WORDS[emotion];
  if (!w || !tag) return null;
  const parts = tag.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  const weakWords = w.weak ?? [];
  const isWeak = parts.some((p) => weakWords.some((x) => p.includes(x)));
  // an extreme delivery this emotion does not list rules the clip out, even inside a composite tag
  if (parts.some((p) => EXTREME.some((x) => p.includes(x) && !w.near.includes(x)) && !weakWords.some((y) => p.includes(y)))) return null;
  if (isWeak) return { score: 10, weak: true };
  const label = EMOTION_TAG_LABEL[emotion];
  if (parts.some((p) => p === label)) return { score: 100, weak: false };
  if (parts.some((p) => w.near.some((x) => p === x))) return { score: 60, weak: false };
  if (parts.some((p) => w.near.some((x) => p.includes(x)))) return { score: 45, weak: false };
  return null;
}

/** Only clips GPT-SoVITS accepts (3-10 s); clips of unknown length are left out. */
const usable = (c: RefCandidate): boolean => c.seconds !== null && c.seconds >= 3 && c.seconds <= 10;

/** The best clip per emotion that has a fitting one; one clip serves only one emotion unless it is the only fit. */
export function suggestEmotionPicks(candidates: readonly RefCandidate[]): Record<string, EmotionPick> {
  const pool = candidates.filter(usable);
  const out: Record<string, EmotionPick> = {};
  const taken = new Set<string>();
  for (const emotion of EMOTION_ORDER) {
    const scored = pool
      .map((c) => {
        let fit = tagFit(c.tag, emotion);
        if (!fit && emotion === 'neutral' && c.calm && !EXTREME.some((x) => c.tag.includes(x))) fit = { score: 40, weak: false };
        if (!fit) return null;
        const d = Math.abs((c.seconds ?? 5) - 5);
        return { c, weak: fit.weak, s: fit.score - Math.min(d, 5) * 0.3 + (c.text ? 1 : -3) + (c.textFrom === 'none' ? -3 : 0) };
      })
      .filter((x): x is { c: RefCandidate; weak: boolean; s: number } => x !== null)
      .sort((a, b) => b.s - a.s);
    const pick = scored.find((x) => !taken.has(x.c.path)) ?? scored[0];
    if (!pick) continue;
    taken.add(pick.c.path);
    out[emotion] = { path: pick.c.path, text: pick.c.text, lang: pick.c.lang || 'ja', weak: pick.weak };
  }
  return out;
}

/** The same proposal as plain reference clips. */
export function suggestEmotionRefs(candidates: readonly RefCandidate[]): Record<string, RefClip> {
  return Object.fromEntries(Object.entries(suggestEmotionPicks(candidates)).map(([e, p]) => [e, { path: p.path, text: p.text, lang: p.lang }]));
}
