/**
 * Cubism Core heap bookkeeping (pure, unit-tested).
 *
 * The Core keeps every model's parameter / vertex arrays in one wasm heap. When a model is loaded and the heap has to grow, the
 * heap is re-allocated: models created before that keep typed-array views on the OLD heap. Their JS side keeps running (motions,
 * parameters) but the Core no longer sees the writes, so the rendered output freezes. The cure is to load enough heap up front
 * (`cubismMemoryMB`) and, as a safety net, to rebuild any model whose heap view differs from the newest model's.
 */

/** Heap handed to the Cubism Core before the first model is created. Core reports about twice this value once allocated. */
export const DEFAULT_CUBISM_MEMORY_MB = 256;
export const MIN_CUBISM_MEMORY_MB = 64;
export const MAX_CUBISM_MEMORY_MB = 1024;

/** Clamp a configured value into the supported range; anything that is not a finite number falls back to the default. */
export function clampCubismMemoryMB(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_CUBISM_MEMORY_MB;
  return Math.min(MAX_CUBISM_MEMORY_MB, Math.max(MIN_CUBISM_MEMORY_MB, Math.round(n)));
}

export interface HeapEntry {
  id: string;
  /** Creation order: the larger, the newer. */
  seq: number;
  /** The heap view the model was created on (identity is what matters). */
  token: unknown;
}

/** Ids whose heap view is not the newest model's, i.e. whose output is frozen. A model without a token is never reported. */
export function staleModelIds(entries: readonly HeapEntry[]): string[] {
  let newest: HeapEntry | null = null;
  for (const e of entries) if (e.token != null && (!newest || e.seq > newest.seq)) newest = e;
  if (!newest) return [];
  return entries.filter((e) => e.token != null && e.token !== newest!.token).map((e) => e.id);
}
