/**
 * Splitting a line that does not fit the dialogue area into consecutive lines of the same speaker, and the shared validation of any
 * such split (`checkPieces`: used by the deterministic splitter, the AI split pass, the editor and the agent).
 *
 * The splitter is pure and deterministic (no randomness, no clock). Break points are scored by what the original does at a pause:
 *   after ！？ (and closers)                           0
 *   after …… / —— when the next piece opens with a turn   0   (otherwise 1.5)
 *   after 。                                           1
 *   after ；：                                          2.5
 *   after ，、                                          3
 *   anywhere else (width break)                        10, with a warning
 * and a piece that opens with a turn word (不过 / 可是 / 啊 ...) or `……` gets a bonus of -0.5. Only break points outside of brackets are
 * used, unless nothing else works. The objective, in order: fewest pieces, then the fewest lines in the longest piece, then the lowest
 * break cost, then the most even pieces; a piece shorter than 4 characters is heavily penalised (no lonely 「好吗？」).
 * Text is never changed: pieces concatenate back to the original (only whitespace at the cuts is dropped).
 */
import { dialogWidthEm, fitsDialog, type DialogMetrics, type DialogVariant } from '../style/dialogLayout';
import { isPunctuationOnly } from './punctuationLines';

export type SplitStyle = DialogMetrics;

const OPEN_CLOSE: Record<string, string> = { '（': '）', '(': ')', '「': '」', '『': '』', '“': '”', '‘': '’', '【': '】', '［': '］', '[': ']' };
const CLOSERS = new Set(Object.values(OPEN_CLOSE));
/** Wrappers a whole line may be enclosed in: each piece is wrapped by the same pair. */
const WRAPPERS = new Set(['（', '(', '「', '『']);
const NO_START = new Set([...'，。、！？；：）〕］｝〉》」』】”’,.!?;:)]}…‥—―～〜ー々ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ・']);
const NO_END = new Set([...'（〔［｛〈《「『【“‘([{']);
const ELLIPSIS = new Set(['…', '—', '―']);
const TURN = /^(不过|但是|可是|然而|只是|所以|总之|其实|难道|明明|还是|算了|对了|话说|那个|而且|啊|诶|欸|嗯|呜|唉|哈|…)/u;

const isWs = (c: string) => c === ' ' || c === '\u3000' || c === '\n' || c === '\t' || c === '\r';
const trim = (s: string) => s.replace(/^[\s\u3000]+|[\s\u3000]+$/gu, '');
const meaningful = (s: string) => [...s].filter((c) => !isWs(c) && !NO_START.has(c) && !NO_END.has(c) && !CLOSERS.has(c)).length;

export interface Wrapper {
  open: string;
  close: string;
  inner: string;
}

/** The pair that encloses the WHOLE text (「…」 （…） 『…』), or null. `（a）（b）` is not wrapped. */
export function wrapperOf(text: string): Wrapper | null {
  const t = trim(text);
  const cs = [...t];
  if (cs.length < 2) return null;
  const open = cs[0]!;
  if (!WRAPPERS.has(open) || cs[cs.length - 1] !== OPEN_CLOSE[open]) return null;
  const stack: string[] = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    if (OPEN_CLOSE[c] !== undefined) stack.push(OPEN_CLOSE[c]!);
    else if (CLOSERS.has(c)) {
      if (stack[stack.length - 1] === c) stack.pop();
      if (stack.length === 0 && i < cs.length - 1) return null;
    }
  }
  if (stack.length !== 0) return null;
  return { open, close: OPEN_CLOSE[open]!, inner: cs.slice(1, -1).join('') };
}

/** Bracket depth before each character (0 = outside any pair). */
function depthsOf(cs: string[]): number[] {
  const out: number[] = [];
  const stack: string[] = [];
  for (const c of cs) {
    out.push(stack.length);
    if (OPEN_CLOSE[c] !== undefined) stack.push(OPEN_CLOSE[c]!);
    else if (CLOSERS.has(c) && stack[stack.length - 1] === c) stack.pop();
  }
  return out;
}

interface SegInfo {
  text: string;
  lines: number;
  len: number;
  short: number;
}

interface Prep {
  cache: Map<number, SegInfo>;
  cs: string[];
  wrap: Wrapper | null;
  style: SplitStyle;
  variant: DialogVariant;
}

const segText = (p: Prep, i: number, j: number) => trim(p.cs.slice(i, j).join(''));
const withWrap = (p: Prep, t: string) => (p.wrap ? p.wrap.open + t + p.wrap.close : t);
/** Text, line count and size of the piece [i, j), measured once per pair. */
function seg(p: Prep, i: number, j: number): SegInfo {
  const key = i * (p.cs.length + 1) + j;
  let info = p.cache.get(key);
  if (!info) {
    const text = segText(p, i, j);
    const lines = fitsDialog(withWrap(p, text), p.style, p.variant).lines;
    info = { text, lines, len: [...text].length, short: meaningful(text) < 4 && !isPunctuationOnly(text) ? 50 : 0 };
    p.cache.set(key, info);
  }
  return info;
}
const segLines = (p: Prep, i: number, j: number) => seg(p, i, j).lines;

/** Index of the first / last non-whitespace character at or after / before a position. */
const nextIdx = (cs: string[], p: number) => { let k = p; while (k < cs.length && isWs(cs[k]!)) k++; return k; };
const prevIdx = (cs: string[], p: number) => { let k = p - 1; while (k >= 0 && isWs(cs[k]!)) k--; return k; };

/** May the text be cut before position p (the first character of the next piece)? */
function validCut(cs: string[], p: number): boolean {
  const a = prevIdx(cs, p);
  const b = nextIdx(cs, p);
  if (a < 0 || b >= cs.length) return false;
  const before = cs[a]!;
  const after = cs[b]!;
  // an author newline between the two is a real line break: nothing is prohibited there
  for (let k = a + 1; k < b; k++) if (cs[k] === '\n') return true;
  if (NO_END.has(before) || NO_START.has(after)) return false;
  if (ELLIPSIS.has(before) && ELLIPSIS.has(after) && before === after) return false;
  return true;
}

/** Cost of a cut at p (-1: not a pause). `soft` cuts are after punctuation; the rest are width breaks. */
function cutCost(cs: string[], p: number): { cost: number; soft: boolean } {
  let a = prevIdx(cs, p);
  // closers belong to the mark before them
  while (a > 0 && CLOSERS.has(cs[a]!)) a--;
  const c = cs[a] ?? '';
  const b = nextIdx(cs, p);
  const rest = cs.slice(b, b + 4).join('');
  const turn = TURN.test(rest);
  let cost: number;
  let soft = true;
  if ('！？!?'.includes(c)) cost = 0;
  else if (ELLIPSIS.has(c)) cost = turn ? 0 : 1.5;
  else if ('。.'.includes(c)) cost = 1;
  else if ('；：;:'.includes(c)) cost = 2.5;
  else if ('，、,'.includes(c)) cost = 3;
  else { cost = 10; soft = false; }
  if (soft && turn) cost -= 0.5;
  return { cost, soft };
}

interface Plan {
  /** Cut positions (ascending), the first piece starts at 0. */
  cuts: number[];
  cost: number;
  hard: number;
}

/**
 * Best split into exactly `k` pieces, every piece at most `cap` lines, using cuts of kind `allow`. Returns null when impossible.
 * Minimises (total cost, sum of squared piece widths) lexicographically; both are additive, so the dynamic programme is exact.
 */
function bestPlan(p: Prep, k: number, cap: number, allow: (pos: number) => { ok: boolean; cost: number; hard: boolean }): Plan | null {
  const n = p.cs.length;
  const INF = Number.POSITIVE_INFINITY;
  // dp[m][j]: best (cost, sumSq) for the first j characters in m pieces
  const costs: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(INF));
  const sq: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(INF));
  const from: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(-1));
  costs[0]![0] = 0;
  sq[0]![0] = 0;
  const cutInfo = new Map<number, { ok: boolean; cost: number; hard: boolean }>();
  const cut = (pos: number) => {
    let c = cutInfo.get(pos);
    if (!c) { c = pos === 0 || pos === n ? { ok: true, cost: 0, hard: false } : allow(pos); cutInfo.set(pos, c); }
    return c;
  };
  for (let m = 1; m <= k; m++) {
    for (let i = 0; i < n; i++) {
      if (costs[m - 1]![i] === INF) continue;
      if (i > 0 && !cut(i).ok) continue;
      if (isWs(p.cs[i]!) && i > 0) continue;
      for (let j = i + 1; j <= n; j++) {
        if (j < n && !cut(j).ok) continue;
        if (segLines(p, i, j) > cap) { if (!isWs(p.cs[j - 1]!)) break; else continue; }
        const info = seg(p, i, j);
        if (info.text === '') continue;
        const len = info.len;
        const short = info.short;
        const brk = j < n ? cut(j).cost : 0;
        const c = costs[m - 1]![i]! + brk + short;
        const s = sq[m - 1]![i]! + len * len;
        if (c < costs[m]![j]! || (c === costs[m]![j]! && s < sq[m]![j]!)) {
          costs[m]![j] = c;
          sq[m]![j] = s;
          from[m]![j] = i;
        }
      }
    }
  }
  if (costs[k]![n] === INF) return null;
  const cuts: number[] = [];
  let j = n;
  for (let m = k; m >= 1; m--) {
    const i = from[m]![j]!;
    if (i > 0) cuts.unshift(i);
    j = i;
  }
  return { cuts, cost: costs[k]![n]!, hard: cuts.filter((c) => cut(c).hard).length };
}

function prepare(text: string, style: SplitStyle, variant: DialogVariant): Prep {
  const t = trim(text);
  const wrap = wrapperOf(t);
  return { cache: new Map(), cs: [...(wrap ? wrap.inner : t)], wrap, style, variant };
}

/** Smallest number of pieces (cuts anywhere the prohibition rules allow, any bracket depth) that fit: the lower bound of `checkPieces`. */
export function minPiecesFor(text: string, style: SplitStyle, variant: DialogVariant = 'normal'): number {
  const p = prepare(text, style, variant);
  if (fitsDialog(trim(text), style, variant).lines <= style.maxLines) return 1;
  const n = p.cs.length;
  const best = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === Number.POSITIVE_INFINITY || (i > 0 && (!validCut(p.cs, i) || isWs(p.cs[i]!)))) continue;
    for (let j = i + 1; j <= n; j++) {
      if (j < n && !validCut(p.cs, j)) continue;
      if (segLines(p, i, j) > style.maxLines) { if (!isWs(p.cs[j - 1]!)) break; else continue; }
      if (seg(p, i, j).text !== '' && best[i]! + 1 < best[j]!) best[j] = best[i]! + 1;
    }
  }
  return Number.isFinite(best[n]) ? best[n]! : Math.ceil(fitsDialog(trim(text), style, variant).lines / style.maxLines);
}

export interface SplitResult {
  /** The pieces in order. One element (the text itself) when it already fits. Wrapped lines come back wrapped piece by piece. */
  pieces: string[];
  warnings: string[];
  /** The text had to be broken by width (no usable pause). */
  hardBreak: boolean;
}

/** Split `text` so that every piece fits `style.maxLines`. A text that fits comes back unchanged. */
export function splitForDialog(text: string, style: SplitStyle, variant: DialogVariant = 'normal'): SplitResult {
  if (!fitsDialog(text, style, variant).over) return { pieces: [text], warnings: [], hardBreak: false };
  const p = prepare(text, style, variant);
  const cs = p.cs;
  const depth = depthsOf(cs);
  const minAll = minPiecesFor(text, style, variant);
  const softOnly = (pos: number) => {
    if (!validCut(cs, pos) || depth[pos]! !== 0) return { ok: false, cost: 0, hard: false };
    const c = cutCost(cs, pos);
    return { ok: c.soft, cost: c.cost, hard: false };
  };
  const anyCut = (pos: number) => {
    if (!validCut(cs, pos)) return { ok: false, cost: 0, hard: false };
    const c = cutCost(cs, pos);
    // breaking inside a quote or bracket is the last resort
    return { ok: true, cost: c.cost + (depth[pos]! > 0 ? 4 : 0), hard: !c.soft };
  };
  const maxLines = style.maxLines;
  const run = (allow: typeof anyCut, limit: number): { plan: Plan; k: number } | null => {
    for (let k = 1; k <= limit; k++) {
      if (k === 1) continue;
      if (bestPlan(p, k, maxLines, allow)) {
        // the fewest lines in the longest piece for this count
        for (let cap = 1; cap <= maxLines; cap++) {
          const plan = bestPlan(p, k, cap, allow);
          if (plan) return { plan, k };
        }
      }
    }
    return null;
  };
  // pauses only count when they do not cost more than one extra piece over the best a width break could do
  let found = run(softOnly, minAll + 1);
  let hardBreak = false;
  if (!found) {
    found = run(anyCut, minAll + 6);
    hardBreak = !!found && found.plan.hard > 0;
  }
  if (!found) {
    // cannot happen for ordinary text (a width break always exists); keep the text whole and say so
    return { pieces: [text], warnings: ['这句话无法拆开：找不到可用的断点'], hardBreak: true };
  }
  const bounds = [0, ...found.plan.cuts, cs.length];
  const pieces: string[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) pieces.push(withWrap(p, segText(p, bounds[i]!, bounds[i + 1]!)));
  const warnings: string[] = [];
  if (hardBreak) warnings.push('没有合适的标点停顿，按行宽硬断');
  return { pieces, warnings, hardBreak };
}

// ---- checkPieces -----------------------------------------------------------------------------------------------

export interface CheckPiecesOptions {
  /** Extra pieces allowed over the minimum (default 1: one more cut for a turn of emotion). */
  maxExtra?: number;
  /** Absolute cap on the number of pieces (the agent allows 4). */
  maxPieces?: number;
}

export interface CheckPiecesResult {
  ok: boolean;
  /** Problems that make the answer unusable (text differs, too long, bad count, empty pieces). */
  problems: string[];
  /** The pieces after the automatic repair (wrapping re-added). Only meaningful when `ok`. */
  pieces: string[];
  /** Repairs made without it being an error (a bracket pair that was missing was added). */
  repairs: string[];
  minPieces: number;
  maxPieces: number;
  /** Lines of each piece (after repair). */
  lines: number[];
}

const preview = (s: string) => `『${[...s].slice(0, 8).join('')}${[...s].length > 8 ? '…' : ''}』`;

/**
 * Validate a split of `original`: (2) the pieces concatenate back to the text exactly (only whitespace at the cuts may go), (3) a text that
 * is wrapped in a bracket pair has every piece wrapped in the same pair (re-added when missing), (4) every piece fits, (5) the count is
 * between `minPieces` and `minPieces + maxExtra`, (6) no empty piece, and a punctuation-only piece must be a pause.
 */
export function checkPieces(original: string, pieces: readonly string[], style: SplitStyle, variant: DialogVariant = 'normal', opts: CheckPiecesOptions = {}): CheckPiecesResult {
  const problems: string[] = [];
  const repairs: string[] = [];
  const minPieces = minPiecesFor(original, style, variant);
  const maxPieces = Math.min(opts.maxPieces ?? Number.POSITIVE_INFINITY, minPieces + (opts.maxExtra ?? 1));
  const out: string[] = [];
  const result = (): CheckPiecesResult => ({ ok: problems.length === 0, problems, pieces: out, repairs, minPieces, maxPieces, lines: out.map((x) => fitsDialog(x, style, variant).lines) });
  if (pieces.length === 0) {
    problems.push('没有给出任何一段');
    return result();
  }
  const fits = !fitsDialog(original, style, variant).over;
  if (fits && !(pieces.length === 1)) {
    problems.push('这句放得下，不应该拆');
  }
  const wrap = wrapperOf(original);
  const src = [...(wrap ? wrap.inner : trim(original))];
  let pos = 0;
  let broken = false;
  /** Does `bs` match the source at `at` (whitespace before it skipped)? Returns the end position or -1, plus the first mismatch. */
  const matchAt = (bs: string[], at: number): { end: number; bad?: number; atSrc?: number } => {
    let q = at;
    while (q < src.length && isWs(src[q]!) && !isWs(bs[0]!)) q++;
    for (let k = 0; k < bs.length; k++) {
      if (q >= src.length) return { end: -1, bad: k, atSrc: -1 };
      if (bs[k] !== src[q]) return { end: -1, bad: k, atSrc: q };
      q++;
    }
    return { end: q };
  };
  pieces.forEach((raw, idx) => {
    if (broken) return;
    const n = idx + 1;
    const whole = trim(raw);
    if (whole === '') {
      problems.push(`第 ${n} 段是空的`);
      broken = true;
      return;
    }
    // a wrapped line: the piece should carry the pair (re-added when it does not); the inner text may hold half of a nested pair
    const candidates: Array<{ body: string; wrapped: boolean }> = [];
    if (wrap && whole.startsWith(wrap.open) && whole.endsWith(wrap.close) && [...whole].length >= 2) candidates.push({ body: trim(whole.slice(wrap.open.length, whole.length - wrap.close.length)), wrapped: true });
    candidates.push({ body: whole, wrapped: false });
    let hit: { body: string; wrapped: boolean; end: number } | null = null;
    for (const c of candidates) {
      if (c.body === '') continue;
      const m = matchAt([...c.body], pos);
      if (m.end >= 0) { hit = { ...c, end: m.end }; break; }
    }
    if (!hit) {
      const first = candidates.find((c) => c.body !== '') ?? candidates[0]!;
      const bs = [...first.body];
      const m = matchAt(bs, pos);
      const k = m.bad ?? 0;
      if (m.atSrc === -1) problems.push(`拼接后与原文不同：第 ${n} 段多出了 ${preview(bs.slice(k).join(''))}`);
      else problems.push(`拼接后与原文不同：第 ${n} 段「${bs.slice(k, k + 6).join('')}」处与原文不符（原文是「${src.slice(m.atSrc ?? 0, (m.atSrc ?? 0) + 6).join('')}」）`);
      broken = true;
      return;
    }
    if (wrap && !hit.wrapped) repairs.push(`第 ${n} 段缺少 ${wrap.open}${wrap.close}，已补上`);
    pos = hit.end;
    out.push(wrap ? wrap.open + hit.body + wrap.close : hit.body);
  });
  if (problems.length === 0) {
    while (pos < src.length && isWs(src[pos]!)) pos++;
    if (pos < src.length) problems.push(`拼接后与原文不同：漏了原文末尾的 ${preview(src.slice(pos).join(''))}`);
  }
  if (problems.length === 0) {
    out.forEach((piece, i) => {
      const f = fitsDialog(piece, style, variant);
      if (f.over) problems.push(`第 ${i + 1} 段是 ${f.lines} 行，超出 ${style.maxLines} 行`);
    });
    if (!fits && out.length < minPieces) problems.push(`至少要拆成 ${minPieces} 段，现在只有 ${out.length} 段`);
    if (out.length > maxPieces && !fits) problems.push(`最多 ${maxPieces} 段，现在有 ${out.length} 段`);
    // a piece made only of punctuation is allowed as a pause, never as a stray tail after the text ended in something else
    const punctOnly = out.map((x) => isPunctuationOnly(wrap ? x.slice(1, -1) : x));
    if (out.length > 1 && punctOnly.every(Boolean)) problems.push('每一段都只有标点');
  }
  return result();
}

/** Characters per line is only a reference for prompts: the capacity in em as a whole number of CJK characters. */
export const charsPerLine = (style: Pick<DialogMetrics, 'textSize' | 'textWidth'>): number => Math.floor(dialogWidthEm(style) + 1e-6);

