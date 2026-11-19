/**
 * 「按文件名标签自动填」: proposes which of a character's scanned reference clips goes with which emotion, from the delivery tag at the
 * start of the file name (兴奋, 发牢骚, 叙述 ...). Pure: it only builds a proposal, the person reviews it and saves.
 */
import type { RefCandidate } from './match';
import type { RefClip } from '../schema';

/** Tag keywords per emotion (a tag matches when it contains the keyword; composite tags like `叙述，提示` are matched as a whole). */
export const EMOTION_TAG_WORDS: Record<string, readonly string[]> = {
  happy: ['开心', '兴奋', '唐笑', '大笑', '愉快', '开朗', '赞叹', '赞扬', '感叹', '感谢'],
  sad: ['悲伤', '哭腔', '安慰', '叹气', '无奈', '不甘', '松口气'],
  angry: ['发牢骚', '吐槽', '生气', '愤怒', '责难', '调侃', '抗拒'],
  surprised: ['惊讶', '震惊', '惊慌', '小震惊'],
  shy: ['犹豫', '不自信', '吐露', '颤颤巍巍'],
  thinking: ['疑问', '疑惑', '困惑', '思考', '反问', '回忆', '自言自语', '喃喃自语', '内心独白'],
  serious: ['劝导', '劝告', '忠告', '提醒', '讲道理', '认可与确定', '确认', '总结', '提议', '真情'],
  neutral: ['叙述', '标准', '平静', '正常', '通常', '普通'],
};
/** Delivery that is a poor reference to clone from (extreme or a voice variant): used only when nothing else fits. */
const EXTREME = ['哭腔', '颤颤巍巍', '惊慌失措', '夹子音', '哈？', '大笑', '企鹅追人', '不演了', '低沉'];
const EMOTION_ORDER = ['neutral', 'happy', 'angry', 'sad', 'surprised', 'shy', 'thinking', 'serious'] as const;

/** How well a clip's tag says `emotion` (0 = it does not). */
function tagScore(tag: string, emotion: string): number {
  const words = EMOTION_TAG_WORDS[emotion] ?? [];
  const hit = words.some((w) => tag.includes(w));
  if (!hit) return 0;
  const single = !/[，,]/.test(tag);
  return 10 + (single ? 3 : 0) - (EXTREME.some((x) => tag.includes(x)) ? 6 : 0);
}

/** Only clips GPT-SoVITS accepts (3-10 s) with a tag; clips of unknown length are left out. */
const usable = (c: RefCandidate): boolean => c.seconds !== null && c.seconds >= 3 && c.seconds <= 10;

/** The best clip per emotion that has a tagged clip; one clip serves only one emotion unless it is the only fit. */
export function suggestEmotionRefs(candidates: readonly RefCandidate[]): Record<string, RefClip> {
  const pool = candidates.filter(usable);
  const out: Record<string, RefClip> = {};
  const taken = new Set<string>();
  for (const emotion of EMOTION_ORDER) {
    const scored = pool
      .map((c) => {
        let s = c.tag ? tagScore(c.tag, emotion) : 0;
        if (emotion === 'neutral' && s === 0 && c.calm) s = 8;
        if (s === 0) return null;
        const d = Math.abs((c.seconds ?? 5) - 5);
        return { c, s: s - Math.min(d, 5) * 0.3 + (c.text ? 1 : -3) + (c.textFrom === 'none' ? -3 : 0) };
      })
      .filter((x): x is { c: RefCandidate; s: number } => x !== null)
      .sort((a, b) => b.s - a.s);
    const pick = scored.find((x) => !taken.has(x.c.path)) ?? scored[0];
    if (!pick) continue;
    taken.add(pick.c.path);
    out[emotion] = { path: pick.c.path, text: pick.c.text, lang: pick.c.lang || 'ja' };
  }
  return out;
}
