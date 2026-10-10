import { expandScene } from '../../../shared/director/expand';
import { projectFromBreakdown } from '../../../shared/director/fromBreakdown';
import { mergeLocks } from '../../../shared/director/mergeLocks';
import { splitParagraphs } from '../../../shared/director/paragraphs';
import { validateBreakdown, validateDirection } from '../../../shared/director/validate';
import { BreakdownSchema, SceneDirectionSchema, type SceneDirection } from '../../../shared/schema/ai';
import { ProjectSchema, type Project, type Scene } from '../../../shared/schema/project';
import { STORY, fixtureCatalog, readFixture } from './directorCatalog';

export const cat = fixtureCatalog();
export const paragraphs = splitParagraphs(STORY);
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function skeleton(): Project {
  const bd = BreakdownSchema.parse(readFixture('breakdown-story.json'));
  const v = validateBreakdown(bd, { catalog: cat, paragraphCount: paragraphs.length });
  return ProjectSchema.parse(projectFromBreakdown({ title: '示例', text: STORY, paragraphs, breakdown: v.value, catalog: cat, genId: 'g1', now: 1000 }));
}

const SCENE_FILES = [['scene-0-2-scene.json'], ['scene-3-5-scene.json'], ['scene-6-12-scene.json', 'scene-13-18-scene.json'], ['scene-19-22-scene.json']];

export function recordedDirection(i: number): SceneDirection {
  const ds = SCENE_FILES[i]!.map((f) => SceneDirectionSchema.parse(readFixture(f)));
  return ds.reduce((a, b) => ({ ...a, beats: [...a.beats, ...b.beats], costumeChanges: [...a.costumeChanges, ...b.costumeChanges.map((c) => ({ ...c, beatIndex: c.beatIndex + a.beats.length }))] }));
}

export function sceneCtx(project: Project, scene: Scene) {
  const inScene = paragraphs.filter((p) => p.start >= scene.sourceSpan.start && p.end <= scene.sourceSpan.end);
  return {
    catalog: cat, paragraphs, range: { start: inScene[0]!.index, end: inScene.at(-1)!.index }, isPerformance: !!scene.brief?.isPerformance,
    cast: Object.keys(scene.wardrobe).map((castId) => ({ castId, characterKey: project.cast.find((c) => c.id === castId)!.characterKey, modelId: scene.wardrobe[castId]!.modelId })),
  };
}

/** Fresh (expanded) scene of recorded scene `i` on top of the skeleton scene. */
export function expandedScene(project: Project, i: number, genId = 'g2'): Scene {
  const s = project.scenes[i]!;
  const dir = validateDirection(recordedDirection(i), sceneCtx(project, s)).value;
  return expandScene({ base: s, direction: dir, paragraphs, genId, now: 2000 }).scene;
}

/** The skeleton with every scene directed (merged with the `scene` scope, as the server does on the first run). */
export function directedProject(): Project {
  const p = skeleton();
  p.scenes = p.scenes.map((s, i) => mergeLocks(s, expandedScene(p, i), { scopes: ['scene'] }).scene);
  return ProjectSchema.parse(p);
}
