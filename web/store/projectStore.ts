/**
 * The open project. Every change goes through `applyEdit(recipe, label)` (Immer patches -> undo / redo);
 * the preview, inspector and timeline strip all read `project` from here.
 */
import type { Draft } from 'immer';
import { create } from 'zustand';
import type { Meta, Project } from '@shared/schema/project';
import { ConflictError, createProject, saveProject } from '../projectsApi';
import { describeViolations, findLockViolations, getByPath, type Seg } from '@shared/project/locks';
import { History, type EditOptions } from './history';
import { notify, useUi } from './uiStore';

export interface Selection {
  sceneId: string | null;
  beatId: string | null;
  /** The person selected on stage / in the timeline (actor tab of the inspector). */
  castId: string | null;
}
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface ProjectState {
  project: Project | null;
  /** Version of the stored file this project was loaded from / last saved as; null = never stored. */
  etag: string | null;
  saved: Project | null;
  saveState: SaveState;
  saveError: string | null;
  selection: Selection;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  open(project: Project, etag: string | null): void;
  close(): void;
  /** False when a lock refused the edit (nothing changed, the user was told). */
  applyEdit(recipe: (draft: Draft<Project>) => void, label: string, opts?: EditOptions): boolean;
  seal(): void;
  undo(): void;
  redo(): void;
  select(sel: Partial<Selection>): void;
  save(): Promise<boolean>;
}

const history = new History<Project>();

/** Mark a unit as touched by the user (PLAN 1.1): source becomes `user`, a lock is left as it is. */
export const touch = (meta: Meta): void => {
  meta.source = 'user';
  meta.updatedAt = Date.now();
};

/** Unlock the units at these paths (always allowed); used by the "解锁" button of a refused-edit toast. */
function unlockPaths(paths: Seg[][]): void {
  useProject.getState().applyEdit((d) => {
    for (const p of paths) {
      const u = getByPath(d, p) as { meta?: Meta } | undefined;
      if (u?.meta) u.meta.locked = false;
    }
  }, '解锁');
}

const flags = () => ({ canUndo: history.canUndo, canRedo: history.canRedo, undoLabel: history.undoLabel, redoLabel: history.redoLabel });

export const useProject = create<ProjectState>((set, get) => ({
  project: null,
  etag: null,
  saved: null,
  saveState: 'saved',
  saveError: null,
  selection: { sceneId: null, beatId: null, castId: null },
  ...flags(),

  open(project, etag) {
    history.clear();
    const scene = project.scenes[0];
    set({ project, etag, saved: etag ? project : null, saveState: etag ? 'saved' : 'dirty', saveError: null, selection: { sceneId: scene?.id ?? null, beatId: scene?.beats[0]?.id ?? null, castId: null }, ...flags() });
  },

  close() {
    history.clear();
    set({ project: null, etag: null, saved: null, saveState: 'saved', saveError: null, selection: { sceneId: null, beatId: null, castId: null }, ...flags() });
  },

  applyEdit(recipe, label, opts) {
    const cur = get().project;
    if (!cur) return false;
    let blocked = false;
    // The single lock gate: whatever the recipe does, it may not change or remove a locked unit (shared/project/locks.ts).
    const guard = (prev: Project, nxt: Project): boolean => {
      const vs = findLockViolations(prev, nxt);
      if (vs.length === 0) return true;
      notify(describeViolations(vs), 'warn', { label: '解锁', run: () => unlockPaths(vs.map((v) => v.path)) });
      blocked = true;
      return false;
    };
    const next = history.apply(cur, (d) => {
      recipe(d);
    }, label, opts, guard);
    if (blocked) return false;
    if (next === cur) return true;
    set({ project: next, saveState: 'dirty', ...flags() });
    if (useUi.getState().toast) useUi.getState().set({ toast: null });
    return true;
  },

  seal: () => history.seal(),

  undo() {
    const cur = get().project;
    if (!cur) return;
    set({ project: history.undo(cur), saveState: 'dirty', ...flags() });
  },

  redo() {
    const cur = get().project;
    if (!cur) return;
    set({ project: history.redo(cur), saveState: 'dirty', ...flags() });
  },

  select: (sel) => set((s) => ({ selection: { ...s.selection, ...sel } })),

  async save() {
    const { project, etag } = get();
    if (!project) return false;
    set({ saveState: 'saving', saveError: null });
    const toSave = { ...project, updatedAt: Date.now() };
    try {
      const r = etag ? await saveProject(toSave, etag) : await createProject(toSave);
      history.seal();
      set({ etag: r.etag, saved: r.project, saveState: get().project === project ? 'saved' : 'dirty' });
      return true;
    } catch (e) {
      set({ saveState: 'error', saveError: e instanceof ConflictError ? `${e.message}。请“另存为副本”或重新打开。` : (e as Error).message });
      return false;
    }
  },
}));
