/** Path text as people paste it: Windows 「复制为路径」 wraps the path in quotes, and a paste often brings spaces or a line break. */

const PAIRS: Array<[string, string]> = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['”', '”'], ['“', '“']];

/** Removes surrounding whitespace and one or more layers of surrounding quotes (ASCII and curly); a path with no quotes is only trimmed. */
export function cleanPath(input: string | undefined | null): string {
  let s = (input ?? '').trim();
  for (let guard = 0; guard < 4 && s.length >= 2; guard++) {
    const hit = PAIRS.find(([a, b]) => s.startsWith(a) && s.endsWith(b));
    if (!hit) break;
    s = s.slice(hit[0].length, s.length - hit[1].length).trim();
  }
  return s;
}

/** One path per line, each cleaned, empty lines dropped. */
export const cleanPathList = (text: string): string[] => text.split(/\r?\n/).map(cleanPath).filter(Boolean);
