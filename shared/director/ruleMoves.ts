/**
 * Rule director, place changes inside a scene (P20): scan the paragraphs for a movement verb next to a place word and map the place
 * to a background of the allowed set. The place words come from the backgrounds themselves (tags, place name, location, title).
 * Deterministic; no key and no network.
 */
import type { BgMove } from '../schema/ai';
import type { BackgroundEntry } from '../schema/assets';
import type { Paragraph } from './paragraphs';
import { MAX_BG_MOVES } from './vocab';

const MOVE_RE = /走出|走进|走到|走向|来到|回到|到了|到达|抵达|赶到|前往|去了|去到|进入|踏进|跑到|跑向|爬上|登上|离开|出了|进了|转移到|搬到|返回|回家|踏上/;
/** Words that describe a picture, not a place. */
const STOP = new Set(['室内', '室外', '日', '夜', '傍晚', '晴', '雨', '暗', '灯', '住宅', '街道', '城市', '简约', '空旷', '蓝', '白', '粉', '红', '绿', '紫', '橙', '黑', '木', '日式', '复古', '豪华', '特写', '插入', '装饰', '抽象', '屏幕', '招牌', '暖光', '夜景', '入口', '大厅', '桥', '花', '鼓', '钢琴', '电脑', '沙发', '楼梯', '海报', '绿植', '吧台', 'logo', 'UI', '拉帘', '日间', '夜间', '晴天', '阴天', '雨天']);
const SYNONYM: Record<string, string[]> = { 卧室: ['房间', '卧室', '闺房', '房里'], 校门: ['校门', '校门口', '校门前'], 车站: ['车站', '站台', '月台', '检票口'], 天台: ['天台', '屋顶'], 咖啡厅: ['咖啡厅', '咖啡馆'], 练习室: ['练习室', '排练室'], 教室: ['教室'], 公园: ['公园'], 食堂: ['食堂'] };

const groupOf = (b: BackgroundEntry) => b.name.replace(/（.*?）|\(.*?\)/g, '').trim();

/** Place words of a background: tags, place name, location, and the parts of its title. */
function tokensOf(b: BackgroundEntry): string[] {
  const raw = [...b.tags, b.labels?.placeName, b.labels?.location, b.location, ...b.name.split(/[·・（）()\s/]+/)].filter((x): x is string => !!x);
  const out = new Set<string>();
  for (const t of raw) {
    const w = t.trim();
    if (w.length >= 2 && !STOP.has(w)) out.add(w);
    for (const [k, syn] of Object.entries(SYNONYM)) if (w === k) syn.forEach((s) => out.add(s));
  }
  return [...out];
}

const timeOf = (b: BackgroundEntry): string => b.time ?? '';

export interface DetectedMoves {
  /** A different start background when the scene's first paragraph already starts by moving ("走出校门"). */
  start?: BackgroundEntry;
  moves: BgMove[];
}

/**
 * `pool` is the set the scene may use (band rules applied, category scene); `current` the start background chosen by the ordinary ranking.
 * Moves are only found where a movement verb and a place word stand in one clause.
 */
export function detectMoves(pool: readonly BackgroundEntry[], paras: readonly Paragraph[], current: BackgroundEntry, wantTime: string): DetectedMoves {
  const tokens = new Map(pool.map((b) => [b.id, tokensOf(b)] as const));
  const picks: Array<{ para: number; bg: BackgroundEntry; why: string }> = [];
  for (const p of paras) {
    for (const clause of p.text.split(/[，。；！？!?、…\n]+/)) {
      if (!MOVE_RE.test(clause)) continue;
      const possessive = /[一-龥]{1,3}的(房间|卧室|家里?)/.exec(clause);
      let best: { b: BackgroundEntry; score: number; hit: string } | null = null;
      for (const b of pool) {
        let score = 0;
        let hit = '';
        for (const t of tokens.get(b.id)!) {
          const owned = t.endsWith('家') && t.length >= 3 && possessive !== null && clause.includes(t.slice(0, -1));
          if (clause.includes(t) || owned) {
            score += t.length;
            if (t.length > hit.length) hit = t;
          }
        }
        if (score < 2) continue;
        // prefer the background whose time of day fits, then a lower id (stable)
        const bonus = wantTime && timeOf(b) && (timeOf(b).includes(wantTime) || wantTime.includes(timeOf(b))) ? 0.5 : 0;
        const total = score + bonus;
        if (!best || total > best.score || (total === best.score && b.id < best.b.id)) best = { b, score: total, hit };
      }
      if (best) picks.push({ para: p.index, bg: best.b, why: `「${clause.trim().slice(0, 18)}」→ ${best.hit}` });
    }
  }
  // the same place twice in a row is no move
  const seq: typeof picks = [];
  for (const k of picks) if (!seq.length || groupOf(seq.at(-1)!.bg) !== groupOf(k.bg)) seq.push(k);
  let start: BackgroundEntry | undefined;
  if (seq[0] && paras[0] && seq[0].para === paras[0].index) {
    start = seq.shift()!.bg;
  }
  const moves: BgMove[] = [];
  let cur = start ?? current;
  for (const k of seq) {
    if (k.bg.id === cur.id || groupOf(k.bg) === groupOf(cur)) continue;
    if (moves.length >= MAX_BG_MOVES) break;
    moves.push({ paragraph: k.para, backgroundId: k.bg.id, reason: k.why, transition: 'cut' });
    cur = k.bg;
  }
  return { ...(start ? { start } : {}), moves };
}
