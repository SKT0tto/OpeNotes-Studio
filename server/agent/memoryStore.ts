/**
 * The assistant's memory on disk: one JSON file under dataDir (gitignored), validated with zod, written atomically (tmp file + rename),
 * one write at a time. A missing file is an empty store; a broken file is kept aside (`.broken-<time>`) instead of being overwritten silently.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MEMORY_MAX, MemoryFileSchema, MemoryInputSchema, MemoryPatchSchema, MemorySchema, directorMemories, directorPreferences, emptyMemoryFile,
  type Memory, type MemoryFile, type MemoryInput, type MemoryPatch,
} from '../../shared/agent/memory';
import { readTextRetry, renameRetry } from '../util/fsRetry';

export class MemoryError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** What the agent loop and the director need (an in-memory one is used by the tests). */
export interface MemoryBackend {
  read(): Promise<MemoryFile>;
  add(input: MemoryInput): Promise<Memory>;
  update(id: string, patch: MemoryPatch): Promise<Memory>;
  remove(id: string): Promise<Memory>;
}

const newId = () => `m_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

/** Pure mutations shared by the file store and the in-memory store. */
function addTo(file: MemoryFile, raw: MemoryInput, now: number): Memory {
  const input = MemoryInputSchema.parse(raw);
  if (file.memories.length >= MEMORY_MAX) throw new MemoryError(409, `记忆最多 ${MEMORY_MAX} 条`);
  // the same sentence in the same place is not stored twice (switched back on instead)
  const same = file.memories.find((m) => m.text === input.text && m.scope === input.scope && (m.projectId ?? null) === (input.scope === 'project' ? input.projectId ?? null : null) && (m.castId ?? null) === (input.castId ?? null));
  if (same) {
    same.enabled = true;
    same.updatedAt = now;
    return same;
  }
  const m = MemorySchema.safeParse({
    id: newId(), text: input.text, scope: input.scope, kind: input.kind ?? 'other', enabled: input.enabled ?? true, origin: input.origin ?? 'manual', createdAt: now, updatedAt: now,
    ...(input.scope === 'project' ? { projectId: input.projectId, ...(input.castId ? { castId: input.castId, ...(input.castName ? { castName: input.castName } : {}) } : {}) } : {}),
  });
  if (!m.success) throw new MemoryError(400, m.error.issues[0]?.message ?? '记忆格式不对');
  file.memories.push(m.data);
  return m.data;
}

function updateIn(file: MemoryFile, id: string, raw: MemoryPatch, now: number): Memory {
  const patch = MemoryPatchSchema.parse(raw);
  const i = file.memories.findIndex((m) => m.id === id);
  if (i < 0) throw new MemoryError(404, `没有这条记忆：${id}`);
  const cur = file.memories[i]!;
  const scope = patch.scope ?? cur.scope;
  const next: Record<string, unknown> = { ...cur, ...(patch.text !== undefined ? { text: patch.text } : {}), ...(patch.kind ? { kind: patch.kind } : {}), ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), scope, updatedAt: now };
  if (scope === 'global') { delete next.projectId; delete next.castId; delete next.castName; } else {
    if (patch.projectId) next.projectId = patch.projectId;
    if (patch.castId === null) { delete next.castId; delete next.castName; } else if (patch.castId) next.castId = patch.castId;
    if (patch.castName === null) delete next.castName; else if (patch.castName) next.castName = patch.castName;
  }
  const m = MemorySchema.safeParse(next);
  if (!m.success) throw new MemoryError(400, m.error.issues[0]?.message ?? '记忆格式不对');
  file.memories[i] = m.data;
  return m.data;
}

function removeFrom(file: MemoryFile, id: string): Memory {
  const i = file.memories.findIndex((m) => m.id === id);
  if (i < 0) throw new MemoryError(404, `没有这条记忆：${id}`);
  return file.memories.splice(i, 1)[0]!;
}

export class MemoryStore implements MemoryBackend {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string, private readonly now: () => number = Date.now) {}

  async read(): Promise<MemoryFile> {
    let text: string;
    try {
      text = await readTextRetry(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyMemoryFile();
      throw e;
    }
    let json: unknown;
    try { json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { json = null; }
    const p = MemoryFileSchema.safeParse(json);
    if (p.success) return p.data;
    // keep the unreadable file for the user instead of overwriting it with an empty store on the next write
    await fs.rename(this.file, `${this.file}.broken-${this.now()}`).catch(() => {});
    return emptyMemoryFile();
  }

  private async write(file: MemoryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(MemoryFileSchema.parse(file), null, 1)}\n`, 'utf8');
    await renameRetry(tmp, this.file);
  }

  /** Read-modify-write, one at a time. */
  private mutate<T>(f: (file: MemoryFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const file = await this.read();
      const out = f(file);
      await this.write(file);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  add(input: MemoryInput): Promise<Memory> { return this.mutate((f) => addTo(f, input, this.now())); }
  update(id: string, patch: MemoryPatch): Promise<Memory> { return this.mutate((f) => updateIn(f, id, patch, this.now())); }
  remove(id: string): Promise<Memory> { return this.mutate((f) => removeFrom(f, id)); }
  setEnabled(on: boolean): Promise<boolean> { return this.mutate((f) => (f.enabled = on)); }
}

/** A store that lives in memory (tests, evaluation runs). */
export class InMemoryMemories implements MemoryBackend {
  file: MemoryFile;
  constructor(init: Partial<MemoryFile> = {}, private readonly now: () => number = Date.now) {
    this.file = { ...emptyMemoryFile(), ...init };
  }
  async read(): Promise<MemoryFile> { return structuredClone(this.file); }
  async add(input: MemoryInput): Promise<Memory> { return structuredClone(addTo(this.file, input, this.now())); }
  async update(id: string, patch: MemoryPatch): Promise<Memory> { return structuredClone(updateIn(this.file, id, patch, this.now())); }
  async remove(id: string): Promise<Memory> { return removeFrom(this.file, id); }
}

/** The memory store when the memory system is switched on (null when it is off or unreadable): what the agent turn gets. */
export async function memoryIfOn(memory: MemoryBackend | undefined): Promise<MemoryBackend | undefined> {
  if (!memory) return undefined;
  const f = await memory.read().catch(() => null);
  return f?.enabled ? memory : undefined;
}

/** The director's view of the memory: the active memories of a project as scene-input preferences, or null (none / switched off / unreadable). */
export async function directorPreferencesFor(memory: MemoryBackend | undefined, projectId: string): Promise<{ note: string; items: string[] } | null> {
  if (!memory) return null;
  const f = await memory.read().catch(() => null);
  return f?.enabled ? directorPreferences(directorMemories(f.memories, projectId)) : null;
}
