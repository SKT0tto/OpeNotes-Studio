import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_ASSET_ROOT = './assets';
export const DEFAULT_CUBISM_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
export const DEFAULT_PORT = 5274;

export interface StudioConfig {
  /** Read-only external asset library. Never written to. */
  assetRoot: string;
  audioRoots: string[];
  cubismCoreUrl: string;
  port: number;
  /** Writable runtime data (index cache, projects, ...). */
  dataDir: string;
  /** studio.config.json (written by the setup wizard: asset root, Core URL). */
  configFile: string;
  /** Gitignored folder for a local Cubism Core copy. */
  vendorDir: string;
  /** Upper bound for an imported zip (uncompressed) in bytes. */
  importMaxBytes: number;
}

/** Shape of studio.config.json (all optional). */
export interface FileConfig {
  assetRoot?: string;
  audioRoots?: string[];
  cubismCoreUrl?: string;
  port?: number;
  dataDir?: string;
  importMaxBytes?: number;
}

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined): string | undefined => (v && v.trim() !== '' ? v.trim() : undefined);

/** Environment variables win over the config file, which wins over defaults. */
export function resolveConfig(env: Env, file: FileConfig = {}, cwd: string = process.cwd()): StudioConfig {
  const audioEnv = nonEmpty(env.AUDIO_ROOTS);
  const audioRoots = audioEnv
    ? audioEnv.split(';').map((s) => s.trim()).filter(Boolean)
    : (file.audioRoots ?? []).filter((s) => s.trim() !== '');
  const portRaw = nonEmpty(env.API_PORT) ?? (file.port !== undefined ? String(file.port) : undefined);
  const port = portRaw !== undefined ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid API_PORT: ${portRaw}`);
  return {
    assetRoot: path.resolve(nonEmpty(env.ASSET_ROOT) ?? file.assetRoot ?? DEFAULT_ASSET_ROOT),
    audioRoots: audioRoots.map((p) => path.resolve(p)),
    cubismCoreUrl: nonEmpty(env.CUBISM_CORE_URL) ?? file.cubismCoreUrl ?? DEFAULT_CUBISM_CORE_URL,
    port,
    dataDir: path.resolve(cwd, nonEmpty(env.DATA_DIR) ?? file.dataDir ?? 'data'),
    configFile: path.resolve(cwd, nonEmpty(env.STUDIO_CONFIG_FILE) ?? 'studio.config.json'),
    vendorDir: path.resolve(cwd, nonEmpty(env.VENDOR_DIR) ?? 'vendor'),
    importMaxBytes: Number(nonEmpty(env.IMPORT_MAX_BYTES) ?? file.importMaxBytes ?? 16 * 1024 ** 3),
  };
}

export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): StudioConfig {
  const file = path.resolve(cwd, nonEmpty(env.STUDIO_CONFIG_FILE) ?? 'studio.config.json');
  let parsed: FileConfig = {};
  if (fs.existsSync(file)) {
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as FileConfig;
    } catch (e) {
      throw new Error(`studio.config.json is not valid JSON: ${(e as Error).message}`, { cause: e });
    }
  }
  return resolveConfig(env, parsed, cwd);
}

/** Merge `patch` into studio.config.json (null removes a key). Atomic write; other keys are kept. */
export function updateFileConfig(file: string, patch: Record<string, unknown>): void {
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    /* new file */
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete cur[k];
    else cur[k] = v;
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cur, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
