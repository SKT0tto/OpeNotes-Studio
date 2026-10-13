import { useMemo } from 'react';
import { bandText, bgFit, sceneBands, type SceneWho } from '@shared/director/bandFit';
import { bgCategoryOf } from '@shared/director/bgCategory';
import type { BackgroundEntry, CompactCatalog } from '@shared/schema/assets';
import type { Project, Scene } from '@shared/schema/project';
import type { BgFitInfo } from './BgPicker';

/** Who is on stage decides which backgrounds fit; a manual choice is always allowed, but flagged (band conflict, unknown owner, decor, cut-away picture, not a stage). */
export function useSceneFit(project: Project, scene: Scene, catalog: CompactCatalog | null): (b: BackgroundEntry) => BgFitInfo {
  return useMemo(() => {
    const keys = Object.keys(scene.wardrobe).map((id) => project.cast.find((c) => c.id === id)?.characterKey ?? '').filter(Boolean);
    const infos = new Map((catalog?.characters ?? []).map((c) => [c.key, c] as const));
    const who: SceneWho = { bands: sceneBands(infos, keys), cast: keys, guestOf: scene.brief?.guestOf ?? null, mood: scene.brief?.mood, text: `${scene.title} ${scene.brief?.mood ?? ''}` };
    const bandName = (k: string) => catalog?.bands.find((b) => b.key === k)?.name ?? k;
    const performance = scene.brief?.isPerformance === true;
    return (b: BackgroundEntry): BgFitInfo => {
      const cat = bgCategoryOf(b);
      if (cat === 'decor') return { level: 'no', reason: '装饰素材，平时不作剧情背景' };
      if (cat === 'insert') return { level: 'no', reason: '插入镜头素材，用在空镜头' };
      const f = bgFit(b.labels, who, catalog?.labelRules);
      if (f === 'no') return { level: 'no', reason: `属于 ${bandText(b.labels, bandName)}，与出场角色冲突` };
      if (performance && b.labels && !b.labels.stage) return { level: 'no', reason: '正式演出需要舞台背景' };
      if (f === 'fallback') return { level: 'fallback', reason: '主人 / 归属不明' };
      return { level: 'ok', reason: null };
    };
  }, [project.cast, scene.wardrobe, scene.brief, scene.title, catalog]);
}
