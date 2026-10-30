import { describe, expect, it } from 'vitest';
import { OURNOTES_STYLE } from '@shared/style/ournotes';
import { dialogView, dialogWidthEm, displayText, expandPlan, fitsDialog, glyphWidth, layoutDialogLines, revealRows } from '@shared/style/dialogLayout';

const D = OURNOTES_STYLE.dialog;
const W = dialogWidthEm(D);
const han = (n: number) => '字'.repeat(n);
const rowsOf = (t: string) => layoutDialogLines(t, W).map((l) => l.text);

describe('dialogLayout: measurement', () => {
  it('the default capacity is 31.47em', () => {
    expect(W).toBeCloseTo(31.47, 2);
  });
  it('31 characters are one line, 32 are two', () => {
    expect(fitsDialog(han(31), D).lines).toBe(1);
    expect(fitsDialog(han(32), D).lines).toBe(2);
  });
  it('62 characters fit two lines, 63 need three (the over flag follows maxLines)', () => {
    expect(fitsDialog(han(62), D)).toMatchObject({ lines: 2, over: false, max: 2 });
    expect(fitsDialog(han(63), D)).toMatchObject({ lines: 3, over: true });
    expect(fitsDialog(han(63), { ...D, maxLines: 3 }).over).toBe(false);
  });
  it('a closing mark never starts a line: the previous character comes down with it', () => {
    const r = rowsOf(han(31) + '。');
    expect(r).toHaveLength(2);
    expect(r[0]).toBe(han(30));
    expect(r[1]).toBe('字。');
  });
  it('a run of closers pulls down as many characters as needed', () => {
    const r = rowsOf(han(30) + '字！？」');
    expect(r.every((l) => !/^[！？」]/.test(l))).toBe(true);
    expect(r.join('')).toBe(han(30) + '字！？」');
  });
  it('an opening bracket never ends a line', () => {
    const r = rowsOf(han(30) + '字（あ');
    expect(r[0]!.endsWith('（')).toBe(false);
    expect(r[1]!.startsWith('（')).toBe(true);
  });
  it('…… and —— are never torn apart', () => {
    for (const mark of ['……', '——']) {
      for (const lead of [29, 30, 31]) {
        const t = han(lead) + mark + '字';
        const r = rowsOf(t);
        expect(r.join('')).toBe(t);
        expect(r.every((l) => !/^[…—]/.test(l) || /^(……|——)/.test(l))).toBe(true);
        expect(r.every((l) => !/[…—]$/.test(l) || /(……|——)$/.test(l))).toBe(true);
      }
    }
  });
  it('small kana and the long-sound mark do not start a line', () => {
    const r = rowsOf(han(30) + 'あーっ');
    expect(r.every((l) => !/^[ーっ]/.test(l))).toBe(true);
  });
  it('an author newline breaks the line and counts as one character when revealing', () => {
    const f = fitsDialog('あ\nい', D);
    expect(f.lines).toBe(2);
    expect(f.rows.map((r) => r.text)).toEqual(['あ', 'い']);
    expect(f.rows[0]!.hard).toBe(true);
    expect(revealRows(f.rows, 1)).toEqual(['あ']);
    expect(revealRows(f.rows, 2)).toEqual(['あ', '']);
    expect(revealRows(f.rows, 3)).toEqual(['あ', 'い']);
  });
  it('empty text is one line', () => {
    expect(fitsDialog('', D).lines).toBe(1);
  });
  it('mixed Latin / CJK: Latin is narrower than 1em, digits and capitals wider than lowercase', () => {
    expect(glyphWidth('a')).toBeLessThan(1);
    expect(glyphWidth('W')).toBeGreaterThan(glyphWidth('a'));
    expect(glyphWidth('字')).toBe(1);
    expect(glyphWidth('？')).toBe(1);
    expect(fitsDialog('a'.repeat(40), D).lines).toBe(1);
    expect(fitsDialog('a'.repeat(60), D).lines).toBe(2);
    expect(fitsDialog('今天的LIVE真的太棒了！' + 'setlist'.repeat(3), D).lines).toBe(1);
  });
  it('Latin breaks inside a word (break-all) rather than overflowing', () => {
    const r = rowsOf('x'.repeat(100));
    expect(r.length).toBeGreaterThan(1);
    expect(r.join('')).toBe('x'.repeat(100));
  });
  it('a space at the end of a full line hangs', () => {
    const t = 'a'.repeat(54) + ' ' + 'bb';
    expect(rowsOf(t).join('')).toBe(t);
  });
  it('monologue: the brackets count (2em), unless the text already starts with one', () => {
    expect(fitsDialog(han(29), D, 'monologue').lines).toBe(1);
    expect(fitsDialog(han(30), D, 'monologue').lines).toBe(2); // 30 + 2 > 31.47
    expect(fitsDialog(han(31), D, 'normal').lines).toBe(1);
    expect(displayText('あ', 'monologue', D)).toBe('（あ）');
    expect(displayText('（あ）', 'monologue', D)).toBe('（あ）');
    expect(displayText('あ', 'monologue', { monologueBrackets: false })).toBe('あ');
    expect(displayText('あ', 'offscreen', D)).toBe('あ');
  });
  it('resolution independence: the same shares give the same lines', () => {
    expect(fitsDialog(han(62), { ...D, textSize: D.textSize * 2, textWidth: D.textWidth * 2 }).lines).toBe(2);
  });
  it('is deterministic and the rows always concatenate back to the text', () => {
    const t = '今天的LIVE真的太棒了！最后一首的时候整个场子都在跟着唱，我在台上差点哭出来～下次一定要把这首歌也放进setlist里，绝对！' + han(50);
    const a = layoutDialogLines(t, W);
    expect(layoutDialogLines(t, W)).toEqual(a);
    expect(a.map((l) => l.text).join('')).toBe(t);
  });
});

describe('dialogLayout: reveal and expand', () => {
  it('expandPlan: down up to 3, up for 4..6, scroll beyond 6', () => {
    expect(expandPlan(2)).toEqual({ total: 2, visible: 2, shiftUp: 0, scroll: false });
    expect(expandPlan(3)).toMatchObject({ shiftUp: 0, scroll: false });
    expect(expandPlan(4)).toMatchObject({ visible: 4, shiftUp: 1, scroll: false });
    expect(expandPlan(6)).toMatchObject({ visible: 6, shiftUp: 3, scroll: false });
    expect(expandPlan(7)).toMatchObject({ visible: 6, shiftUp: 3, scroll: true });
    expect(expandPlan(12)).toMatchObject({ visible: 6, shiftUp: 3, scroll: true });
  });
  it('not expanded: only the first maxLines lines are rendered', () => {
    const v = dialogView(han(100), 'normal', D, 100, 100, false);
    expect(v.rows).toHaveLength(2);
    expect(v.total).toBe(4);
    expect(v.shiftUp).toBe(0);
  });
  it('typewriter: rows appear as characters are revealed', () => {
    const t = han(70);
    expect(dialogView(t, 'normal', D, 10, 70, false).rows).toEqual([han(10)]);
    expect(dialogView(t, 'normal', D, 40, 70, false).rows).toEqual([han(31), han(9)]);
  });
  it('expanded 3 lines: no shift; 5 lines: shift up 2; 8 lines scroll with the typewriter', () => {
    const e3 = dialogView(han(70), 'normal', D, 70, 70, true);
    expect(e3.rows).toHaveLength(3);
    expect(e3.shiftUp).toBe(0);
    const e5 = dialogView(han(140), 'normal', D, 140, 140, true);
    expect(e5.rows).toHaveLength(5);
    expect(e5.shiftUp).toBe(2);
    const t8 = han(31 * 7 + 5);
    expect(dialogView(t8, 'normal', D, 31 * 3, t8.length, true).rows).toHaveLength(3);
    const done = dialogView(t8, 'normal', D, t8.length, t8.length, true);
    expect(done.total).toBe(8);
    expect(done.rows).toHaveLength(6);
    expect(done.rows[5]).toBe(han(5));
    expect(done.rows[0]).toBe(han(31));
    expect(done.shiftUp).toBe(3);
  });
  it('the size of an expanded box does not depend on how much is typed', () => {
    const t = han(140);
    expect(dialogView(t, 'normal', D, 3, 140, true).shiftUp).toBe(dialogView(t, 'normal', D, 140, 140, true).shiftUp);
  });
  it('monologue reveal: the opening bracket is shown at once, the closing one with the last character', () => {
    expect(dialogView('あい', 'monologue', D, 0, 2, false).rows).toEqual(['（']);
    expect(dialogView('あい', 'monologue', D, 1, 2, false).rows).toEqual(['（あ']);
    expect(dialogView('あい', 'monologue', D, 2, 2, false).rows).toEqual(['（あい）']);
  });
});
