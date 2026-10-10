/** Client of the project store (`/api/projects`). Saves are guarded by the ETag of the version that was loaded. */
import type { Project } from '@shared/schema/project';

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: number;
  scenes: number;
  beats: number;
  cast: number;
  coverBackground: string | null;
}

/** HTTP 412: the stored project changed since it was loaded. */
export class ConflictError extends Error {}

const etagOf = (res: Response) => (res.headers.get('etag') ?? '').replaceAll('"', '');

async function failure(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  const msg = `${what}：${body?.error ?? `HTTP ${res.status}`}`;
  return res.status === 412 ? new ConflictError(msg) : new Error(msg);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const res = await fetch('/api/projects');
  if (!res.ok) throw await failure(res, '读取项目列表失败');
  return (await res.json()) as ProjectSummary[];
}

export async function loadProject(id: string): Promise<{ project: Project; etag: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new Error(`项目 “${id}” 不存在`);
  if (!res.ok) throw await failure(res, `打开项目 “${id}” 失败`);
  return { project: (await res.json()) as Project, etag: etagOf(res) };
}

export async function createProject(project: Project): Promise<{ project: Project; etag: string }> {
  const res = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project) });
  if (!res.ok) throw await failure(res, '创建项目失败');
  return { project: (await res.json()) as Project, etag: etagOf(res) };
}

export async function saveProject(project: Project, etag: string): Promise<{ project: Project; etag: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': `"${etag}"` },
    body: JSON.stringify(project),
  });
  if (!res.ok) throw await failure(res, '保存失败');
  return { project: (await res.json()) as Project, etag: etagOf(res) };
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res, '删除失败');
}
