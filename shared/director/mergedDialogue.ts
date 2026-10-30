/**
 * A dialogue beat that swallowed narration: the model packed 「台词＋叙述＋台词」 into ONE dialogue beat, e.g. `抱歉，我来晚了。”爽世抱着贝斯走进来，“老师留我说了几句。`
 * (the outer quotes are already off). A closing quote with no opening quote before it, followed later by an opening quote, is the sign.
 * Nothing is lost in the text itself, but the narration would be spoken by the character and shown in the name plate's box.
 */
export type MergedPiece = { kind: 'dialogue' | 'narration'; text: string };

const PAIRS: ReadonlyArray<readonly [string, string]> = [['“', '”'], ['「', '」'], ['『', '』']];
const OPENERS = new Set(PAIRS.map((p) => p[0]));
const CLOSERS = new Set(PAIRS.map((p) => p[1]));

/** The same cleanup the validator applies to a spoken line: no surrounding quotation marks. */
export const stripQuotes = (text: string): string => text.trim().replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '');

/**
 * The dialogue / narration / dialogue pieces of a merged dialogue text (quotes already stripped), or null when the text is fine.
 * Quotes that are opened first and then closed inside the text (a quoted phrase in a spoken line) are not a sign.
 */
export function splitMergedDialogue(text: string): MergedPiece[] | null {
  const pieces: MergedPiece[] = [];
  let mode: 'dialogue' | 'narration' = 'dialogue';
  let quoted = false; // the current speech was opened by a quote inside the text (its own closing quote ends it)
  let depth = 0;
  let cur = '';
  let found = false;
  for (const ch of text) {
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
    if (OPENERS.has(ch)) depth++;
    else if (CLOSERS.has(ch)) {
      // a stray closing quote (nothing open) ends the first speech; the closing quote of a speech opened inside the text ends that one
      const ends = depth === 0 || (quoted && depth === 1);
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
  const out = pieces.map((p) => ({ kind: p.kind, text: p.kind === 'dialogue' ? stripQuotes(p.text) : p.text.trim() })).filter((p) => p.text.length > 0);
  return out.length >= 3 && out.some((p) => p.kind === 'narration') ? out : null;
}
