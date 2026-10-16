/** Which scenes still lack travel direction: a scene directed for travel (AI or rule director) has at least one beat with a narrative `shot.intent`. */
import { cameraSystemOf, type Project, type Scene } from '../schema/project';

/** True when any beat of the scene carries a travel narrative intent. A scene directed under classic has none. */
export function hasTravelDirection(scene: Pick<Scene, 'beats'>): boolean {
  return scene.beats.some((b) => b.shot.intent !== undefined);
}

/** The travel-mode scenes (project default or per-scene override) that no travel direction has touched yet. Classic scenes never count. */
export function scenesNeedingTravelDirection(project: Pick<Project, 'settings' | 'scenes'>): Scene[] {
  return project.scenes.filter((s) => cameraSystemOf(project, s) === 'travel' && !hasTravelDirection(s));
}
