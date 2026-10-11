/** One-time engine bootstrap. Order matters: Core -> configure -> plugin -> models. */
import { extensions } from 'pixi.js';
import { clampCubismMemoryMB } from '@shared/cubismHeap';
import { loadCubismCore } from './cubismCore';

type CubismModule = typeof import('untitled-pixi-live2d-engine/cubism');
let mod: Promise<CubismModule> | null = null;

/**
 * Load Cubism Core, then (and only then) import and initialise the Live2D engine.
 *
 * `memoryMB` (studio.config.json `cubismMemoryMB` / env CUBISM_MEMORY_MB, delivered by /api/health) sizes the Core heap. It only takes
 * effect on the FIRST call, before any model exists: the Core re-allocates its heap when it runs out, and models created earlier
 * would then render frozen (see shared/cubismHeap). Every entry point (play page, stage lab, actor lab) passes it on its first call.
 */
export function ensureRuntime(coreUrl: string, memoryMB?: number): Promise<CubismModule> {
  mod ??= (async () => {
    await loadCubismCore(coreUrl);
    const m = await import('untitled-pixi-live2d-engine/cubism');
    // Dev builds only: tests force a tiny heap to prove the re-allocation guard (the configured value is never below 64).
    const forced = import.meta.env.DEV ? (globalThis as { __cubismMemoryMB?: number }).__cubismMemoryMB : undefined;
    m.configureCubismSDK({ memorySizeMB: forced ?? clampCubismMemoryMB(memoryMB) });
    extensions.add(m.Live2DPlugin);
    return m;
  })();
  mod.catch(() => (mod = null));
  return mod;
}
