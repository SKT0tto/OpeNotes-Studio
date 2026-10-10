import { ProjectSchema, type Project } from '../schema/project';

export const newProjectId = () => `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** An empty project (no scenes yet); scenes come from the editor or, later, the AI director. */
export function blankProject(title: string, now = Date.now()): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: newProjectId(),
    title,
    createdAt: now,
    updatedAt: now,
    settings: { aspect: '16:9', fps: 30, textSpeedCps: 12, defaultLineGap: 0.25 },
    source: { text: '', format: 'script' },
    cast: [],
    scenes: [],
  });
}
