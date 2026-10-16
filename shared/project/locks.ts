/**
 * Lock semantics (PLAN 1.1), enforced in one place for every edit path.
 *
 * A unit is any object carrying `meta` (scene title, background, wardrobe entry, blocking entry, beat, shot, track,
 * key, ...). A locked unit may not be changed or removed by a person; the AI and the rule director never overwrite it
 * either. What a lock covers is the unit's OWN content (its fields without `meta`, without nested units). Nested units
 * have their own locks, with one exception: a track owns its keys, so a locked track protects all of them.
 * Unlocking (changing only `meta`) is always allowed. Re-ordering keeps content, so it is allowed too.
 */
export type Seg = string | { id: string };
export interface LockViolation {
  path: Seg[];
  reason: 'changed' | 'removed';
  /** Human readable name of the unit, e.g. 台词「早上好」, 服装 (香澄). */
  label: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUnit = (v: unknown): v is Obj & { meta: { locked: boolean; lockedFields?: string[] } } => isObj(v) && isObj(v.meta) && typeof v.meta.locked === 'boolean';
const isTrack = (v: Obj) => typeof v.channel === 'string' && Array.isArray(v.keys);
const isIdItem = (v: unknown): v is Obj & { id: string } => isObj(v) && typeof v.id === 'string';

/** True for values that hold only units (a unit, a list of units, a record of units): they are not "own content". */
const holdsUnits = (v: unknown): boolean => {
  if (isUnit(v)) return true;
  if (Array.isArray(v)) return v.every(isUnit);
  if (isObj(v)) return Object.values(v).every(isUnit);
  return false;
};

function stripMeta(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripMeta);
  if (isObj(v)) {
    const o: Obj = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'meta') o[k] = stripMeta(x);
    return o;
  }
  return v;
}

/** The part of a unit that its lock protects. */
export function ownContent(u: Obj): Obj {
  if (isTrack(u)) return stripMeta(u) as Obj;
  const o: Obj = {};
  for (const [k, v] of Object.entries(u)) {
    if (k === 'meta' || k === 'idSeq') continue; // idSeq is id bookkeeping, not content
    if (isObj(v) || Array.isArray(v)) {
      if (holdsUnits(v)) continue;
      o[k] = stripMeta(v);
    } else o[k] = v;
  }
  return o;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

export function getByPath(root: unknown, path: Seg[]): unknown {
  let cur: unknown = root;
  for (const s of path) {
    if (typeof s === 'string') cur = isObj(cur) ? cur[s] : undefined;
    else cur = Array.isArray(cur) ? cur.find((x) => isIdItem(x) && x.id === s.id) : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

const KIND: Record<string, string> = {
  scenes: '场景标题', cast: '角色', background: '背景', wardrobe: '服装', blocking: '站位', transitionIn: '转场', location: '地点标题条',
  bgm: 'BGM', ambience: '环境音', beats: '台词', shot: '镜头', style: '风格设置', tracks: '轨道', keys: '关键帧',
};

const FIELD_LABEL: Record<string, string> = { text: '文本', speakerId: '说话人', kind: '类型', duration: '时长', emotion: '情绪', cutIn: '镜头切入', type: '景别', focus: '焦点', move: '运镜', dof: '景深', transition: '换镜方式', offsets: '画面位置' };

function labelOf(root: Obj, path: Seg[], node: Obj): string {
  const last = path.at(-1);
  const holder = typeof last === 'string' ? last : undefined;
  const parentKey = [...path].reverse().find((s): s is string => typeof s === 'string');
  const name = (castId: string) => {
    const c = (Array.isArray(root.cast) ? root.cast : []).find((x) => isIdItem(x) && x.id === castId) as Obj | undefined;
    return typeof c?.displayName === 'string' && c.displayName ? c.displayName : castId;
  };
  if (isTrack(node)) {
    const tg = isObj(node.target) && typeof node.target.castId === 'string' ? `${name(node.target.castId)}的` : '';
    return `${tg}${String(node.channel)} 轨道`;
  }
  if (typeof last === 'object') {
    const kind = KIND[parentKey ?? ''] ?? '内容';
    if (parentKey === 'beats') {
      const t = typeof node.text === 'string' ? [...node.text].slice(0, 10).join('') : '';
      return t ? `台词「${t}」` : `台词 ${last.id}`;
    }
    if (parentKey === 'scenes') return `场景「${typeof node.title === 'string' ? node.title : last.id}」`;
    return `${kind} ${last.id}`;
  }
  const idx = path.findIndex((s) => s === 'wardrobe' || s === 'blocking');
  if (idx >= 0 && typeof path[idx + 1] === 'string') return `${name(path[idx + 1] as string)}的${KIND[path[idx] as string]}`;
  if (holder === 'shot') return '这句的镜头';
  if (holder === 'style') return '风格设置';
  return KIND[holder ?? ''] ?? '内容';
}

function collectLocked(root: Obj, v: unknown, path: Seg[], out: LockViolation[], reason: LockViolation['reason']): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => collectLocked(root, x, [...path, isIdItem(x) ? { id: x.id } : String(i)], out, reason));
    return;
  }
  if (!isObj(v)) return;
  if (isUnit(v) && v.meta.locked) out.push({ path, reason, label: labelOf(root, path, v) });
  for (const [k, x] of Object.entries(v)) if (k !== 'meta') collectLocked(root, x, [...path, k], out, reason);
}

function check(root: Obj, b: unknown, a: unknown, path: Seg[], out: LockViolation[]): void {
  if (b === a) return;
  if (Array.isArray(b)) {
    if (!Array.isArray(a)) return collectLocked(root, b, path, out, 'removed');
    b.forEach((x, i) => {
      const seg: Seg = isIdItem(x) ? { id: x.id } : String(i);
      const ac = isIdItem(x) ? a.find((y) => isIdItem(y) && y.id === x.id) : a[i];
      if (ac === undefined) collectLocked(root, x, [...path, seg], out, 'removed');
      else check(root, x, ac, [...path, seg], out);
    });
    return;
  }
  if (!isObj(b)) return;
  if (!isObj(a)) return collectLocked(root, b, path, out, 'removed');
  if (isUnit(b) && b.meta.locked && !deepEqual(ownContent(b), ownContent(a))) out.push({ path, reason: 'changed', label: labelOf(root, path, b) });
  else if (isUnit(b) && !b.meta.locked && Array.isArray(b.meta.lockedFields) && b.meta.lockedFields.length > 0) {
    // field-level locks: only the named fields of the unit are protected
    const ob = ownContent(b);
    const oa = ownContent(a);
    const hit = b.meta.lockedFields.filter((f) => !deepEqual(ob[f], oa[f]));
    if (hit.length > 0) out.push({ path, reason: 'changed', label: `${labelOf(root, path, b)}的「${hit.map((f) => FIELD_LABEL[f] ?? f).join('、')}」` });
  }
  for (const [k, x] of Object.entries(b)) {
    if (k === 'meta') continue;
    const ac = a[k];
    if (ac === undefined) collectLocked(root, x, [...path, k], out, 'removed');
    else check(root, x, ac, [...path, k], out);
  }
}

/** Locked units of `before` that `after` changed or removed (empty = the edit respects every lock). */
export function findLockViolations(before: unknown, after: unknown): LockViolation[] {
  const out: LockViolation[] = [];
  if (!isObj(before)) return out;
  check(before, before, after, [], out);
  // a locked track already reported covers its locked keys
  return out.filter((v, i) => !out.some((o, j) => j !== i && o.path.length < v.path.length && o.path.every((s, n) => JSON.stringify(s) === JSON.stringify(v.path[n])) && o.label.endsWith('轨道')));
}

/** A one-line explanation for a toast. */
export function describeViolations(vs: LockViolation[]): string {
  const first = vs[0]!;
  const more = vs.length > 1 ? `等 ${vs.length} 项` : '';
  return first.reason === 'removed' ? `无法删除：包含已锁定的${first.label}${more}` : `${first.label}${more}已锁定，不能修改`;
}
