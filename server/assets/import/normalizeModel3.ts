/**
 * Pure model3.json normalisation. Site-style packages reference textures by absolute site paths and keep every
 * motion in one group; the indexer reads only `list[0]` of a group, so they must be rewritten to the local layout
 * (relative paths under the model directory, one motion per group named after the motion file).
 */

export interface NormalizeResult {
  /** The rewritten model3.json (null when the input is unusable). */
  json: Record<string, unknown> | null;
  /** Files to copy: `src` is whatever `resolve` returned, `dest` is relative to the model directory. */
  files: Array<{ src: string; dest: string }>;
  counts: { textures: number; motions: number; expressions: number };
  /** True when the output differs structurally from the input (paths rewritten or groups split). */
  changed: boolean;
  errors: string[];
  warnings: string[];
}

export type RefKind = 'moc' | 'texture' | 'physics' | 'expression' | 'motion';
/** Maps a reference found in model3.json to a source file id (or null when the package does not contain it). */
export type RefResolver = (ref: string, kind: RefKind) => string | null;

const GENERIC_GROUPS = new Set(['', 'motion', 'motions']);

export function refBasename(ref: string): string {
  const clean = ref.split(/[?#]/)[0] ?? ref;
  return clean.split(/[\\/]/).pop() ?? clean;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function normalizeModel3(input: unknown, resolve: RefResolver): NormalizeResult {
  const out: NormalizeResult = { json: null, files: [], counts: { textures: 0, motions: 0, expressions: 0 }, changed: false, errors: [], warnings: [] };
  if (typeof input !== 'object' || input === null) {
    out.errors.push('model3.json 不是有效的 JSON 对象');
    return out;
  }
  const src = input as Record<string, unknown>;
  const refs = (src.FileReferences ?? {}) as Record<string, unknown>;
  const used = new Map<string, string>(); // dest -> src
  const take = (srcId: string, wanted: string): string => {
    let dest = wanted;
    for (let n = 2; used.has(dest) && used.get(dest) !== srcId; n++) {
      const dot = wanted.lastIndexOf('.');
      dest = `${wanted.slice(0, dot)}_${n}${wanted.slice(dot)}`;
    }
    if (!used.has(dest)) {
      used.set(dest, srcId);
      out.files.push({ src: srcId, dest });
    }
    return dest;
  };
  const same = (a: unknown, b: string) => a === b;

  const next: Record<string, unknown> = {};

  // Moc
  if (typeof refs.Moc !== 'string' || !refs.Moc) out.errors.push('model3.json 没有 Moc 引用');
  else {
    const f = resolve(refs.Moc, 'moc');
    if (!f) out.errors.push(`找不到 moc3 文件：${refs.Moc}`);
    else {
      next.Moc = take(f, 'model.moc3');
      if (!same(refs.Moc, 'model.moc3')) out.changed = true;
    }
  }

  // Textures
  const textures: string[] = [];
  for (const t of Array.isArray(refs.Textures) ? refs.Textures : []) {
    if (typeof t !== 'string') continue;
    const f = resolve(t, 'texture');
    if (!f) {
      out.errors.push(`找不到纹理：${t}`);
      continue;
    }
    const dest = take(f, `textures/${refBasename(t)}`);
    if (dest !== t) out.changed = true;
    textures.push(dest);
  }
  if (textures.length === 0 && out.errors.length === 0) out.errors.push('模型没有任何纹理');
  next.Textures = textures;
  out.counts.textures = textures.length;

  // Physics (optional)
  if (typeof refs.Physics === 'string' && refs.Physics) {
    const f = resolve(refs.Physics, 'physics');
    if (!f) out.warnings.push(`找不到物理文件，已忽略：${refs.Physics}`);
    else {
      next.Physics = take(f, 'physics3.json');
      if (refs.Physics !== 'physics3.json') out.changed = true;
    }
  }

  // Expressions (optional)
  const exprs: Array<Record<string, unknown>> = [];
  for (const e of Array.isArray(refs.Expressions) ? refs.Expressions : []) {
    const rec = e as Record<string, unknown>;
    if (typeof rec?.File !== 'string') continue;
    const f = resolve(rec.File, 'expression');
    if (!f) {
      out.warnings.push(`找不到表情文件，已忽略：${rec.File}`);
      continue;
    }
    const base = refBasename(rec.File);
    const dest = take(f, `expressions/${base}`);
    if (dest !== rec.File) out.changed = true;
    const name = typeof rec.Name === 'string' && rec.Name ? rec.Name : safeDecode(base.replace(/\.exp3\.json$/i, ''));
    exprs.push({ ...rec, Name: name, File: dest });
  }
  if (exprs.length > 0) next.Expressions = exprs;
  out.counts.expressions = exprs.length;

  // Motions: one group per motion; existing single-entry groups keep their name
  const motions: Record<string, Array<Record<string, unknown>>> = {};
  const groupNames = new Set<string>();
  const addGroup = (wanted: string) => {
    let name = wanted;
    for (let n = 2; groupNames.has(name); n++) name = `${wanted}_${n}`;
    groupNames.add(name);
    return name;
  };
  const srcMotions = (refs.Motions ?? {}) as Record<string, unknown>;
  for (const [group, list] of Object.entries(srcMotions)) {
    const entries = Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
    const split = entries.length > 1 || (entries.length === 1 && GENERIC_GROUPS.has(group.toLowerCase()));
    if (entries.length > 1) out.changed = true;
    for (const m of entries) {
      if (typeof m?.File !== 'string') continue;
      const f = resolve(m.File, 'motion');
      if (!f) {
        out.warnings.push(`找不到动作文件，已忽略：${m.File}`);
        continue;
      }
      const base = refBasename(m.File);
      const dest = take(f, `motions/${base}`);
      if (dest !== m.File) out.changed = true;
      const wanted = split ? safeDecode(base.replace(/\.motion3\.json$/i, '')) : group;
      if (split && wanted !== group) out.changed = true;
      motions[addGroup(wanted)] = [{ ...m, File: dest }];
      out.counts.motions++;
    }
  }
  next.Motions = motions;

  const rest = Object.fromEntries(Object.entries(refs).filter(([k]) => !['Moc', 'Textures', 'Physics', 'Expressions', 'Motions'].includes(k)));
  out.json = { ...src, FileReferences: { ...rest, ...next } };
  return out;
}

/** moc3 header: "MOC3" magic, then one version byte (rendering needs a Core whose latest moc version covers it). */
export function checkMoc3Header(head: Buffer): { ok: boolean; version: number; message?: string } {
  if (head.length < 5 || head.toString('ascii', 0, 4) !== 'MOC3') return { ok: false, version: 0, message: '不是有效的 moc3 文件（缺少 MOC3 文件头）' };
  return { ok: true, version: head[4]! };
}
