/**
 * Undo / redo on Immer patches. Every edit is `recipe(draft)`; the patches and their inverses are stored, so
 * undo/redo never copies whole documents. Consecutive edits that share a `coalesce` key (a slider drag, typing in
 * one field) merge into a single step until another kind of edit, an undo, or `seal()` ends the group.
 */
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from 'immer';

enablePatches();

export interface Step {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  coalesce?: string;
}

export interface EditOptions {
  coalesce?: string;
}

export class History<S extends Record<string, unknown>> {
  private undoStack: Step[] = [];
  private redoStack: Step[] = [];
  private open = false;

  constructor(private readonly limit = 200) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }
  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  /** Apply an edit; returns the new state (the same object when the recipe changed nothing). */
  apply(state: S, recipe: (draft: Draft<S>) => void, label: string, opts: EditOptions = {}, guard?: (prev: S, next: S) => boolean): S {
    const [next, patches, inverse] = produceWithPatches(state, recipe);
    if (patches.length === 0) return state;
    if (guard && !guard(state, next)) return state;
    const top = this.undoStack.at(-1);
    if (this.open && opts.coalesce && top?.coalesce === opts.coalesce) {
      top.patches.push(...patches);
      top.inverse.unshift(...inverse);
    } else {
      this.undoStack.push({ label, patches, inverse, ...(opts.coalesce ? { coalesce: opts.coalesce } : {}) });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.open = !!opts.coalesce;
    this.redoStack = [];
    return next;
  }

  /** End the current coalescing group (e.g. on pointer-up / blur). */
  seal(): void {
    this.open = false;
  }

  undo(state: S): S {
    const step = this.undoStack.pop();
    if (!step) return state;
    this.open = false;
    this.redoStack.push(step);
    return applyPatches(state, step.inverse);
  }

  redo(state: S): S {
    const step = this.redoStack.pop();
    if (!step) return state;
    this.open = false;
    this.undoStack.push(step);
    return applyPatches(state, step.patches);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.open = false;
  }
}
