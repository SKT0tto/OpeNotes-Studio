/**
 * Project storage: data/projects/<id>/project.json, the previous version of every overwritten file is kept in
 * history/ (newest MAX_HISTORY). Optimistic concurrency: a version is the hash of the stored file (ETag).
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import { readTextRetry, renameRetry } from '../util/fsRetry';

export const MAX_HISTORY = 20;
export const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class StoreError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 412,
    message: string,
  ) {
    super(message);
  }
}

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: number;
  scenes: number;
  beats: number;
  cast: number;
  /** Background of the first scene (the project card's picture). */
  coverBackground: string | null;
  etag: string;
}
export interface StoredProject {
  project: Project;
  etag: string;
}

const etagOf = (text: string) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

export class ProjectStore {
  private seq = 0;

  constructor(private readonly root: string) {}

  private dir(id: string): string {
    if (!PROJECT_ID.test(id)) throw new StoreError(400, `invalid project id "${id}"`);
    return path.join(this.root, id);
  }

  private async read(id: string): Promise<{ text: string; project: Project } | null> {
    let text: string;
    try {
      text = await readTextRetry(path.join(this.dir(id), 'project.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    return { text, project: ProjectSchema.parse(JSON.parse(text)) };
  }

  async list(): Promise<ProjectSummary[]> {
    const names = await fs.readdir(this.root).catch(() => [] as string[]);
    const out: ProjectSummary[] = [];
    for (const id of names) {
      if (!PROJECT_ID.test(id)) continue;
      const r = await this.read(id).catch(() => null);
      if (r) out.push({ id, title: r.project.title, updatedAt: r.project.updatedAt, scenes: r.project.scenes.length, beats: r.project.scenes.reduce((n, sc) => n + sc.beats.length, 0), cast: r.project.cast.length, coverBackground: r.project.scenes[0]?.background.assetId ?? null, etag: etagOf(r.text) });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Every readable project (unreadable / invalid ones are skipped). */
  async all(): Promise<Project[]> {
    const names = await fs.readdir(this.root).catch(() => [] as string[]);
    const out: Project[] = [];
    for (const id of names) {
      if (!PROJECT_ID.test(id)) continue;
      const r = await this.read(id).catch(() => null);
      if (r) out.push(r.project);
    }
    return out;
  }

  async get(id: string): Promise<StoredProject> {
    const r = await this.read(id);
    if (!r) throw new StoreError(404, `project "${id}" does not exist`);
    return { project: r.project, etag: etagOf(r.text) };
  }

  private async write(project: Project): Promise<StoredProject> {
    const text = `${JSON.stringify(project, null, 1)}\n`;
    const dir = this.dir(project.id);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.project.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    await fs.writeFile(tmp, text, 'utf8');
    await renameRetry(tmp, path.join(dir, 'project.json'));
    return { project, etag: etagOf(text) };
  }

  /** Create; fails with 409 when the id is taken. */
  async create(input: unknown): Promise<StoredProject> {
    const project = parse(input);
    if (await this.read(project.id)) throw new StoreError(409, `project "${project.id}" already exists`);
    return this.write(project);
  }

  /** Overwrite; `ifMatch` must be the etag the client last saw (412 otherwise). Backs up the previous version. */
  async save(id: string, input: unknown, ifMatch: string | undefined): Promise<StoredProject> {
    const project = parse(input);
    if (project.id !== id) throw new StoreError(400, `body id "${project.id}" does not match "${id}"`);
    const cur = await this.read(id);
    if (!cur) throw new StoreError(404, `project "${id}" does not exist`);
    if (!ifMatch) throw new StoreError(412, 'If-Match header is required');
    if (etagOf(cur.text) !== ifMatch.replaceAll('"', '')) throw new StoreError(412, 'the project changed on disk since it was loaded');
    const hist = path.join(this.dir(id), 'history');
    await fs.mkdir(hist, { recursive: true });
    const stamp = `${Date.now().toString().padStart(14, '0')}-${String(this.seq++ % 1000).padStart(3, '0')}`;
    await fs.writeFile(path.join(hist, `${stamp}.json`), cur.text, 'utf8');
    const old = (await fs.readdir(hist)).filter((f) => f.endsWith('.json')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - MAX_HISTORY))) await fs.rm(path.join(hist, f), { force: true });
    return this.write(project);
  }

  async remove(id: string): Promise<void> {
    if (!(await this.read(id))) throw new StoreError(404, `project "${id}" does not exist`);
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  async history(id: string): Promise<string[]> {
    return (await fs.readdir(path.join(this.dir(id), 'history')).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  }
}

function parse(input: unknown): Project {
  const r = ProjectSchema.safeParse(input);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new StoreError(400, `invalid project: ${i ? `${i.path.join('.')} ${i.message}` : 'schema mismatch'}`);
  }
  if (!PROJECT_ID.test(r.data.id)) throw new StoreError(400, `invalid project id "${r.data.id}"`);
  return r.data;
}
