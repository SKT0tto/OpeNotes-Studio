// Downloads the Live2D Cubism Core from Live2D's official address into vendor/ (cross-platform; used by the start scripts
// of the release package, plain Node, no dependencies). It does what the setup wizard's 'save a local copy' does:
// vendor/live2dcubismcore.min.js, studio.config.json { cubismCoreUrl: '/vendor/...' } and the licence confirmation in
// data/setup.local.json.
//
//   node scripts/fetch-core.mjs            ask first (interactive terminal), skip when there is no terminal
//   node scripts/fetch-core.mjs --yes      the licence is accepted, download without asking
//   node scripts/fetch-core.mjs --no-core  skip (the web wizard asks again)
// Environment: OPENOTES_CORE=yes|no does the same as --yes / --no-core.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

export const OFFICIAL_CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';
export const LICENSE_URL = 'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_cn.html';
export const LOCAL_CORE_URL = '/vendor/live2dcubismcore.min.js';
const CORE_FILE = 'live2dcubismcore.min.js';
const MAX_CORE_BYTES = 2 * 1024 * 1024;
const REPO_URL = 'https://github.com/SKT0tto/OpeNotes-Studio';

/** Same checks as the server (server/setup/routes.ts validateCoreFile). Returns an error text or null. */
export function validateCoreFile(buf) {
  if (buf.length === 0 || buf.length > MAX_CORE_BYTES) return `unreasonable file size (${buf.length} bytes)`;
  const text = buf.toString('latin1');
  if (!/Live2D Cubism Core/i.test(text)) return 'not a Live2D Cubism Core (no "Live2D Cubism Core" notice)';
  if (!text.includes('csmGetLatestMocVersion')) return 'not a Live2D Cubism Core (no csmGetLatestMocVersion)';
  return null;
}

const nonEmpty = (v) => (v && v.trim() !== '' ? v.trim() : undefined);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** Paths exactly as the server resolves them (env wins over studio.config.json, relative to `cwd`). */
export function resolvePaths(env, cwd) {
  const configFile = path.resolve(cwd, nonEmpty(env.STUDIO_CONFIG_FILE) ?? 'studio.config.json');
  const file = readJson(configFile);
  const dataDir = path.resolve(cwd, nonEmpty(env.DATA_DIR) ?? file.dataDir ?? 'data');
  return {
    configFile,
    vendorFile: path.join(path.resolve(cwd, nonEmpty(env.VENDOR_DIR) ?? 'vendor'), CORE_FILE),
    setupFile: path.resolve(nonEmpty(env.SETUP_FILE) ?? path.join(dataDir, 'setup.local.json')),
  };
}

export function hasLocalCore(paths) {
  try {
    return validateCoreFile(fs.readFileSync(paths.vendorFile)) === null;
  } catch {
    return false;
  }
}

/** Records the licence confirmation, downloads the Core from the official address and activates it. Returns true on success. */
export async function installCore(paths, { fetchImpl = fetch, log = console.log, now = () => new Date() } = {}) {
  const setup = readJson(paths.setupFile);
  if (!setup.coreLicenseAcceptedAt) writeJson(paths.setupFile, { ...setup, coreLicenseAcceptedAt: now().toISOString() });
  try {
    log('正在从 Live2D 官方地址下载 Cubism Core ...');
    const resp = await fetchImpl(OFFICIAL_CORE_URL, { headers: { 'user-agent': `OpeNotesStudio (+${REPO_URL})` }, signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const bad = validateCoreFile(buf);
    if (bad) throw new Error(bad);
    fs.mkdirSync(path.dirname(paths.vendorFile), { recursive: true });
    const tmp = `${paths.vendorFile}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, paths.vendorFile);
    writeJson(paths.configFile, { ...readJson(paths.configFile), cubismCoreUrl: LOCAL_CORE_URL });
    log(`已保存到 ${paths.vendorFile}（${buf.length} 字节）。`);
    return true;
  } catch (e) {
    log(`下载失败：${e.message}。可稍后在网页的「配置向导」里重试，或从 Live2D 官网下载 Cubism SDK for Web 后选择其中的 live2dcubismcore.min.js。`);
    return false;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.on('close', () => resolve('')); // end of input without an answer (a no-op once resolved)
    rl.question(question, (answer) => {
      resolve(answer);
      rl.close();
    });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const paths = resolvePaths(env, cwd);
  if (hasLocalCore(paths)) return 0; // already there; nothing to ask
  let decision = argv.includes('--yes') ? 'yes' : argv.includes('--no-core') ? 'no' : nonEmpty(env.OPENOTES_CORE)?.toLowerCase();
  if (decision !== 'yes' && decision !== 'no') {
    if (!process.stdin.isTTY) {
      console.log('未检测到 Live2D Cubism Core；非交互环境，已跳过。打开网页后在「配置向导」里获取。');
      return 0;
    }
    console.log('');
    const answer = (await ask(`需要 Live2D Cubism Core 才能显示 Live2D 模型。它由 Live2D Inc. 提供，适用《Live2D 专有软件许可协议》：${LICENSE_URL}\n是否同意协议并从 Live2D 官方下载？[Y/n] `)).trim().toLowerCase();
    decision = answer === '' || answer === 'y' || answer === 'yes' || answer === '是' ? 'yes' : 'no';
  }
  if (decision === 'no') {
    console.log('已跳过。打开网页后，「配置向导」会再次提示获取 Cubism Core。');
    return 0;
  }
  await installCore(paths);
  return 0; // a failed download is not fatal: the wizard can retry
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(); // not process.exit(): exiting with a fetch still winding down trips a libuv assertion on Windows
}
