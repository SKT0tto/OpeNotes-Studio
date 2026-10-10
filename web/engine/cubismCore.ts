/**
 * Loads Live2D Cubism Core (proprietary; never committed) from the configured URL — by default the
 * official CDN, or a local copy served from `vendor/` — and verifies it understands moc3 v5.
 */
interface CubismCoreGlobal {
  Version: { csmGetLatestMocVersion(): number; csmGetVersion(): number };
}
const w = window as unknown as { Live2DCubismCore?: CubismCoreGlobal };

export const REQUIRED_MOC_VERSION = 5;
let loading: Promise<void> | null = null;

export class CubismCoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'CubismCoreError';
  }
}

function inject(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(
        new CubismCoreError(
          `无法加载 Live2D Cubism Core（${url}）。请检查网络，或下载官方 live2dcubismcore.min.js 放到 vendor/ 并设置 CUBISM_CORE_URL（见 README）。`,
        ),
      );
    };
    document.head.appendChild(s);
  });
}

export function loadCubismCore(url: string): Promise<void> {
  loading ??= (async () => {
    if (!w.Live2DCubismCore) await inject(url);
    const core = w.Live2DCubismCore;
    if (!core) throw new CubismCoreError(`脚本已加载但未找到 Live2DCubismCore 全局对象（${url}）。`);
    const moc = core.Version.csmGetLatestMocVersion();
    if (moc < REQUIRED_MOC_VERSION) {
      throw new CubismCoreError(`Cubism Core 太旧（支持 moc3 v${moc}），素材为 moc3 v5，需要 Core 5.x（${url}）。`);
    }
  })();
  loading.catch(() => (loading = null)); // allow retry after a failure
  return loading;
}
