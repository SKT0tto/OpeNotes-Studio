import { describe, expect, it } from 'vitest';
import { normalizeNovel, readTextFile } from '../../web/textImport';

describe('novel import', () => {
  it('reads UTF-8 (with BOM) and GBK files', async () => {
    const utf = new File([new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('灯')])], 'a.txt');
    expect(await readTextFile(utf)).toEqual({ text: '灯', encoding: 'UTF-8' });
    const gbk = new File([new Uint8Array([0xb5, 0xc6])], 'b.txt'); // 灯 in GBK
    expect(await readTextFile(gbk)).toEqual({ text: '灯', encoding: 'GBK' });
  });
  it('normalises line endings and blank runs', () => {
    expect(normalizeNovel('a\r\n\r\n\r\n\r\nb\r\n')).toBe('a\n\nb');
  });
});
