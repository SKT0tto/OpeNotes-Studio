/** Splits a story into numbered paragraphs (the unit the AI refers to), keeping the character offsets in the source text. */
export interface Paragraph {
  index: number;
  start: number;
  end: number;
  text: string;
}

const MAX_LEN = 260;

/** Non-empty lines; a very long line is cut after sentence-ending punctuation outside quotes. */
export function splitParagraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  let pos = 0;
  const push = (start: number, raw: string) => {
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) return;
    out.push({ index: out.length, start: start + lead, end: start + lead + t.length, text: t });
  };
  for (const line of text.split('\n')) {
    const lineStart = pos;
    pos += line.length + 1;
    if (line.trim().length <= MAX_LEN) {
      push(lineStart, line.replace(/\r$/, ''));
      continue;
    }
    let from = 0;
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if ('「『“"'.includes(c)) depth++;
      else if ('」』”'.includes(c)) depth = Math.max(0, depth - 1);
      if (depth === 0 && '。！？!?…'.includes(c) && i + 1 - from >= 80) {
        push(lineStart + from, line.slice(from, i + 1));
        from = i + 1;
      }
    }
    push(lineStart + from, line.slice(from));
  }
  return out;
}

const HEADING_RE = /^\s*(#{1,3}\s+.+|第[一二三四五六七八九十百零〇\d]+[章节回幕话].{0,30}|Chapter\s+\d+.*|序章.*|终章.*|尾声.*|楔子.*)$/i;

export interface Chapter {
  title: string;
  /** First paragraph index of the chapter. */
  startParagraph: number;
}
export const isHeading = (text: string) => HEADING_RE.test(text.trim()) && text.trim().length <= 40;

/** Chapter headings of a numbered paragraph list (`第X章`, markdown `#`, `Chapter N`). */
export function detectChapters(paras: readonly Paragraph[]): Chapter[] {
  const heads = paras.filter((p) => isHeading(p.text));
  // a book title (`# 书名`) in the first paragraph, followed by `##` chapter headings, is not a chapter itself
  const skipTitle = heads[0]?.index === paras[0]?.index && /^\s*#\s+/.test(heads[0]?.text ?? '') && heads.slice(1).some((h) => /^\s*##/.test(h.text));
  return (skipTitle ? heads.slice(1) : heads).map((p) => ({ title: p.text.replace(/^#+\s*/, '').trim(), startParagraph: p.index }));
}

/** Chunks of paragraphs of about `maxChars` characters (at paragraph boundaries) for long novels. */
export function chunkParagraphs(paras: Paragraph[], maxChars = 20000): Paragraph[][] {
  const chunks: Paragraph[][] = [];
  let cur: Paragraph[] = [];
  let n = 0;
  for (const p of paras) {
    if (cur.length > 0 && n + p.text.length > maxChars) {
      // prefer to cut right before the last chapter heading of the chunk (when it is not too early), so chapters stay whole
      const h = cur.map((x, i) => (isHeading(x.text) ? i : -1)).filter((i) => i > 0).at(-1);
      const cut = h !== undefined && cur.slice(0, h).reduce((a, x) => a + x.text.length, 0) > maxChars * 0.4 ? h : cur.length;
      chunks.push(cur.slice(0, cut));
      cur = cur.slice(cut);
      n = cur.reduce((a, x) => a + x.text.length, 0);
    }
    cur.push(p);
    n += p.text.length;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

const strip = (s: string) => s.replace(/[\s\u3000"“”「」『』'‘’，。！？、…—·,.!?~～：:；;（）()《》-]/g, '');

/** Share of `text`'s character bigrams that occur in `source` (1 = fully traceable). Punctuation and spaces are ignored. */
export function traceability(text: string, source: string): number {
  const a = [...strip(text)];
  const b = strip(source);
  if (a.length === 0) return 1;
  if (a.length === 1) return b.includes(a[0]!) ? 1 : 0;
  let hit = 0;
  for (let i = 0; i + 1 < a.length; i++) if (b.includes(a[i]! + a[i + 1]!)) hit++;
  return hit / (a.length - 1);
}

/** Offset of (a normalised) `text` inside the paragraph, or 0. */
export function offsetInParagraph(text: string, para: string): number {
  const probe = text.trim().slice(0, 8);
  const i = probe ? para.indexOf(probe) : -1;
  return i < 0 ? 0 : i;
}
