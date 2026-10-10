/** One-time engine bootstrap. Order matters: Core -> configure -> plugin -> models. */
import { extensions } from 'pixi.js';
import { loadCubismCore } from './cubismCore';

type CubismModule = typeof import('untitled-pixi-live2d-engine/cubism');
let mod: Promise<CubismModule> | null = null;

/** Load Cubism Core, then (and only then) import and initialise the Live2D engine. */
export function ensureRuntime(coreUrl: string): Promise<CubismModule> {
  mod ??= (async () => {
    await loadCubismCore(coreUrl);
    const m = await import('untitled-pixi-live2d-engine/cubism');
    m.configureCubismSDK({ memorySizeMB: 32 });
    extensions.add(m.Live2DPlugin);
    return m;
  })();
  mod.catch(() => (mod = null));
  return mod;
}
