/** Per-line voice files of a project: `data/projects/<id>/voice/<name>`. Core feature (hand-recorded or plugin-made audio plays the same). */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { PROJECT_ID } from '../projects/store';

/** A plain audio file name: no path parts, a known extension. */
export const VOICE_FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(wav|mp3|ogg|flac)$/;
export const safeVoiceName = (name: string): boolean => VOICE_FILE.test(name) && !name.includes('..');

export class VoiceFiles {
  constructor(private readonly projectsDir: string) {}

  dir(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new Error(`invalid project id "${projectId}"`);
    return path.join(this.projectsDir, projectId, 'voice');
  }
  private file(projectId: string, name: string): string {
    if (!safeVoiceName(name)) throw new Error(`invalid voice file name "${name}"`);
    return path.join(this.dir(projectId), name);
  }
  async write(projectId: string, name: string, bytes: Uint8Array): Promise<void> {
    const f = this.file(projectId, name);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    const tmp = path.join(path.dirname(f), `.${name}.${process.pid}.tmp`);
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, f);
  }
  async read(projectId: string, name: string): Promise<Uint8Array | null> {
    try {
      return await fsp.readFile(this.file(projectId, name));
    } catch {
      return null;
    }
  }
  async list(projectId: string): Promise<string[]> {
    return (await fsp.readdir(this.dir(projectId)).catch(() => [] as string[])).filter(safeVoiceName);
  }
  async remove(projectId: string, name: string): Promise<void> {
    await fsp.rm(this.file(projectId, name), { force: true });
  }
}

const TYPES: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac' };

/** `GET /api/projects/:id/voice/:file` */
export function voiceFileRoutes(files: VoiceFiles): Router {
  const r = Router();
  r.get('/api/projects/:id/voice/:file', (req, res, next) => {
    const name = req.params.file;
    if (!safeVoiceName(name)) return void res.status(400).json({ error: '文件名不合法' });
    let full: string;
    try {
      full = path.join(files.dir(req.params.id), name);
    } catch {
      return void res.status(400).json({ error: '项目 id 不合法' });
    }
    if (!fs.existsSync(full)) return void res.status(404).json({ error: '配音文件不存在' });
    res.setHeader('cache-control', 'no-cache');
    res.type(TYPES[name.split('.').pop()!] ?? 'application/octet-stream').sendFile(full, (err) => err && next(err));
  });
  return r;
}
