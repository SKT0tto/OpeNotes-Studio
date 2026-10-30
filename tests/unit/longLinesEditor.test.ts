/**
 * S7: the editor's long-line logic. The indicator and the badges read the one measurement; 「自动拆分」 turns the server's plans into
 * `beat_split_pieces` ops with distinct fresh ids and replays the whole batch as ONE undo step; 「拆开」 on an assistant card sends words the
 * server reads as a split request. All lines of text are original.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { asksForLineSplit } from '../../shared/agent/asks';
import { beatLineInfo } from '../../shared/agent/lines';
import { applyOp } from '../../shared/agent/apply';
import { checkOp } from '../../shared/agent/check';
import { revertOps } from '../../shared/agent/revert';
import { clone } from '../../shared/project/mutate';
import { splitForDialog } from '../../shared/director/splitLines';
import type { Project, Scene } from '../../shared/schema/project';
import { resolveStyle } from '../../shared/style/ournotes';
import { cachedLineInfo, expandHint, isContinuation, lineIndicator, overLongRows, replayItems, scenesWithLong, splitOps, type SplitPlan } from '../../web/editor/longLines';
import { splitRequestText } from '../../web/editor/longLinesAsk';
import { useProject } from '../../web/store/projectStore';
import { directedProject } from './helpers/directorFlow';

const LONG_A = '我跟你说，这次的合宿我已经全部安排好了！民宿、电车票、练习的时间表，连每天晚上吃什么都写好了！……不过，钱的事我还没跟大家商量。';
const LONG_B = '昨天回家的路上，我一直在想今天要怎么跟大家开口，结果走到车站才发现自己把最重要的笔记本落在了排练室里，只好折回去，等我拿到的时候天都已经黑了。';

/** The directed example with two over-long lines in scene 3 (the 2nd and the 3rd beat; the first of them is not the last). */
function withLong(): Project {
  const p = clone(directedProject());
  const s = p.scenes[2]!;
  for (const [i, t] of [[1, LONG_A], [2, LONG_B]] as const) {
    const b = s.beats[i]!;
    b.kind = 'dialogue';
    b.speakerId ??= Object.keys(s.wardrobe)[0];
    b.text = t;
    b.variant = 'normal';
    delete b.overflow;
    delete b.splitFrom;
  }
  return p;
}
const plansOf = (p: Project, scene: Scene): SplitPlan[] =>
  overLongRows(p, scene.id).map((r) => {
    const b = scene.beats.find((x) => x.id === r.beatId)!;
    const style = resolveStyle(p.style, scene.style, b.style).values.dialog;
    return { beatId: b.id, by: 'rule' as const, pieces: splitForDialog(b.text, style, b.variant).pieces.map((text) => ({ text, emotion: 'neutral' })) };
  });

describe('indicator, badges and the expand hint', () => {
  it('lists exactly the lines that do not fit (not the expanded ones), with positions', () => {
    const p = withLong();
    const rows = overLongRows(p);
    expect(rows.map((r) => [r.sceneNo, r.beatNo])).toEqual([[3, 2], [3, 3]]);
    expect(rows.every((r) => r.lines > r.max)).toBe(true);
    expect(overLongRows(p, p.scenes[0]!.id)).toEqual([]);
    expect(scenesWithLong(rows)).toEqual([p.scenes[2]!.id]);
    p.scenes[2]!.beats[1]!.overflow = 'expand';
    expect(overLongRows(p).map((r) => r.beatNo)).toEqual([3]);
  });

  it('says 「n/max 行」, warns only when over, and keeps the expanded line in normal style', () => {
    const p = withLong();
    const s = p.scenes[2]!;
    const ok = lineIndicator(beatLineInfo(p, s, s.beats.find((b) => b.kind === 'dialogue' && !overLongRows(p).some((r) => r.beatId === b.id))!))!;
    expect(ok.warn).toBe(false);
    expect(ok.text).toMatch(/^\d\/2 行$/);
    const over = lineIndicator(beatLineInfo(p, s, s.beats[1]!))!;
    expect(over.warn).toBe(true);
    expect(over.text).toMatch(/^[3-9]\/2 行$/);
    s.beats[1]!.overflow = 'expand';
    const ex = lineIndicator(beatLineInfo(p, s, s.beats[1]!))!;
    expect(ex).toMatchObject({ warn: false, expanded: true });
    expect(lineIndicator(null)).toBeNull();
  });

  it('describes how the box takes n lines', () => {
    expect(expandHint(2, 2)).toContain('不需要展开');
    expect(expandHint(3, 2)).toBe('3 行：对话框会向下长');
    expect(expandHint(4, 2)).toBe('4 行：对话框会向上长');
    expect(expandHint(6, 2)).toBe('6 行：对话框会向上长');
    expect(expandHint(9, 2)).toContain('滚动');
  });

  it('caches the measurement per beat object and re-measures when the style layer changes', () => {
    const p = withLong();
    const s = p.scenes[2]!;
    const b = s.beats[1]!;
    const a1 = cachedLineInfo(p, s, b);
    expect(cachedLineInfo(p, s, b)).toBe(a1);
    expect(a1?.over).toBe(true);
    const p2 = { ...p, style: { ...p.style, overrides: { ...p.style.overrides, 'dialog.maxLines': 9 } } } as Project;
    expect(cachedLineInfo(p2, s, b)?.over).toBe(false);
    expect(isContinuation({})).toBe(false);
    expect(isContinuation({ splitFrom: 'x' })).toBe(true);
  });
});

describe('splitOps: one op per split, fresh distinct ids', () => {
  it('takes pieces-1 new ids per split and never repeats an id inside the batch', () => {
    const p = withLong();
    const s = p.scenes[2]!;
    const plans = plansOf(p, s);
    expect(plans).toHaveLength(2);
    const ops = splitOps(p, s.id, plans);
    expect(ops).toHaveLength(2);
    const ids = ops.flatMap((o) => (o.op === 'beat_split_pieces' ? o.newIds : []));
    expect(new Set(ids).size).toBe(ids.length);
    ops.forEach((o, i) => { if (o.op === 'beat_split_pieces') expect(o.newIds).toHaveLength(plans[i]!.pieces.length - 1); });
    const used = new Set(p.scenes.flatMap((x) => x.beats.map((b) => b.id)));
    expect(ids.every((id) => !used.has(id))).toBe(true);
  });

  it('drops plans whose beat is gone or that have one piece', () => {
    const p = withLong();
    const s = p.scenes[2]!;
    const ops = splitOps(p, s.id, [{ beatId: 'nope', by: 'rule', pieces: [{ text: 'a' }, { text: 'b' }] }, { beatId: s.beats[1]!.id, by: 'rule', pieces: [{ text: LONG_A }] }]);
    expect(ops).toEqual([]);
    expect(splitOps(p, 'no-scene', [])).toEqual([]);
  });
});

describe('applying a batch is one undo step', () => {
  beforeEach(() => useProject.getState().open(withLong(), 'etag'));
  const st = () => useProject.getState();

  it('cuts every long line, marks the continuations, and Ctrl+Z restores the project in a single step', () => {
    const before = clone(st().project!);
    const s = before.scenes[2]!;
    const ops = splitOps(before, s.id, plansOf(before, s));
    const { plan, applied } = st().applyAgentOps(replayItems(ops), '自动拆分长句', 'g_test');
    expect(applied).toBe(2);
    expect(plan.items.filter((i) => i.status !== 'ok')).toEqual([]);
    const after = st().project!;
    expect(overLongRows(after)).toEqual([]);
    const sc = after.scenes[2]!;
    expect(sc.beats.length).toBe(s.beats.length + ops.reduce((n, o) => n + (o.op === 'beat_split_pieces' ? o.newIds.length : 0), 0));
    const conts = sc.beats.filter((b) => b.splitFrom !== undefined);
    expect(conts.length).toBe(sc.beats.length - s.beats.length);
    // each continuation follows its head, with the same speaker
    for (const c of conts) {
      const head = sc.beats.find((b) => b.id === c.splitFrom)!;
      expect(c.speakerId).toBe(head.speakerId);
      expect(sc.beats.indexOf(c)).toBeGreaterThan(sc.beats.indexOf(head));
    }
    // the text is kept (pieces joined = the original line)
    const joined = (id: string) => [sc.beats.find((b) => b.id === id)!, ...sc.beats.filter((b) => b.splitFrom === id)].map((b) => b.text).join('');
    expect(joined(s.beats[1]!.id).replace(/\s/g, '')).toBe(LONG_A);
    st().undo();
    expect(st().project).toEqual(before);
    expect(st().canUndo).toBe(false); // exactly one step was made (the open project had none)
    st().redo();
    expect(overLongRows(st().project!)).toEqual([]);
  });

  it('a locked line is reported and left alone; the rest still splits', () => {
    const p = clone(st().project!);
    const s = p.scenes[2]!;
    s.beats[1]!.meta.locked = true;
    st().open(p, 'etag');
    const ops = splitOps(p, s.id, plansOf(p, s));
    const { plan, applied } = st().applyAgentOps(replayItems(ops), '自动拆分长句', 'g_test');
    expect(applied).toBe(1);
    expect(plan.items.some((i) => i.status === 'needs_unlock')).toBe(true);
    expect(overLongRows(st().project!).map((r) => r.beatNo)).toEqual([2]);
  });

  it('plans that went stale (the line was edited meanwhile) are skipped, not applied wrongly', () => {
    const p = clone(st().project!);
    const s = p.scenes[2]!;
    const ops = splitOps(p, s.id, plansOf(p, s));
    const edited = clone(p);
    edited.scenes[2]!.beats[1]!.text = '好。';
    st().open(edited, 'etag');
    const { plan, applied } = st().applyAgentOps(replayItems(ops), '自动拆分长句', 'g_test');
    expect(applied).toBe(1);
    expect(plan.items.find((i) => i.status === 'stale')).toBeTruthy();
  });
});

describe('the known gap: a deleted continuation comes back with its splitFrom', () => {
  it('beat_insert carries splitFrom (revert_turn restores a deleted continuation as a continuation)', () => {
    const p = withLong();
    const s = p.scenes[2]!;
    const ops = splitOps(p, s.id, plansOf(p, s));
    const after = clone(p);
    for (const o of ops) applyOp(after, o, { genId: 'g', now: 1 });
    const sa = after.scenes[2]!;
    const cont = sa.beats.find((b) => b.splitFrom)!;
    // delete the continuation, then ask for the revert of that deletion
    const gone = clone(after);
    gone.scenes[2]!.beats = gone.scenes[2]!.beats.filter((b) => b.id !== cont.id);
    const back = revertOps(after, gone);
    const ins = back.find((o) => o.op === 'beat_insert');
    expect(ins && ins.op === 'beat_insert' ? ins.beat.splitFrom : null).toBe(cont.splitFrom);
    const w = clone(gone);
    for (const o of back) {
      const r = checkOp(w, o, {});
      expect(r.status === 'invalid' ? r.problems : []).toEqual([]);
      applyOp(w, r.op, { genId: 'g', now: 2 });
    }
    expect(w.scenes[2]!.beats.find((b) => b.id === cont.id)?.splitFrom).toBe(cont.splitFrom);
  });
});

describe('「拆开」 on an assistant card sends a request the server reads as a split', () => {
  it('names scenes and lines, and trips asksForLineSplit', () => {
    const p = withLong();
    const t = splitRequestText(p, [{ sceneId: p.scenes[2]!.id, beatNo: 3 }, { sceneId: p.scenes[2]!.id, beatNo: 2 }, { sceneId: p.scenes[0]!.id, beatNo: 1 }]);
    expect(t).toContain('第1场第1句');
    expect(t).toContain('第3场第2、3句');
    expect(asksForLineSplit(t)).toBe(true);
  });
});
