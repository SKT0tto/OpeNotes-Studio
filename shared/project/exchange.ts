/**
 * Project exchange: the `.openotes.json` envelope (legacy `.ournotes.json` still imports), the resource ids a project references, and replacing
 * references that the current library does not have. Pure functions (shared by the browser and tests).
 */
import { z } from 'zod';
import { ProjectSchema, type Project } from '../schema/project';

export type RefKind = 'model' | 'background' | 'audio';
export interface Refs {
  models: string[];
  backgrounds: string[];
  audio: string[];
}

export const EXPORT_FORMAT = 'openotes-project';
/** Files exported before the rename (OurNotes Studio) are still accepted on import. */
export const LEGACY_EXPORT_FORMATS = ['ournotes-project'] as const;

export const ExportEnvelopeSchema = z.object({
  format: z.enum([EXPORT_FORMAT, ...LEGACY_EXPORT_FORMATS]),
  formatVersion: z.literal(1),
  exportedAt: z.string(),
  /** Catalog hash at export time; a different value on import only means "the library changed". */
  catalogVersion: z.string(),
  /** Resource ids referenced by the project (no asset files are ever included). */
  refs: z.object({ models: z.array(z.string()), backgrounds: z.array(z.string()), audio: z.array(z.string()) }),
  project: z.unknown(),
});

const sorted = (s: Set<string>) => [...s].sort();

/** Every library resource id the project mentions (wardrobe, costume keys, backgrounds, BGM / SE). */
export function collectRefs(project: Project): Refs {
  const models = new Set<string>();
  const backgrounds = new Set<string>();
  const audio = new Set<string>();
  for (const s of project.scenes) {
    backgrounds.add(s.background.assetId);
    Object.values(s.wardrobe).forEach((w) => models.add(w.modelId));
    if (s.audio.bgm) audio.add(s.audio.bgm.assetId);
    if (s.audio.ambience) audio.add(s.audio.ambience.assetId);
    for (const tr of s.tracks) {
      if (tr.channel === 'costume') tr.keys.forEach((k) => models.add(k.value.modelId));
      if (tr.channel === 'bgm') tr.keys.forEach((k) => k.value.assetId && audio.add(k.value.assetId));
      if (tr.channel === 'se') tr.keys.forEach((k) => audio.add(k.value.assetId));
    }
  }
  return { models: sorted(models), backgrounds: sorted(backgrounds), audio: sorted(audio) };
}

export function exportEnvelope(project: Project, catalogVersion: string, now = new Date()) {
  return { format: EXPORT_FORMAT, formatVersion: 1 as const, exportedAt: now.toISOString(), catalogVersion, refs: collectRefs(project), project };
}

export type ImportResult = { ok: true; project: Project; catalogVersion: string | null } | { ok: false; error: string };

/** Accepts an export envelope or a bare project; never throws. */
export function parseImport(text: string): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `不是有效的 JSON：${(e as Error).message}` };
  }
  const env = ExportEnvelopeSchema.safeParse(raw);
  const body = env.success ? env.data.project : raw;
  const parsed = ProjectSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `项目文件不符合 schema：${first ? `${first.path.join('.')} ${first.message}` : '未知错误'}` };
  }
  return { ok: true, project: parsed.data, catalogVersion: env.success ? env.data.catalogVersion : null };
}

export interface CatalogIds {
  models: ReadonlySet<string>;
  backgrounds: ReadonlySet<string>;
  audio: ReadonlySet<string>;
}

export interface MissingRef {
  kind: RefKind;
  id: string;
}

export function findMissing(project: Project, have: CatalogIds): MissingRef[] {
  const r = collectRefs(project);
  return [
    ...r.models.filter((id) => !have.models.has(id)).map((id) => ({ kind: 'model' as const, id })),
    ...r.backgrounds.filter((id) => !have.backgrounds.has(id)).map((id) => ({ kind: 'background' as const, id })),
    ...r.audio.filter((id) => !have.audio.has(id)).map((id) => ({ kind: 'audio' as const, id })),
  ];
}

/** Replace one referenced id everywhere it occurs (returns a new project). */
export function replaceRef(project: Project, kind: RefKind, from: string, to: string): Project {
  const next = structuredClone(project);
  for (const s of next.scenes) {
    if (kind === 'background' && s.background.assetId === from) s.background.assetId = to;
    if (kind === 'model') for (const w of Object.values(s.wardrobe)) if (w.modelId === from) w.modelId = to;
    if (kind === 'audio') {
      if (s.audio.bgm?.assetId === from) s.audio.bgm.assetId = to;
      if (s.audio.ambience?.assetId === from) s.audio.ambience.assetId = to;
    }
    for (const tr of s.tracks) {
      if (kind === 'model' && tr.channel === 'costume') tr.keys.forEach((k) => { if (k.value.modelId === from) k.value.modelId = to; });
      if (kind === 'audio' && tr.channel === 'bgm') tr.keys.forEach((k) => { if (k.value.assetId === from) k.value.assetId = to; });
      if (kind === 'audio' && tr.channel === 'se') tr.keys.forEach((k) => { if (k.value.assetId === from) k.value.assetId = to; });
    }
  }
  return next;
}
