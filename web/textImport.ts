/** Reads a text file the way a novel usually arrives: UTF-8 (with or without BOM), else GBK / GB18030. */
export async function readTextFile(file: File): Promise<{ text: string; encoding: string }> {
  const buf = await file.arrayBuffer();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'GBK' };
  }
}

/** Markdown / plain text -> the paragraph text the director expects (CRLF -> LF, runs of blank lines collapsed). */
export const normalizeNovel = (t: string): string => t.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
