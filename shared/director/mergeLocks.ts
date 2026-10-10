/**
 * Server-enforced merge of a freshly expanded AI scene into the scene that already exists.
 *
 * Protected content is never overwritten: units with `meta.locked`, units that a person edited (`source: 'user'`, unless
 * `overwriteUser`) and fields named in `meta.lockedFields`. Only what the requested scopes cover is replaced (`scope.ts`).
 * If a lock cannot be honoured (a locked beat the new direction no longer contains, or the result would violate any
 * lock), nothing is applied: the old scene is returned together with the conflicts. Locks are never dropped silently.
 */
import { findLockViolations } from '../project/locks';
import type { Beat, Meta, Scene, Track } from '../schema/project';
import { BEAT_STRUCTURE_FIELDS, resolveScope, type ScopeName } from './scope';

export interface MergeOptions {
  scopes: readonly ScopeName[];
  /** Only these beats (their fields, keys and text) are regenerated. */
  beatIds?: readonly string[] | undefined;
  /** Also replace content a person edited (never locked content). */
  overwriteUser?: boolean | undefined;
}

export interface MergeConflict {
  kind: 'locked_beat_missing' | 'locked_key_dangling' | 'lock_violation';
  label: string;
}

export interface MergeReport {
  replacedBeats: string[];
  keptBeats: string[];
  replacedTracks: string[];
  keptTracks: string[];
  /** Human readable list of protected things that were kept instead of replaced. */
  protectedKept: string[];
}

export interface MergeResult {
  scene: Scene;
  applied: boolean;
  conflicts: MergeConflict[];
  report: MergeReport;
}

type AnyKey = { id: string; at: { beatId: string; offset: number }; value: unknown; duration: number; ease: string; meta: Meta };
type AnyTrack = Omit<Track, 'keys'> & { keys: AnyKey[] };
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const targetKey = (t: Track['target']) => (t.kind === 'actor' ? `actor:${t.castId}` : t.kind);

export function mergeLocks(old: Scene, fresh: Scene, opts: MergeOptions): MergeResult {
  const R = resolveScope(opts.scopes);
  const sel = opts.beatIds ? new Set(opts.beatIds) : null;
  const overwrite = opts.overwriteUser === true;
  const report: MergeReport = { replacedBeats: [], keptBeats: [], replacedTracks: [], keptTracks: [], protectedKept: [] };
  const conflicts: MergeConflict[] = [];
  const out = clone(old);

  const protectedMeta = (m: Meta) => m.locked || (!overwrite && m.source === 'user');
  const fieldProtected = (m: Meta, f: string) => m.locked || (m.lockedFields?.includes(f) ?? false);
  const inSel = (id: string) => !sel || sel.has(id);

  // ---- beats ---------------------------------------------------------------------------------------------
  const freshById = new Map(fresh.beats.map((b) => [b.id, b]));
  const mergeShot = (os: Beat['shot'], fs: Beat['shot'], label: string): Beat['shot'] => {
    if (os.meta.locked || (!overwrite && os.meta.source === 'user')) {
      report.protectedKept.push(`${label}的镜头`);
      return os;
    }
    const merged: Beat['shot'] = { ...clone(fs), meta: { ...fs.meta, ...(os.meta.lockedFields ? { lockedFields: os.meta.lockedFields } : {}) } };
    for (const f of os.meta.lockedFields ?? []) {
      (merged as Record<string, unknown>)[f] = (os as Record<string, unknown>)[f];
      report.protectedKept.push(`${label}的镜头.${f}`);
    }
    return merged;
  };
  const mergeBeat = (ob: Beat, fb: Beat, structure: boolean): Beat => {
    const label = ob.text ? `台词「${[...ob.text].slice(0, 8).join('')}」` : `台词 ${ob.id}`;
    if (ob.meta.locked) {
      report.keptBeats.push(ob.id);
      report.protectedKept.push(label);
      return ob;
    }
    const res: Beat = clone(ob);
    let touched = false;
    if (structure) {
      for (const f of BEAT_STRUCTURE_FIELDS) {
        if (fieldProtected(ob.meta, f) || (!overwrite && ob.meta.source === 'user')) {
          if (JSON.stringify((fb as Record<string, unknown>)[f]) !== JSON.stringify((ob as Record<string, unknown>)[f])) report.protectedKept.push(`${label}.${f}`);
          continue;
        }
        (res as Record<string, unknown>)[f] = clone((fb as Record<string, unknown>)[f]);
        if (fb[f as keyof Beat] === undefined) delete (res as Record<string, unknown>)[f];
        touched = true;
      }
    }
    for (const f of R.beatFields) {
      if (fieldProtected(ob.meta, f)) {
        report.protectedKept.push(`${label}.${f}`);
        continue;
      }
      if (f === 'shot') res.shot = mergeShot(ob.shot, fb.shot, label);
      else (res as Record<string, unknown>)[f] = clone((fb as Record<string, unknown>)[f]);
      touched = true;
    }
    if (touched) {
      res.meta = !overwrite && ob.meta.source === 'user' ? ob.meta : { ...fb.meta, ...(ob.meta.lockedFields ? { lockedFields: ob.meta.lockedFields } : {}) };
      report.replacedBeats.push(ob.id);
    }
    return res;
  };

  if (R.structure && !sel) {
    const merged: Beat[] = [];
    for (const fb of fresh.beats) {
      const ob = old.beats.find((b) => b.id === fb.id);
      merged.push(ob ? mergeBeat(ob, fb, true) : fb);
      if (!ob) report.replacedBeats.push(fb.id);
    }
    // old beats the new direction does not contain
    old.beats.forEach((ob, i) => {
      if (freshById.has(ob.id)) return;
      if (ob.meta.locked) {
        conflicts.push({ kind: 'locked_beat_missing', label: `已锁定的台词「${[...ob.text].slice(0, 10).join('')}」在新方案中找不到对应节拍` });
        return;
      }
      if (!overwrite && ob.meta.source === 'user') {
        // a hand-made beat stays where it was: right after its closest surviving predecessor
        let at = 0;
        for (let j = i - 1; j >= 0; j--) {
          const k = merged.findIndex((b) => b.id === old.beats[j]!.id);
          if (k >= 0) {
            at = k + 1;
            break;
          }
        }
        merged.splice(at, 0, ob);
        report.keptBeats.push(ob.id);
        report.protectedKept.push(`人工台词「${[...ob.text].slice(0, 10).join('')}」`);
      }
    });
    out.beats = merged;
  } else {
    out.beats = old.beats.map((ob) => {
      const fb = freshById.get(ob.id);
      if (!fb || !inSel(ob.id)) return ob;
      return mergeBeat(ob, fb, R.structure);
    });
  }
  const beatIndex = new Map(out.beats.map((b, i) => [b.id, i]));

  // ---- tracks --------------------------------------------------------------------------------------------
  const protectedKey = (k: AnyKey) => k.meta.locked || (!overwrite && k.meta.source === 'user');
  const oldTracks = old.tracks as unknown as AnyTrack[];
  const freshTracks = fresh.tracks as unknown as AnyTrack[];
  const scoped = (c: string) => R.tracks.has(c as Track['channel']);
  const merged: AnyTrack[] = [];
  const seen = new Set<string>();
  const find = (list: AnyTrack[], t: AnyTrack) => list.find((x) => x.channel === t.channel && targetKey(x.target) === targetKey(t.target));
  const sortKeys = (keys: AnyKey[]) => keys.sort((a, b) => (beatIndex.get(a.at.beatId) ?? 1e9) - (beatIndex.get(b.at.beatId) ?? 1e9) || a.at.offset - b.at.offset);

  for (const ot of oldTracks) {
    const id = `${ot.channel}:${targetKey(ot.target)}`;
    seen.add(id);
    if (!scoped(ot.channel)) {
      merged.push(clone(ot));
      continue;
    }
    if (ot.meta.locked) {
      merged.push(clone(ot));
      report.keptTracks.push(ot.id);
      report.protectedKept.push(`${ot.channel} 轨道（已锁定）`);
      continue;
    }
    const ft = find(freshTracks, ot);
    const replaceable = (k: AnyKey) => inSel(k.at.beatId) && !protectedKey(k);
    const kept = ot.keys.filter((k) => !replaceable(k));
    const heldBeats = new Set(kept.filter((k) => inSel(k.at.beatId)).map((k) => k.at.beatId));
    for (const k of kept) if (inSel(k.at.beatId) && protectedKey(k)) report.protectedKept.push(`${ot.channel} 关键帧 ${k.id}`);
    const added = (ft?.keys ?? []).filter((k) => inSel(k.at.beatId) && !heldBeats.has(k.at.beatId)).map(clone);
    const keys = sortKeys([...clone(kept), ...added]);
    if (keys.length > 0 || ot.meta.locked) merged.push({ ...clone(ot), keys });
    report.replacedTracks.push(ot.id);
  }
  for (const ft of freshTracks) {
    const id = `${ft.channel}:${targetKey(ft.target)}`;
    if (seen.has(id) || !scoped(ft.channel)) continue;
    const keys = sortKeys(ft.keys.filter((k) => inSel(k.at.beatId)).map(clone));
    if (keys.length > 0) {
      merged.push({ ...clone(ft), keys });
      report.replacedTracks.push(ft.id);
    }
  }
  out.tracks = merged as unknown as Scene['tracks'];

  // keys that point at beats which no longer exist: dropped, but never a locked one
  for (const t of out.tracks as unknown as AnyTrack[]) {
    t.keys = t.keys.filter((k) => {
      if (beatIndex.has(k.at.beatId)) return true;
      if (k.meta.locked || t.meta.locked) conflicts.push({ kind: 'locked_key_dangling', label: `已锁定的 ${t.channel} 关键帧指向被移除的台词` });
      return false;
    });
  }

  // ---- scene-level units -----------------------------------------------------------------------------------
  const mergeRecord = <V extends { meta: Meta }>(oldRec: Record<string, V>, freshRec: Record<string, V>, name: string): Record<string, V> => {
    const res = clone(oldRec);
    for (const [c, fv] of Object.entries(freshRec)) {
      const ov = oldRec[c];
      if (ov && protectedMeta(ov.meta)) {
        report.protectedKept.push(`${c} 的${name}`);
        continue;
      }
      res[c] = clone(fv);
    }
    return res;
  };
  if (R.sceneFields.has('wardrobe')) out.wardrobe = mergeRecord(old.wardrobe, fresh.wardrobe, '服装');
  if (R.sceneFields.has('blocking')) {
    out.blocking = mergeRecord(old.blocking, fresh.blocking, '站位');
  }
  // enter / exit markers must reference beats that exist
  for (const bl of Object.values(out.blocking)) {
    if (bl.enter && !beatIndex.has(bl.enter.beatId)) delete bl.enter;
    if (bl.exit && !beatIndex.has(bl.exit.beatId)) delete bl.exit;
  }
  if (R.structure && !sel) {
    if (protectedMeta(old.transitionIn.meta)) report.protectedKept.push('转场');
    else out.transitionIn = clone(fresh.transitionIn);
    if (fresh.audio.bgm) {
      if (old.audio.bgm && protectedMeta(old.audio.bgm.meta)) report.protectedKept.push('BGM');
      else out.audio = { ...out.audio, bgm: clone(fresh.audio.bgm) };
    }
  }
  out.idSeq = { ...(old.idSeq ?? {}) };
  for (const [k, v] of Object.entries(fresh.idSeq ?? {})) out.idSeq[k] = Math.max(out.idSeq[k] ?? 0, v);

  // ---- the lock gate: nothing locked may differ from before ---------------------------------------------------
  for (const v of findLockViolations(old, out)) conflicts.push({ kind: 'lock_violation', label: v.label });
  if (conflicts.length > 0) return { scene: old, applied: false, conflicts, report };
  return { scene: out, applied: true, conflicts, report };
}
