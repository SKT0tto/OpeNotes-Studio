import type { CompactCatalog } from '@shared/schema/assets';
import type { Project } from '@shared/schema/project';

/** The costume a cast member wears when put on stage without a choice: the first normal-quality model of their character. */
export function defaultModelOf(catalog: CompactCatalog | null, project: Pick<Project, 'cast'>, castId: string): string | null {
  const key = project.cast.find((c) => c.id === castId)?.characterKey;
  const ids = catalog?.characters.find((c) => c.key === key)?.modelIds ?? [];
  return catalog?.models.find((m) => ids.includes(m.id) && m.quality !== 'low')?.id ?? ids[0] ?? null;
}
