import { beforeEach, describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { addKey, ensureTrack, insertBeat, newBeat, newKeyId, removeBeat, removeScene, setActorInScene } from '../../shared/project/mutate';
import { describeViolations, findLockViolations } from '../../shared/project/locks';
import type { Project } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { addBeatAfter, deleteBeat, deleteScene, editBeat, editScene, toggleActorInScene, writeKey } from '../../web/store/actions';
import { useProject } from '../../web/store/projectStore';
import { useUi } from '../../web/store/uiStore';
import { MINI_CTX, miniProject } from './helpers/synthetic';

const st = () => useProject.getState();
const proj = () => st().project as Project;
const toast = () => useUi.getState().toast;

const viol = (p: Project, f: (d: Project) => void) => findLockViolations(p, produce(p, f));

describe('lock gate (shared/project/locks.ts)', () => {
  it('a locked wardrobe entry cannot change or vanish; unlocking is a pure meta change; unlocked units are free', () => {
    const p = produce(miniProject(), (d) => void (d.scenes[0]!.wardrobe.a!.meta.locked = true));
    expect(viol(p, (d) => void (d.scenes[0]!.wardrobe.a!.modelId = 'mA2'))).toHaveLength(1);
    expect(viol(p, (d) => void (d.scenes[0]!.wardrobe.b!.modelId = 'mA2'))).toHaveLength(0);
    expect(viol(p, (d) => void delete d.scenes[0]!.wardrobe.a)).toMatchObject([{ reason: 'removed' }]);
    expect(viol(p, (d) => void (d.scenes[0]!.wardrobe.a!.meta.locked = false))).toHaveLength(0);
    expect(viol(p, (d) => { d.scenes[0]!.wardrobe.a!.meta.locked = false; d.scenes[0]!.wardrobe.a!.modelId = 'mA2'; })).toHaveLength(1);
  });

  it('a locked line protects its own fields, not its shot; reordering is allowed, removing is not', () => {
    const p = produce(miniProject(), (d) => void (d.scenes[0]!.beats[0]!.meta.locked = true));
    expect(viol(p, (d) => void (d.scenes[0]!.beats[0]!.text = 'x'))).toHaveLength(1);
    expect(viol(p, (d) => void (d.scenes[0]!.beats[0]!.coSpeakers = ['b']))).toHaveLength(1);
    expect(viol(p, (d) => void (d.scenes[0]!.beats[0]!.shot.type = 'ecu'))).toHaveLength(0);
    expect(viol(p, (d) => void d.scenes[0]!.beats.reverse())).toHaveLength(0);
    expect(viol(p, (d) => void removeBeat(d.scenes[0]!, 'b1'))).toMatchObject([{ reason: 'removed' }]);
    expect(viol(p, (d) => void removeBeat(d.scenes[0]!, 'b2'))).toHaveLength(0);
    expect(describeViolations(viol(p, (d) => void removeBeat(d.scenes[0]!, 'b1')))).toContain('无法删除');
  });

  it('removing a line takes locked keys anchored on it with it: refused', () => {
    let p = miniProject();
    p = produce(p, (d) => {
      const tr = ensureTrack(d.scenes[0]!, { kind: 'actor', castId: 'a' }, 'expression');
      addKey(d.scenes[0]!, tr, { beatId: 'b2', offset: 0 }, { name: 'exp_smile01' }).meta.locked = true;
    });
    expect(viol(p, (d) => void removeBeat(d.scenes[0]!, 'b2'))).toHaveLength(1);
    expect(viol(p, (d) => void removeBeat(d.scenes[0]!, 'b3'))).toHaveLength(0);
  });

  it('a locked track owns its keys (no add, edit or delete); an unlocked track only protects locked keys', () => {
    let p = miniProject();
    p = produce(p, (d) => {
      const tr = ensureTrack(d.scenes[0]!, { kind: 'actor', castId: 'a' }, 'head');
      addKey(d.scenes[0]!, tr, { beatId: 'b1', offset: 0 }, { mode: 'angle', yaw: 0.1 });
      addKey(d.scenes[0]!, tr, { beatId: 'b2', offset: 0 }, { mode: 'angle', yaw: 0.2 }).meta.locked = true;
    });
    const tr = (d: Project) => d.scenes[0]!.tracks[0]!;
    expect(viol(p, (d) => void (tr(d).keys[0]!.value = { mode: 'angle', yaw: 0.9 }))).toHaveLength(0);
    expect(viol(p, (d) => void (tr(d).keys[1]!.value = { mode: 'angle', yaw: 0.9 }))).toHaveLength(1);
    expect(viol(p, (d) => void tr(d).keys.pop())).toHaveLength(1);
    const locked = produce(p, (d) => void (d.scenes[0]!.tracks[0]!.meta.locked = true));
    expect(viol(locked, (d) => void (tr(d).keys[0]!.value = { mode: 'angle', yaw: 0.9 }))).toHaveLength(1);
    expect(viol(locked, (d) => void addKey(d.scenes[0]!, tr(d) as never, { beatId: 'b3', offset: 0 }, { mode: 'angle', yaw: 0 }))).toHaveLength(1);
    expect(viol(locked, (d) => void (d.scenes[0]!.tracks = []))).toHaveLength(1);
    expect(viol(p, (d) => void setActorInScene(d.scenes[0]!, 'a', false, 'mA'))).toHaveLength(1);
    expect(viol(p, (d) => void setActorInScene(d.scenes[0]!, 'b', false, 'mB'))).toHaveLength(0);
  });

  it('the scene lock covers the title only; the scene cannot be removed while its title is locked', () => {
    const p = produce(miniProject(), (d) => void (d.scenes[0]!.meta.locked = true));
    expect(viol(p, (d) => void (d.scenes[0]!.title = 'new'))).toHaveLength(1);
    expect(viol(p, (d) => void (d.scenes[0]!.background.assetId = 'bg2'))).toHaveLength(0);
    expect(viol(p, (d) => void (d.scenes[0]!.transitionIn.kind = 'dip_black'))).toHaveLength(0);
    expect(viol(p, (d) => void insertBeat(d.scenes[0]!, 'b1', { text: 'n' }))).toHaveLength(0);
    expect(viol(p, (d) => void removeScene(d, 's1'))).toHaveLength(1);
  });
});

describe('lock gate through the editor actions', () => {
  beforeEach(() => {
    st().open(miniProject(), 'etag');
    useUi.getState().set({ toast: null, keySel: [], clip: [] });
  });
  const lock = (f: (d: Project) => void) => st().applyEdit((d) => f(d as Project), 'lock');

  it('inspector-style direct edits are refused by the store, with an unlock button that works', () => {
    lock((d) => void (d.scenes[0]!.wardrobe.a!.meta.locked = true));
    const ok = st().applyEdit((d) => void (d.scenes[0]!.wardrobe.a!.modelId = 'mA2'), '更换服装');
    expect(ok).toBe(false);
    expect(proj().scenes[0]!.wardrobe.a!.modelId).toBe('mA');
    expect(toast()?.text).toContain('已锁定');
    expect(toast()?.action?.label).toBe('解锁');
    toast()!.action!.run();
    expect(proj().scenes[0]!.wardrobe.a!.meta.locked).toBe(false);
    expect(st().applyEdit((d) => void (d.scenes[0]!.wardrobe.a!.modelId = 'mA2'), '更换服装')).toBe(true);
    expect(proj().scenes[0]!.wardrobe.a!.modelId).toBe('mA2');
  });

  it('locked line: text refused from every path, delete refused, selection untouched, unlock always works', () => {
    lock((d) => void (d.scenes[0]!.beats[1]!.meta.locked = true));
    expect(editBeat('s1', 'b2', 'x', (b) => void (b.text = 'z'))).toBe('locked');
    expect(st().applyEdit((d) => void (d.scenes[0]!.beats[1]!.text = 'z'), 'inspector')).toBe(false);
    st().select({ beatId: 'b2' });
    deleteBeat('s1', 'b2');
    expect(proj().scenes[0]!.beats.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    expect(st().selection.beatId).toBe('b2');
    expect(toast()?.text).toContain('无法删除');
    expect(st().applyEdit((d) => void (d.scenes[0]!.beats[1]!.meta.locked = false), '解锁')).toBe(true);
    deleteBeat('s1', 'b2');
    expect(proj().scenes[0]!.beats.map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('deleting a line that carries a locked key is refused and nothing changes', () => {
    writeKey('s1', { kind: 'actor', castId: 'a' }, 'expression', { name: 'exp_smile01' }, 2.5, { label: 'x' });
    const key = proj().scenes[0]!.tracks[0]!.keys[0]!;
    lock((d) => void (d.scenes[0]!.tracks[0]!.keys[0]!.meta.locked = true));
    const bid = key.at.beatId;
    deleteBeat('s1', bid);
    expect(proj().scenes[0]!.beats.some((b) => b.id === bid)).toBe(true);
    expect(proj().scenes[0]!.tracks[0]!.keys).toHaveLength(1);
  });

  it('removing a person with a locked blocking from the scene, and deleting a scene with locked content, are refused', () => {
    lock((d) => void (d.scenes[0]!.blocking.b!.meta.locked = true));
    toggleActorInScene('s1', 'b', false, 'mB');
    expect(Object.keys(proj().scenes[0]!.wardrobe)).toEqual(['a', 'b']);
    toggleActorInScene('s1', 'a', false, 'mA');
    expect(Object.keys(proj().scenes[0]!.wardrobe)).toEqual(['b']);
    st().open(miniProject(), 'etag');
    lock((d) => void (d.scenes[0]!.beats[0]!.meta.locked = true));
    deleteScene('s1');
    expect(proj().scenes).toHaveLength(1);
  });

  it('scene title lock does not block other scene edits', () => {
    lock((d) => void (d.scenes[0]!.meta.locked = true));
    editScene('s1', 'trans', (s) => void (s.transitionIn.kind = 'dip_black'));
    expect(proj().scenes[0]!.transitionIn.kind).toBe('dip_black');
    editScene('s1', 'title', (s) => void (s.title = 'zzz'));
    expect(proj().scenes[0]!.title).toBe('s1');
    expect(toast()?.text).toContain('已锁定');
  });

  it('a toast does not outlive the next successful edit', () => {
    lock((d) => void (d.scenes[0]!.beats[0]!.meta.locked = true));
    editBeat('s1', 'b1', 'x', (b) => void (b.text = 'z'));
    expect(toast()).not.toBeNull();
    addBeatAfter('s1', 'b1');
    expect(toast()).toBeNull();
  });
});

describe('ids are never reused (F6)', () => {
  it('a deleted line id, track id, key id and scene id do not come back', () => {
    const p = miniProject();
    const s = produce(p, (d) => {
      const last = d.scenes[0]!.beats.at(-1)!.id;
      const n = newBeat(d.scenes[0]!);
      removeBeat(d.scenes[0]!, last);
      const again = newBeat(d.scenes[0]!);
      expect(again.id).not.toBe(n.id);
      expect(again.id).not.toBe(last);
      const tr = ensureTrack(d.scenes[0]!, { kind: 'actor', castId: 'a' }, 'motion');
      const k1 = addKey(d.scenes[0]!, tr, { beatId: 'b1', offset: 0 }, { name: 'x' }).id;
      tr.keys.pop();
      expect(newKeyId(d.scenes[0]!)).not.toBe(k1);
    });
    // the counter is stored in the project, so it survives save / load
    expect(s.scenes[0]!.idSeq).toBeTruthy();
    const reloaded = JSON.parse(JSON.stringify(s)) as Project;
    const again = produce(reloaded, (d) => void newBeat(d.scenes[0]!));
    expect(again.scenes[0]!.idSeq).not.toEqual(s.scenes[0]!.idSeq);
  });

  it('delete then add gives a new id; undo / redo keep ids unique', () => {
    st().open(miniProject(), 'e');
    const a = addBeatAfter('s1', 'b3')!;
    deleteBeat('s1', a);
    const b = addBeatAfter('s1', 'b3')!;
    expect(b).not.toBe(a);
    st().undo();
    st().undo();
    st().undo();
    st().redo();
    const c = addBeatAfter('s1', 'b3')!;
    const ids = proj().scenes[0]!.beats.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(c).toBeTruthy();
  });
});

describe('background magnification reaches the renderer (F1)', () => {
  const camAt = (type: string, focus: string[]) => {
    const p = miniProject({ beats: [{ id: 'b1', kind: 'dialogue', speakerId: 'a', text: '你好呀，今天天气真不错。', shot: { type, focus, move: 'static' } }] });
    const c = compileProject(p, MINI_CTX);
    return evaluate(c, c.scenes[0]!.beats[0]!.start + 0.1).camera;
  };
  it('evaluate keeps the style table bgZoom (two_shot 1.45, cu 2.5)', () => {
    expect(camAt('two_shot', ['a', 'b']).bgZoom).toBeCloseTo(1.45, 1);
    expect(camAt('cu', ['a']).bgZoom).toBeGreaterThanOrEqual(2.5 * 0.99);
  });
  it('a hand-made camera key carries bgZoom and roll through', () => {
    const p = miniProject({ tracks: [{ id: 't1', target: { kind: 'camera' }, channel: 'camera', keys: [{ id: 'k1', at: { beatId: 'b1', offset: 0 }, value: { manual: { x: 1000, y: 560, zoom: 2, bgZoom: 1.2, roll: 5 } } }] }] });
    const c = compileProject(p, MINI_CTX);
    const s = evaluate(c, c.scenes[0]!.beats[0]!.start + 0.1);
    expect(s.camera.bgZoom).toBeCloseTo(1.2);
    expect(s.fx.roll).toBeCloseTo(5);
  });
});

describe('field-level locks (meta.lockedFields)', () => {
  const beat = (over: Record<string, unknown> = {}) => ({
    id: 'b1', text: '原文', emotion: 'happy', kind: 'dialogue', meta: { source: 'ai', locked: false, lockedFields: ['text', 'emotion'], updatedAt: 0 }, ...over,
  });
  const proj = (b: unknown) => ({ scenes: [{ id: 's1', title: 't', meta: { source: 'ai', locked: false, updatedAt: 0 }, beats: [b] }] });

  it('refuses a change of a locked field, allows the other fields and unlocking', () => {
    const before = proj(beat());
    expect(findLockViolations(before, proj(beat({ text: '改了' })))[0]).toMatchObject({ reason: 'changed' });
    expect(findLockViolations(before, proj(beat({ emotion: 'sad' }))).length).toBe(1);
    expect(findLockViolations(before, proj(beat({ kind: 'narration' })))).toEqual([]);
    expect(findLockViolations(before, proj(beat({ meta: { source: 'user', locked: false, updatedAt: 1 } })))).toEqual([]); // unlocking is a meta change
    expect(describeViolations(findLockViolations(before, proj(beat({ text: 'x' }))))).toContain('文本');
  });
});
