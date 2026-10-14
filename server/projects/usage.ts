import type { Project } from '../../shared/schema/project';

export interface BackgroundUsage {
  id: string;
  title: string;
  /** number of scenes that show the background (as start background or on a background track) */
  scenes: number;
}

/** Projects that reference a background id: `scene.background.assetId` or a background-track key's `value.assetId`. */
export function backgroundUsage(projects: readonly Project[], assetId: string): BackgroundUsage[] {
  const out: BackgroundUsage[] = [];
  for (const p of projects) {
    const scenes = p.scenes.filter(
      (sc) => sc.background.assetId === assetId || sc.tracks.some((t) => t.channel === 'background' && t.keys.some((k) => k.value.assetId === assetId)),
    ).length;
    if (scenes > 0) out.push({ id: p.id, title: p.title, scenes });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
}
