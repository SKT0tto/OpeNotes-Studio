/**
 * A dialogue beat that swallowed narration: the model packed 「台词＋叙述＋台词」 into ONE dialogue beat, e.g. `抱歉，我来晚了。”爽世抱着贝斯走进来，“老师留我说了几句。`
 * (the outer quotes are already off). A closing quote with no opening quote before it, followed later by an opening quote, is the sign.
 * Nothing is lost in the text itself, but the narration would be spoken by the character and shown in the name plate's box.
 */
export type MergedPiece = { kind: 'dialogue' | 'narration'; text: string };

const PAIRS: ReadonlyArray<readonly [string, string]> = [['“', '”'], ['「', '」'], ['『', '』']];
const OPENERS = new Set(PAIRS.map((p) => p[0]));
const CLOSERS = new Set(PAIRS.map((p) => p[1]));

const CLOSER_OF = new Map(PAIRS);
const OPENER_OF = new Map(PAIRS.map((p) => [p[1], p[0]] as const));

/**
 * The same cleanup the validator applies to a spoken line: no surrounding quotation marks. A bracket is taken off only when its partner
 * is not inside the text (`『春日影』……还有『碧天伴走』` keeps its first 『: it closes right there).
 */
export const stripQuotes = (text: string): string => {
  let t = text.trim().replace(/^"+/, '').replace(/"+$/, '');
  for (;;) {
    const first = t[0] ?? '';
    const last = t[t.length - 1] ?? '';
    if (CLOSER_OF.get(first) === last && closesAtEnd(t)) t = t.slice(1, -1).trim(); // a whole-text pair
    else if (CLOSER_OF.has(first) && !t.slice(1).includes(CLOSER_OF.get(first)!)) t = t.slice(1); // an opener nobody closes
    else if (OPENER_OF.has(last) && !t.slice(0, -1).includes(OPENER_OF.get(last)!)) t = t.slice(0, -1); // a closer nobody opened
    else break;
  }
  return t.trim();
};

/** The quote opened by the first character is closed by the last one (and not before). */
function closesAtEnd(t: string): boolean {
  let depth = 0;
  const chars = [...t];
  for (let i = 0; i < chars.length; i++) {
    if (OPENERS.has(chars[i]!)) depth++;
    else if (CLOSERS.has(chars[i]!)) {
      depth--;
      if (depth === 0) return i === chars.length - 1;
    }
  }
  return false;
}

/**
 * A speech tag only: 「立希说，」「素世笑着说，」「灯问。」「爱音小声问，」「立希说道。」 A speaker part (name, pronoun, short adverbial phrase), then a speech verb
 * (说/问/答/喊/叫/嚷/吼, or a compound 说道/问道/笑道/低声道…), at most one punctuation mark after, at most 12 characters. A bare 道 is not enough:
 * 小道/知道/味道/街道/难道 and 叫做/尖叫 are ordinary words. When in doubt it is NOT a tag (a stray tag is better than lost text).
 */
const SPEECH_TAG = /^[^，。！？!?,.:：；;、“”「」『』《》"]{1,11}(?:[说问答笑喊叫嚷吼骂叹]道|[低轻小大柔冷沉]声道|[说问答喊叫嚷吼])[，。:：,]?$/;
const NOT_SPEECH = /小道|知道|味道|道路|街道|难道|叫做|尖叫|哀叫|嘶叫|鸣叫|啼叫|赤道|轨道|管道|门道|通道|步道|走道|报道|道理|道歉|道谢|学问|疑问|拷问|小说|据说|传说|听说|再说|多说|少说|不再|没有|不必|无法/;
const NEGATED = /^[不别没无未莫勿]/;
export const isSpeechTag = (t: string): boolean => {
  const s = t.trim();
  return [...s].length <= 12 && SPEECH_TAG.test(s) && !NOT_SPEECH.test(s) && !NEGATED.test(s);
};

/** A tag about somebody else (「我说」「你说」 are quotes of one's own words, not a tag). */
const isThirdPartyTag = (t: string): boolean => isSpeechTag(t) && !/^[我你咱]/.test(t.trim());

/**
 * One speech plus one tag: 「“我们再来一遍。”立希说。」 (tag after), 「立希说：“我们再来一遍。”」 (tag before), also with the outer quotes off
 * (`我们再来一遍。”立希说。`) and with “” / "" / 「」 / 『』. Returns the bare speech and the tag, or null when the text is not clearly that shape.
 * Speeches with a tag between them are handled by splitMerged instead.
 */
export function stripSingleSpeechTag(raw: string): { text: string; tag: string } | null {
  let t = raw.trim();
  const ascii = t.match(/"/g)?.length ?? 0;
  if (ascii === 2) {
    let n = 0;
    t = t.replace(/"/g, () => (n++ === 0 ? '“' : '”'));
  } else if (ascii > 0) return null;
  const chars = [...stripQuotes(t)];
  const firstQ = chars.findIndex((c) => OPENERS.has(c) || CLOSERS.has(c));
  if (firstQ < 0) return null;
  let speech: string;
  let tag: string;
  if (OPENERS.has(chars[firstQ]!) && firstQ > 0) {
    // tag before the speech
    const rest = chars.slice(firstQ).join('');
    if (!closesAtEnd(rest)) return null;
    tag = chars.slice(0, firstQ).join('');
    speech = [...rest].slice(1, -1).join('');
  } else {
    // speech first (its opener is the first character, or it is a stray closer), tag after
    let end = -1;
    if (CLOSERS.has(chars[firstQ]!)) end = firstQ;
    else {
      let depth = 0;
      for (let i = 0; i < chars.length; i++) {
        if (OPENERS.has(chars[i]!)) depth++;
        else if (CLOSERS.has(chars[i]!) && --depth === 0) { end = i; break; }
      }
    }
    if (end < 0) return null;
    tag = chars.slice(end + 1).join('');
    speech = chars.slice(OPENERS.has(chars[firstQ]!) ? 1 : 0, end).join('');
  }
  const out = stripQuotes(speech);
  if (out.length === 0 || !isThirdPartyTag(tag)) return null;
  return { text: out, tag: tag.trim() };
}

/** `index` ranges of `text` that sit inside any quote (depth > 0 at the character). */
function quotedMask(text: string): boolean[] {
  const mask: boolean[] = [];
  let depth = 0;
  for (const ch of text) {
    if (OPENERS.has(ch)) depth++;
    const inside = depth > 0;
    if (CLOSERS.has(ch) && depth > 0) depth--;
    for (let k = 0; k < ch.length; k++) mask.push(inside);
  }
  return mask;
}

/** Whether `fragment` occurs in `source` entirely outside every quote. */
function occursOutsideQuotes(source: string, fragment: string): boolean {
  const mask = quotedMask(source);
  for (let at = source.indexOf(fragment); at >= 0; at = source.indexOf(fragment, at + 1)) {
    let clear = true;
    for (let k = at; k < at + fragment.length; k++) if (mask[k]) { clear = false; break; }
    if (clear) return true;
  }
  return false;
}

export interface MergedSplit {
  pieces: MergedPiece[];
  /** speech tags (「立希说，」) that were left out */
  droppedTags: string[];
}

/**
 * The dialogue / narration / dialogue pieces of a merged dialogue text, or null when the text is fine.
 * - Quotes that are opened first and then closed inside the text (a quoted phrase in a spoken line) are not a sign.
 * - Two shapes count: a stray closing quote with no opener before it (`…。”叙述“…`, outer quotes already off), and a text that starts with a
 *   complete quote (`“A，”立希说，“B。”`). The second looks like a spoken line that starts with a quoted word (`『春日影』……还有『碧天伴走』`), so it
 *   is only split when `source` (the story paragraph) shows each narration fragment outside every quote; without a source it is left alone.
 * - A fragment that is only a speech tag (立希说，) is dropped; a narration that ends in ，/、 ends in 。.
 */
export function splitMerged(rawText: string, source?: string): MergedSplit | null {
  const text = stripQuotes(rawText);
  const startsQuoted = OPENERS.has(text[0] ?? '');
  const pieces: MergedPiece[] = [];
  let mode: 'dialogue' | 'narration' = 'dialogue';
  let quoted = startsQuoted; // the current speech was opened by a quote inside the text (its own closing quote ends it)
  let depth = 0;
  let cur = '';
  let found = false;
  let stray = false;
  let first = true;
  for (const ch of text) {
    const atStart = first;
    first = false;
    if (mode === 'narration') {
      if (OPENERS.has(ch)) {
        // an opening quote after the narration: speech again
        pieces.push({ kind: 'narration', text: cur });
        cur = '';
        mode = 'dialogue';
        quoted = true;
        depth = 1;
        found = true;
      } else cur += ch;
      continue;
    }
    if (OPENERS.has(ch)) {
      depth++;
      if (atStart && startsQuoted) continue; // the opening quote of a leading speech is not part of it
    } else if (CLOSERS.has(ch)) {
      // a stray closing quote (nothing open) ends the first speech; the closing quote of a speech opened inside the text ends that one
      const ends = depth === 0 || (quoted && depth === 1);
      if (depth === 0) stray = true;
      if (depth > 0) depth--;
      if (ends) {
        pieces.push({ kind: 'dialogue', text: cur });
        cur = '';
        mode = 'narration';
        quoted = false;
        continue;
      }
    }
    cur += ch;
  }
  if (!found) return null;
  pieces.push({ kind: mode, text: cur });
  const all = pieces.map((p) => ({ kind: p.kind, text: p.kind === 'dialogue' ? stripQuotes(p.text) : p.text.trim() })).filter((p) => p.text.length > 0);
  if (all.length < 3 || !all.some((p) => p.kind === 'narration')) return null;
  const narrations = all.filter((p) => p.kind === 'narration').map((p) => p.text);
  // a narration that starts with ，/、/和/与/或 or has at most 2 meaningful characters is a piece of a sentence, not a beat of its own: leave the beat whole
  const piece = narrations.filter((n) => !isSpeechTag(n));
  if (piece.some((n) => /^[，、和与或]/.test(n) || n.replace(/[\s\p{P}]/gu, '').length <= 2)) return null;
  if (source !== undefined) {
    if (!narrations.every((n) => occursOutsideQuotes(source, n.replace(/[，、。,]+$/, '')))) return null;
  } else if (!stray) return null;
  const droppedTags: string[] = [];
  const out: MergedPiece[] = [];
  for (const p of all) {
    if (p.kind === 'narration' && isSpeechTag(p.text)) {
      droppedTags.push(p.text);
      continue;
    }
    out.push(p.kind === 'narration' ? { kind: 'narration', text: p.text.replace(/[，、,]+$/, '。') } : p);
  }
  return out.length >= 2 ? { pieces: out, droppedTags } : null;
}

export const splitMergedDialogue = (text: string, source?: string): MergedPiece[] | null => splitMerged(text, source)?.pieces ?? null;
