/**
 * Dialogue-box layout: the single source of truth for "how many lines does this text take in the dialogue area".
 *
 * Everything is measured in em (the font size), so it does not depend on the resolution: a style gives the column width and the font size
 * as shares of the stage height, and `textWidth / textSize` is the line capacity in em (31.47 for the default style: 31 CJK characters).
 * Line breaking follows what the browser does with `word-break: break-all` plus the basic Japanese/Chinese prohibition rules (kinsoku):
 *   - a line never starts with a closing mark, `，。！？…` and the like, nor with a small kana or `ー`; the previous character comes down with it;
 *   - a line never ends with an opening bracket;
 *   - `……` and `——` are never torn apart;
 *   - `\n` (written by the author) always breaks the line.
 * The DialogBox renders the explicit lines computed here (`white-space: pre`), so the measurement and the picture agree by construction.
 * Pure: no DOM, no randomness.
 */

/** The part of the dialogue style the layout reads (a subset of `UiStyle['dialog']`). */
export interface DialogMetrics {
  textSize: number;
  textWidth: number;
  maxLines: number;
  monologueBrackets: boolean;
}

export type DialogVariant = 'normal' | 'monologue' | 'offscreen';

/** Characters a line must not start with (closing marks, stops, long-sound mark, small kana, iteration marks). */
const NO_START = new Set([...'，。、．，！？；：）〕］｝〉》」』】〗〙〛”’）,.!?;:)]}%‰…‥—―～〜ー々〻゛゜ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ・·']);
/** Characters a line must not end with (opening marks). */
const NO_END = new Set([...'（〔［｛〈《「『【〖〘〚“‘([{']);
const PAIR_RUN = new Set(['…', '—', '―']);

/** Width (em) of one character. CJK, kana, full-width marks and anything unknown are 1em; Latin text uses a conservative table. */
export function glyphWidth(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c === 0x20) return 0.28;
  if (c === 0x3000) return 1;
  if (c < 0x80) {
    if (ch >= '0' && ch <= '9') return 0.58;
    if (ch >= 'A' && ch <= 'Z') return ch === 'I' ? 0.34 : ch === 'M' || ch === 'W' ? 0.92 : 0.68;
    if (ch >= 'a' && ch <= 'z') return 'ilj'.includes(ch) ? 0.3 : 'frt'.includes(ch) ? 0.42 : ch === 'm' || ch === 'w' ? 0.88 : 0.58;
    if ('.,:;\'`|!'.includes(ch)) return 0.32;
    if ('()[]{}"-/\\'.includes(ch)) return 0.42;
    return 0.64;
  }
  if (c >= 0xff61 && c <= 0xff9f) return 0.5; // half-width katakana
  if (c >= 0xff10 && c <= 0xff19) return 1; // full-width digits
  return 1;
}

interface Atom {
  text: string;
  w: number;
  noStart: boolean;
  noEnd: boolean;
  space: boolean;
}

/** Characters grouped into layout atoms: `……` / `——` come in indivisible pairs. */
function atomsOf(chars: string[]): Atom[] {
  const out: Atom[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (PAIR_RUN.has(ch) && chars[i + 1] === ch) {
      out.push({ text: ch + ch, w: glyphWidth(ch) * 2, noStart: true, noEnd: false, space: false });
      i++;
      continue;
    }
    out.push({ text: ch, w: glyphWidth(ch), noStart: NO_START.has(ch), noEnd: NO_END.has(ch), space: ch === ' ' });
  }
  return out;
}

export interface DialogLine {
  text: string;
  /** True when the line ends with an author newline (`\n`), which is a character of the source text. */
  hard: boolean;
}

const EPS = 1e-6;

/** Break `text` into lines of at most `widthEm`. Always returns at least one line. */
export function layoutDialogLines(text: string, widthEm: number): DialogLine[] {
  const lines: DialogLine[] = [];
  let cur: Atom[] = [];
  let w = 0;
  const flush = (hard: boolean) => {
    lines.push({ text: cur.map((a) => a.text).join(''), hard });
    cur = [];
    w = 0;
  };
  const parts = text.split('\n');
  parts.forEach((part, pi) => {
    for (const a of atomsOf([...part])) {
      if (cur.length > 0 && !a.space && w + a.w > widthEm + EPS) {
        // break before `a`; pull characters down while the break would violate a prohibition
        const carry: Atom[] = [];
        let next = a;
        while (cur.length > 1 && (next.noStart || cur[cur.length - 1]!.noEnd)) {
          next = cur.pop()!;
          carry.unshift(next);
        }
        flush(false);
        cur = carry;
        w = carry.reduce((s, x) => s + x.w, 0);
      }
      // a space at the end of a full line hangs (costs nothing), as in the browser
      if (a.space && cur.length > 0 && w + a.w > widthEm + EPS) {
        cur.push(a);
        continue;
      }
      cur.push(a);
      w += a.w;
    }
    if (pi < parts.length - 1) flush(true);
  });
  flush(false);
  return lines;
}

/** Line capacity in em of a dialogue style. */
export const dialogWidthEm = (style: Pick<DialogMetrics, 'textSize' | 'textWidth'>): number => style.textWidth / style.textSize;

/** Does a monologue line get its brackets from the DialogBox (not when the text already starts with one)? */
export const monologueWraps = (text: string, variant: DialogVariant, style: Pick<DialogMetrics, 'monologueBrackets'>): boolean =>
  variant === 'monologue' && style.monologueBrackets && !/^[（(]/.test(text);

/** The text as the dialogue area shows it once complete (a monologue gets its brackets). */
export const displayText = (text: string, variant: DialogVariant, style: Pick<DialogMetrics, 'monologueBrackets'>): string =>
  monologueWraps(text, variant, style) ? `（${text}）` : text;

export interface FitResult {
  lines: number;
  max: number;
  over: boolean;
  /** The explicit lines (what the DialogBox renders). */
  rows: DialogLine[];
}

/** How many lines `text` takes in a dialogue area styled `style`, and whether that is more than `style.maxLines`. */
export function fitsDialog(text: string, style: DialogMetrics, variant: DialogVariant = 'normal'): FitResult {
  const rows = layoutDialogLines(displayText(text, variant, style), dialogWidthEm(style));
  return { lines: rows.length, max: style.maxLines, over: rows.length > style.maxLines, rows };
}

// ---- expand (`Beat.overflow = 'expand'`) ------------------------------------------------------------------------

/** Lines that fit below the default text top (original: the third line ends at 1016/1080, still inside the gradient). */
export const EXPAND_FREE_LINES = 3;
/** Lines shown at most while expanded; a longer text scrolls with the typewriter. */
export const EXPAND_MAX_VISIBLE = 6;

export interface ExpandPlan {
  /** Lines of the whole text (what the box is sized for from the first frame). */
  total: number;
  /** Lines visible at once (at most 6). */
  visible: number;
  /** Lines the whole dialogue area (gradient, name, rule, text) moves up. */
  shiftUp: number;
  /** More than 6 lines: the window follows the typewriter. */
  scroll: boolean;
}

/** n <= 3: grow down; 4..6: grow upward (the dialogue area moves up by n-3 lines); more than 6: six lines, scrolling with the typewriter. */
export function expandPlan(total: number): ExpandPlan {
  const visible = Math.min(total, EXPAND_MAX_VISIBLE);
  return { total, visible, shiftUp: Math.max(0, visible - EXPAND_FREE_LINES), scroll: total > EXPAND_MAX_VISIBLE };
}

/** The lines with the first `revealed` characters of the displayed text showing (author newlines count as one character each). */
export function revealRows(rows: readonly DialogLine[], revealed: number): string[] {
  const out: string[] = [];
  let rem = revealed;
  for (const row of rows) {
    const chars = [...row.text];
    const take = Math.min(rem, chars.length);
    out.push(chars.slice(0, take).join(''));
    rem -= take;
    if (rem <= 0 || take < chars.length) break;
    if (row.hard) rem -= 1;
  }
  return out;
}

export interface DialogView {
  /** The rows to render, top to bottom. */
  rows: string[];
  /** Lines of the whole text. */
  total: number;
  /** Lines the dialogue area moves up (expand only). */
  shiftUp: number;
}

/**
 * What the dialogue area shows for a line whose first `visibleChars` of `totalChars` characters are typed.
 * Not expanded: the first `maxLines` lines (the rest is cut, as before). Expanded: all lines up to 6, then a window that follows the typewriter.
 */
export function dialogView(text: string, variant: DialogVariant, style: DialogMetrics, visibleChars: number, totalChars: number, expand: boolean): DialogView {
  const fit = fitsDialog(text, style, variant);
  const wrap = monologueWraps(text, variant, style);
  const shown = visibleChars >= totalChars ? [...displayText(text, variant, style)].length : wrap ? 1 + visibleChars : visibleChars;
  const typed = revealRows(fit.rows, shown);
  if (!expand) return { rows: typed.slice(0, Math.max(1, style.maxLines)), total: fit.lines, shiftUp: 0 };
  const plan = expandPlan(fit.lines);
  const from = plan.scroll ? Math.max(0, typed.length - EXPAND_MAX_VISIBLE) : 0;
  return { rows: typed.slice(from, from + EXPAND_MAX_VISIBLE), total: fit.lines, shiftUp: plan.shiftUp };
}
