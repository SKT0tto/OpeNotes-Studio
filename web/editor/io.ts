import { exportEnvelope } from '@shared/project/exchange';
import type { Project } from '@shared/schema/project';

/** Offer the project as a `.openotes.json` download (project + referenced resource ids, never asset files). */
export function downloadProject(project: Project, catalogVersion: string): void {
  const blob = new Blob([`${JSON.stringify(exportEnvelope(project, catalogVersion), null, 1)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.title.replace(/[\\/:*?"<>|]+/g, '_') || project.id}.openotes.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
