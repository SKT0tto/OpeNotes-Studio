import type { Scene } from '@shared/schema/project';
import type { CompiledProject } from '@shared/timeline/types';
import { manualCameraKey } from '../../store/actions';

export interface Pose {
  x: number;
  y: number;
  zoom: number;
  bgZoom?: number;
  roll?: number;
}

/** The camera of a line: its hand-set pose, or the pose the solver chose for it (the last camera key at its start). */
export function cameraOfBeat(compiled: CompiledProject | null, scene: Scene | undefined, sceneId: string, beatId: string): { pose: Pose; manual: boolean } | null {
  if (!scene) return null;
  const key = manualCameraKey(scene, beatId);
  if (key) return { pose: (key.value as { manual: Pose }).manual, manual: true };
  const cs = compiled?.scenes.find((s) => s.id === sceneId);
  const beat = cs?.beats.find((b) => b.id === beatId);
  if (!cs || !beat) return null;
  const at = beat.start + 1e-6;
  const k = [...cs.camera].reverse().find((c) => c.at <= at) ?? cs.camera[0];
  return k ? { pose: { x: k.pose.x, y: k.pose.y, zoom: k.pose.zoom, ...(k.pose.bgZoom !== undefined ? { bgZoom: k.pose.bgZoom } : {}) }, manual: false } : null;
}

/** The stored line the playhead is in (the automatic establishing shot counts as the first line). */
export function beatAtTime(compiled: CompiledProject | null, scene: Scene | undefined, sceneId: string, t: number): string | null {
  const cs = compiled?.scenes.find((s) => s.id === sceneId);
  if (!cs || !scene) return null;
  const stored = new Set(scene.beats.map((b) => b.id));
  const any = cs.beats.find((b) => t >= b.start && t < b.end);
  if (any && !stored.has(any.id)) return null; // the automatic establishing shot has no stored line
  return any?.id ?? scene.beats[0]?.id ?? null;
}
