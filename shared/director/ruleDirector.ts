/**
 * Deterministic "rule director": the no-key fallback of both AI passes. It produces exactly the shapes the models are asked
 * for (Breakdown / SceneDirection) from the text alone, so validation, expansion, locks and the UI are the same code path.
 * Everything it decides is stamped `source: 'rule'` and the UI calls it "规则生成（非 AI）".
 *
 * Heuristics (Chinese novels): a quoted passage is dialogue, the speaker is the first known name next to the quote (before it,
 * else after it, else the other person of the conversation); keywords pick emotion, time of day, place and outfit;
 * shots follow a fixed rhythm (group to open, mcu on the speaker, a two-shot every few lines).
 */
import type { Breakdown, DirectedBeat, SceneDirection } from '../schema/ai';
import type { ActorResources } from './catalogDigest';
import { EMOTION_EXPR, EMOTION_GESTURE } from '../timeline/compile';
import { detectChapters, isHeading, type Paragraph } from './paragraphs';
export { detectChapters, isHeading };
import { allowedBackgrounds, sceneBands } from './bandFit';
import { defaultModel, lookup, rankBackgrounds, selectable, type DirectorCatalog } from './resources';

// ---- names -----------------------------------------------------------------------------------------------------
export interface NameIndex {
  /** Longest names first. */
  names: Array<{ text: string; key: string }>;
}

const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;

export function nameIndex(cat: DirectorCatalog): NameIndex {
  const seen = new Map<string, string>();
  for (const c of cat.characters) {
    if (c.isSub) continue;
    for (const n of [c.name, c.nickname ?? '', ...c.aliases]) {
      const t = n.trim();
      if (t.length >= 1 && CJK.test(t) && !seen.has(t)) seen.set(t, c.key);
    }
  }
  return { names: [...seen.entries()].map(([text, key]) => ({ text, key })).sort((a, b) => b.text.length - a.text.length) };
}

/** Known names in `text` with their position, left to right (a longer name hides the shorter ones inside it). */
export function mentions(idx: NameIndex, text: string): Array<{ key: string; at: number }> {
  const taken: boolean[] = [];
  const out: Array<{ key: string; at: number }> = [];
  for (const n of idx.names) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(n.text, from);
      if (at < 0) break;
      from = at + n.text.length;
      if (taken.slice(at, at + n.text.length).some(Boolean)) continue;
      for (let i = at; i < at + n.text.length; i++) taken[i] = true;
      out.push({ key: n.key, at });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---- text features -----------------------------------------------------------------------------------------------
const QUOTES: Array<[string, string]> = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"']];

export interface Segment {
  kind: 'narration' | 'dialogue';
  text: string;
  /** Narration around the quote (used for speaker detection). */
  before: string;
  after: string;
}

/** Splits a paragraph into narration and quoted speech, in order. */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let rest = text;
  let before = '';
  for (let guard = 0; guard < 30 && rest.length > 0; guard++) {
    let best: { at: number; end: number; open: string } | null = null;
    for (const [o, c] of QUOTES) {
      const at = rest.indexOf(o);
      if (at < 0 || (best && at >= best.at)) continue;
      const end = rest.indexOf(c, at + 1);
      if (end > at) best = { at, end, open: o };
    }
    if (!best) break;
    const narr = rest.slice(0, best.at).trim();
    if (narr) out.push({ kind: 'narration', text: narr, before: '', after: '' });
    const speech = rest.slice(best.at + 1, best.end).trim();
    const after = rest.slice(best.end + 1);
    if (speech) out.push({ kind: 'dialogue', text: speech, before: narr || before, after });
    before = narr;
    rest = after;
    // narration right after a quote belongs to the next iteration (it may announce the speaker: "…”爱音说。")
    const next = QUOTES.map(([o]) => rest.indexOf(o)).filter((i) => i >= 0);
    if (next.length === 0) {
      const tail = rest.trim();
      if (tail) out.push({ kind: 'narration', text: tail, before: '', after: '' });
      rest = '';
    }
  }
  const tail = rest.trim();
  if (tail) out.push({ kind: 'narration', text: tail, before: '', after: '' });
  return out;
}

const EMOTION_WORDS: Array<[string, RegExp]> = [
  ['angry', /生气|愤怒|怒|瞪|哼|不耐烦|别开玩笑|烦死|吵死|气得|皱眉/],
  ['sad', /哭|泪|难过|低落|沮丧|失落|悲伤|低下头|沉默|呜|抱歉|对不起|消沉/],
  ['surprised', /惊|吓|诶|咦|哎|什么！|怎么会|居然|竟然|瞪大|愣住|猛地/],
  ['shy', /脸红|害羞|不好意思|羞|小声|支吾|慌张|结结巴巴|低声/],
  ['happy', /笑|开心|高兴|太好了|耶|哈哈|欢呼|期待|兴奋|雀跃|愉快|嘻|眼睛亮/],
  ['thinking', /想|犹豫|思考|琢磨|回忆|似乎|也许|或许|……|不知道|沉吟|嗯/],
  ['serious', /认真|严肃|坚定|决心|必须|一定|郑重|点头|盯着|凝视/],
];

export function emotionOf(text: string): string {
  for (const [e, re] of EMOTION_WORDS) if (re.test(text)) return e;
  return /[？?]$/.test(text.trim()) ? 'thinking' : 'neutral';
}

const TIME_WORDS: Array<[string, RegExp]> = [
  ['夜晚', /深夜|夜晚|夜里|夜色|晚上|星星|月光|路灯亮|入夜|天黑/],
  ['傍晚', /傍晚|黄昏|夕阳|放学后|日落|晚霞/],
  ['早晨', /清晨|早晨|早上|晨光|天刚亮|日出/],
  ['白天', /中午|午后|下午|白天|午休|课间|上午/],
];
export function timeOfDayOf(text: string): string {
  const now = text.replace(/[昨前]天?[晚夜][上里]?|昨夜|昨晚/g, '');
  for (const [t, re] of TIME_WORDS) if (re.test(now)) return t;
  return '白天';
}
const BG_TIME: Record<string, string> = { 夜晚: '夜间', 傍晚: '傍晚', 早晨: '日间', 白天: '日间' };

const PERFORMANCE_RE = /开演|登台|正式演出|演出开始|演奏|舞台上|Live|live|灯光暗下|聚光灯|站上舞台|主唱|开场/;
const SCHOOL_RE = /校服|教室|放学|学校|羽丘|月之森|上课|午休|铃声/;
const CASUAL_RE = /便服|私服|换衣服|换上了|宽松的/;
const SCENE_BREAK_RE = /^\s*([-*_＊·◇◆■□#]{3,}|[-—]{3,}|\*\s*\*\s*\*)\s*$/;
const SHIFT_RE = /^(第二天|次日|翌日|几天后|数日后|夜晚|晚上|傍晚|黄昏|清晨|早晨|中午|下午|放学后|周末|一周后|转眼|与此同时|另一边|回到|来到|走进|走出|抵达|到了|三十分钟后|半小时后|一小时后|不久后)/;
// ---- Pass 1 ------------------------------------------------------------------------------------------------------
export interface RuleBreakdownOptions {
  maxScene?: number;
  minScene?: number;
}

export function ruleBreakdown(cat: DirectorCatalog, paras: readonly Paragraph[], opt: RuleBreakdownOptions = {}): Breakdown {
  const maxScene = opt.maxScene ?? 14;
  const minScene = opt.minScene ?? 3;
  const L = lookup(cat);
  const idx = nameIndex(cat);

  // 1) scene boundaries
  const starts: number[] = [0];
  let lastStart = 0;
  paras.forEach((p, i) => {
    if (i === 0) return;
    const count = i - lastStart;
    const prev = paras[i - 1]!;
    const dialogue = segments(p.text).some((s) => s.kind === 'dialogue');
    const brk = isHeading(p.text) || SCENE_BREAK_RE.test(prev.text);
    const shift = !dialogue && SHIFT_RE.test(p.text.trim()) && count >= minScene;
    if (SCENE_BREAK_RE.test(p.text)) return;
    // a book title right above the first chapter heading does not make a scene of its own
    const onlyHeadings = paras.slice(lastStart, i).every((q) => isHeading(q.text));
    if ((brk && !onlyHeadings) || shift || count >= maxScene) {
      starts.push(i);
      lastStart = i;
    }
  });
  const ranges = starts.map((s, k) => ({ start: s, end: (starts[k + 1] ?? paras.length) - 1 }));

  // 2) per scene
  const scenes: Breakdown['scenes'] = [];
  const castSeen = new Map<string, string>();
  let prevCast: string[] = [];
  let prevWear = new Map<string, string>();
  ranges.forEach((r, n) => {
    const slice = paras.slice(r.start, r.end + 1);
    const text = slice.map((p) => p.text).join('\n');
    const counts = new Map<string, number>();
    for (const m of mentions(idx, text)) counts.set(m.key, (counts.get(m.key) ?? 0) + 1);
    for (const [k] of counts) if (!castSeen.has(k)) castSeen.set(k, L.characters.get(k)?.nickname ?? L.characters.get(k)?.name ?? k);
    let present = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    if (present.length === 0) present = prevCast.length > 0 ? prevCast : [cat.characters.find((c) => !c.isSub)?.key ?? '001'];
    // keep the order of first appearance
    const first = new Map<string, number>();
    mentions(idx, text).forEach((m, i) => { if (!first.has(m.key)) first.set(m.key, i); });
    present = [...new Set(present)].sort((a, b) => (first.get(a) ?? 99) - (first.get(b) ?? 99)).slice(0, 6);

    const tod = timeOfDayOf(text);
    const perf = PERFORMANCE_RE.test(text);
    const school = SCHOOL_RE.test(text) && !CASUAL_RE.test(text) && !perf;
    const lead = slice.filter((q, qi) => slice.slice(0, qi + 1).every((x) => isHeading(x.text)));
    const heading = lead.length > 0 ? lead.at(-1)!.text.replace(/^#+\s*/, '').trim() : '';
    const all = cat.backgrounds.filter((b) => b.kind !== 'decorative');
    const who = { bands: sceneBands(L.characters, present), cast: present, mood: emotionOf(text), text };
    // only backgrounds that fit the bands on stage (and stages for a performance); never unknown ones, generic as the last resort
    const fits = (pool: typeof all, performance: boolean) => allowedBackgrounds(pool, who, { performance, rules: cat.labelRules }).ok;
    let pool = fits(all, perf);
    if (pool.length === 0) pool = fits(all, false);
    if (pool.length === 0) pool = all.filter((b) => !b.labels || b.labels.bands.includes('generic'));
    const bgs = pool;
    const ranked = rankBackgrounds(bgs.length > 0 ? bgs : cat.backgrounds, `${heading} ${text}`, { setting: /室外|街|路|天台|公园|河|海/.test(text) ? '室外' : '室内', time: BG_TIME[tod] ?? '日间' });
    const bg = ranked[0]!;
    const bandOf = perf ? majorityBand(cat, present) : null;

    const wardrobe = present.map((k) => {
      const live = perf ? defaultModel(L, k, { live: true }) : null;
      const models = (L.modelsOf.get(k) ?? []).filter((m) => selectable(m));
      const schoolM = school ? models.find((m) => m.costumeInfo.base === 'school' && !m.costumeInfo.glasses && (m.costumeInfo.season === 'summer' || m.costumeInfo.season === 'winter')) : undefined;
      const keep = prevWear.get(k) && !perf && !school ? models.find((m) => m.id === prevWear.get(k)) : undefined;
      const pick = live ?? schoolM ?? keep ?? defaultModel(L, k);
      return { characterKey: k, modelId: pick?.id ?? '', reason: perf ? '正式演出：演奏服装' : schoolM ? '校园场景：校服' : keep ? '沿用上一场景的服装' : '日常：默认便服' };
    }).filter((w) => w.modelId !== '');
    prevWear = new Map(wardrobe.map((w) => [w.characterKey, w.modelId]));
    prevCast = present;

    scenes.push({
      title: heading || `场景 ${n + 1}`,
      startParagraph: r.start,
      endParagraph: r.end,
      location: { backgroundId: bg.id, reason: `关键词匹配：${bg.name}（${tod}）` },
      timeOfDay: tod,
      presentCast: wardrobe.map((w) => w.characterKey),
      wardrobe,
      mood: emotionOf(text),
      isPerformance: perf,
      band: bandOf,
    });
  });
  return { cast: [...castSeen.entries()].map(([k, name]) => ({ nameInText: name, characterKey: k, evidence: '名称匹配' })), scenes };
}

function majorityBand(cat: DirectorCatalog, keys: readonly string[]): string | null {
  const count = new Map<string, number>();
  for (const k of keys) {
    const b = cat.characters.find((c) => c.key === k)?.bandKey;
    if (b) count.set(b, (count.get(b) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? (cat.bands.find((b) => b.key === top[0])?.name ?? top[0]) : null;
}

// ---- Pass 2 ------------------------------------------------------------------------------------------------------
export interface RuleSceneInput {
  cast: ActorResources[];
  paragraphs: Array<{ i: number; text: string }>;
  previousScene: unknown;
  isPerformance: boolean;
  fixedBeats: Array<{ keepId: string; paragraph: number; kind: string; speaker: string | null; text: string }>;
}

const pickFrom = (cands: readonly string[], have: readonly string[], salt: number): string | null => {
  const ok = cands.filter((c) => have.includes(c));
  return ok.length > 0 ? ok[salt % ok.length]! : null;
};

export function ruleDirection(idx: NameIndex, cat: DirectorCatalog, input: RuleSceneInput): SceneDirection {
  const nameOfCast = new Map(input.cast.map((c) => [c.castId, c]));
  const byKey = new Map(input.cast.map((c) => [c.characterKey, c]));
  const beats: DirectedBeat[] = [];
  let lastSpeaker: string | null = null;
  let dialogueCount = 0;
  let sinceWide = 0;
  const fixedBy = new Map<number, typeof input.fixedBeats>();
  for (const f of input.fixedBeats) fixedBy.set(f.paragraph, [...(fixedBy.get(f.paragraph) ?? []), f]);
  const everyone = input.cast.map((c) => c.castId);

  const speakerOf = (seg: Segment): string | null => {
    const near = (s: string, last: boolean) => {
      const m = mentions(idx, s).filter((x) => byKey.has(x.key));
      return (last ? m.at(-1) : m[0])?.key ?? null;
    };
    const key = near(seg.after.slice(0, 18), false) ?? near(seg.before.slice(-18), true);
    if (key) return byKey.get(key)!.castId;
    // otherwise the other person of the conversation
    const others = input.cast.filter((c) => c.castId !== lastSpeaker);
    return (others[dialogueCount % Math.max(1, others.length)] ?? input.cast[0])?.castId ?? null;
  };

  const directed = (para: number, seg: Segment | { kind: 'narration'; text: string }, forced?: { kind: string; speaker: string | null; keepId: string }): DirectedBeat => {
    const dialogue = forced ? forced.kind === 'dialogue' : seg.kind === 'dialogue';
    const speaker = forced ? forced.speaker : dialogue ? speakerOf(seg as Segment) : null;
    const emotion = emotionOf(seg.text);
    const mentioned = mentions(idx, seg.text).map((m) => byKey.get(m.key)?.castId).filter((c): c is string => !!c);
    const focusId = speaker ?? mentioned[0] ?? null;
    const first = beats.length === 0;
    let type: DirectedBeat['shot']['type'];
    let focus: string[];
    if (first && everyone.length >= 2) { type = 'group'; focus = everyone.slice(0, 4); sinceWide = 0; }
    else if (dialogue && speaker) {
      sinceWide++;
      const partner = everyone.find((c) => c !== speaker && c === lastSpeaker) ?? everyone.find((c) => c !== speaker);
      if (everyone.length >= 2 && sinceWide >= 4 && partner) { type = 'two_shot'; focus = [speaker, partner]; sinceWide = 0; }
      else if (emotion === 'surprised' || emotion === 'angry' || (emotion === 'sad' && seg.text.length < 14)) { type = 'cu'; focus = [speaker]; }
      else { type = 'mcu'; focus = [speaker]; }
    } else if (focusId && !first) { type = 'mcu'; focus = [focusId]; }
    else { type = everyone.length >= 2 ? 'group' : 'mcu'; focus = everyone.slice(0, 3); }
    const actors: DirectedBeat['actors'] = [];
    const who = speaker ?? focusId;
    const res = who ? nameOfCast.get(who) : undefined;
    if (res) {
      const salt = beats.length;
      const gest = emotion === 'neutral' && !dialogue ? null : pickFrom(EMOTION_GESTURE[emotion] ?? [], res.motions, salt);
      const expr = pickFrom(EMOTION_EXPR[emotion] ?? [], res.expressions, salt);
      const target = emotion === 'shy' || emotion === 'sad' ? 'down' : (dialogue ? (everyone.find((c) => c !== who) ?? null) : null);
      actors.push({ castId: res.castId, motion: gest, expression: expr, attention: target, enter: false, exit: false, move: null });
    }
    return {
      keepId: forced?.keepId ?? null, paragraph: para, kind: dialogue ? 'dialogue' : 'narration', speaker: dialogue ? speaker : null, text: seg.text,
      emotion, reason: '规则：关键词与固定节奏', shot: { type, focus, move: type === 'cu' && emotion !== 'neutral' ? 'push_in' : 'static', dof: null },
      cutIn: 'cut', fx: 'none', actors,
    } as DirectedBeat;
  };

  for (const p of input.paragraphs) {
    const fixed = fixedBy.get(p.i);
    if (fixed) {
      for (const f of fixed) {
        const b = directed(p.i, { kind: f.kind === 'dialogue' ? 'dialogue' : 'narration', text: f.text, before: '', after: '' } as Segment, { kind: f.kind, speaker: f.speaker, keepId: f.keepId });
        beats.push({ ...b, kind: (f.kind as DirectedBeat['kind']) });
        if (f.speaker) lastSpeaker = f.speaker;
      }
      continue;
    }
    if (isHeading(p.text)) continue;
    for (const seg of segments(p.text)) {
      const b = directed(p.i, seg);
      if (b.kind === 'dialogue') { lastSpeaker = b.speaker; dialogueCount++; }
      beats.push(b);
    }
  }
  return {
    reason: '规则导演（非 AI）：按引号识别对白，按名字匹配说话人，按关键词选情绪，镜头按固定节奏。',
    blocking: [],
    transitionIn: input.previousScene ? 'scene_black' : 'cut',
    bgm: null,
    beats,
    costumeChanges: [],
  };
}
