/** Client of `/api/memories` (the assistant's long-term memory) and a small store for the memory manager, the memory cards and the director dialogs. */
import { create } from 'zustand';
import type { Memory, MemoryInput, MemoryPatch } from '@shared/agent/memory';
import { notify } from './store/uiStore';

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const j = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !j) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
  return j;
}

export const fetchMemories = (projectId: string | null) => call<{ enabled: boolean; memories: Memory[] }>(`/api/memories${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
export const createMemory = (m: MemoryInput) => call<{ memory: Memory }>('/api/memories', { method: 'POST', body: JSON.stringify(m) });
export const patchMemory = (id: string, p: MemoryPatch) => call<{ memory: Memory }>(`/api/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(p) });
export const setMemoryEnabled = (on: boolean) => call<{ enabled: boolean }>('/api/memories-enabled', { method: 'PUT', body: JSON.stringify({ on }) });
export const deleteMemory = (id: string) => call<{ memory: Memory }>(`/api/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });

interface MemoryState {
  /** The project the list was loaded for (null = only global memories are relevant). */
  projectId: string | null;
  /** Global memories + the ones of `projectId` (also the switched-off ones). */
  memories: Memory[];
  /** The global switch of the experimental memory system. */
  enabled: boolean;
  loaded: boolean;
  setEnabled(on: boolean): Promise<void>;
  load(projectId: string | null): Promise<void>;
  add(m: MemoryInput): Promise<Memory | null>;
  patch(id: string, p: MemoryPatch): Promise<void>;
  remove(id: string): Promise<void>;
}

const fail = (e: unknown) => notify(`记忆操作失败：${(e as Error).message}`, 'warn');

export const useMemories = create<MemoryState>((set, get) => ({
  projectId: null,
  memories: [],
  enabled: true,
  loaded: false,
  async setEnabled(on) {
    try { const r = await setMemoryEnabled(on); set({ enabled: r.enabled }); } catch (e) { fail(e); }
  },
  async load(projectId) {
    set({ projectId });
    try {
      const r = await fetchMemories(projectId);
      if (get().projectId === projectId) set({ enabled: r.enabled, memories: projectId ? r.memories : r.memories.filter((m) => m.scope === 'global'), loaded: true });
    } catch { set({ loaded: true }); }
  },
  async add(m) {
    try {
      const r = await createMemory(m);
      await get().load(get().projectId);
      return r.memory;
    } catch (e) { fail(e); return null; }
  },
  async patch(id, p) {
    try { await patchMemory(id, p); await get().load(get().projectId); } catch (e) { fail(e); }
  },
  async remove(id) {
    try { await deleteMemory(id); await get().load(get().projectId); } catch (e) { fail(e); }
  },
}));
