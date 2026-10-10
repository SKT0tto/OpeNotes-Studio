import { describe, expect, it } from 'vitest';
import { History } from '../../web/store/history';

type S = {
  title: string;
  n: number;
  list: Array<{ id: string; v: number }>;
};
const init = (): S => ({ title: 'a', n: 0, list: [{ id: 'x', v: 1 }] });

describe('History', () => {
  it('undoes and redoes edits, restoring structure exactly', () => {
    const h = new History<S>();
    const s0 = init();
    const s1 = h.apply(s0, (d) => void (d.title = 'b'), 'title');
    const s2 = h.apply(s1, (d) => void d.list.push({ id: 'y', v: 2 }), 'add');
    expect(h.undoLabel).toBe('add');
    const u1 = h.undo(s2);
    expect(u1).toEqual(s1);
    const u2 = h.undo(u1);
    expect(u2).toEqual(s0);
    expect(h.canUndo).toBe(false);
    expect(h.redoLabel).toBe('title');
    const r1 = h.redo(u2);
    expect(r1).toEqual(s1);
    expect(h.redo(r1)).toEqual(s2);
    expect(h.canRedo).toBe(false);
  });

  it('a new edit clears the redo stack; no-op edits are not recorded', () => {
    const h = new History<S>();
    const a = h.apply(init(), (d) => void (d.n = 1), 'n');
    const b = h.undo(a);
    expect(h.canRedo).toBe(true);
    expect(h.apply(b, (d) => void (d.n = b.n), 'same')).toBe(b);
    expect(h.canRedo).toBe(true);
    h.apply(b, (d) => void (d.title = 'z'), 'other');
    expect(h.canRedo).toBe(false);
  });

  it('merges consecutive edits with the same key into one step until sealed', () => {
    const h = new History<S>();
    let s = init();
    for (const n of [1, 2, 3, 4]) s = h.apply(s, (d) => void (d.n = n), 'drag', { coalesce: 'n' });
    expect(s.n).toBe(4);
    expect(h.undo(s).n).toBe(0); // one undo for the whole drag
    expect(h.canUndo).toBe(false);

    s = init();
    s = h.apply(s, (d) => void (d.n = 1), 'drag', { coalesce: 'n' });
    h.seal();
    s = h.apply(s, (d) => void (d.n = 2), 'drag', { coalesce: 'n' });
    s = h.undo(s);
    expect(s.n).toBe(1);
    expect(h.redo(s).n).toBe(2);
  });

  it('different keys or plain edits end a group; the merged step still undoes in reverse order', () => {
    const h = new History<S>();
    let s = init();
    s = h.apply(s, (d) => void (d.n = 1), 'a', { coalesce: 'n' });
    s = h.apply(s, (d) => void (d.n = 2), 'a', { coalesce: 'n' });
    s = h.apply(s, (d) => void (d.title = 't'), 'title', { coalesce: 't' });
    s = h.apply(s, (d) => void (d.n = 9), 'plain');
    expect(h.undo(s).n).toBe(2);
    s = h.undo(s);
    s = h.undo(s);
    expect(s.title).toBe('a');
    expect(h.undo(s)).toEqual(init());
  });

  it('keeps at most `limit` steps', () => {
    const h = new History<S>(3);
    let s = init();
    for (let i = 1; i <= 5; i++) s = h.apply(s, (d) => void (d.n = i), `n${i}`);
    for (let i = 0; i < 10; i++) s = h.undo(s);
    expect(s.n).toBe(2);
  });
});
