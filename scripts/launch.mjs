// Starts the production server (dist/server/index.mjs, which also serves dist/web), waits until it answers and opens the
// browser. Used by Start-Windows.cmd / start.sh of the release package; plain Node, no dependencies.
//
//   node scripts/launch.mjs                 run the server in the foreground (Ctrl+C / closing the window stops it)
//   node scripts/launch.mjs deps-ok         exit 0 when node_modules matches package-lock.json
//   node scripts/launch.mjs deps-stamp      remember that node_modules matches package-lock.json
// Environment: OPENOTES_NO_BROWSER=1 does not open the browser; API_PORT / studio.config.json "port" choose the port.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const stampFile = path.join('node_modules', '.openotes-lock');
const lockHash = () => crypto.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex');

function port() {
  const fromEnv = (process.env.API_PORT ?? '').trim();
  if (fromEnv) return Number(fromEnv);
  try {
    const file = JSON.parse(fs.readFileSync(path.resolve(process.env.STUDIO_CONFIG_FILE?.trim() || 'studio.config.json'), 'utf8'));
    if (Number.isInteger(file.port)) return file.port;
  } catch {
    /* no config file */
  }
  return 5274;
}

async function healthy(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json()).ok === true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  if (process.env.OPENOTES_NO_BROWSER === '1') return;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    c.on('error', () => console.log(`请手动在浏览器中打开：${url}`));
    c.unref();
  } catch {
    console.log(`请手动在浏览器中打开：${url}`);
  }
}

const sub = process.argv[2];
if (sub === 'deps-ok') {
  let ok = false;
  try {
    ok = fs.existsSync(path.join('node_modules', 'express')) && fs.readFileSync(stampFile, 'utf8').trim() === lockHash();
  } catch {
    /* no stamp */
  }
  process.exit(ok ? 0 : 1);
} else if (sub === 'deps-stamp') {
  fs.writeFileSync(stampFile, `${lockHash()}\n`);
  process.exit(0);
}

if (!fs.existsSync(path.join('dist', 'server', 'index.mjs'))) {
  console.error('找不到 dist/server/index.mjs。请从 GitHub Releases 下载完整的发布包；开发者请先运行 npm run build。');
  process.exit(1);
}

const url = `http://127.0.0.1:${port()}`;
if (await healthy(url)) {
  console.log(`OpeNotes Studio 已在 ${url} 运行，直接打开浏览器。`);
  openBrowser(url);
} else {
  console.log(`正在启动 OpeNotes Studio（${url}）。关闭此窗口或按 Ctrl+C 即可停止。`);
  const child = spawn(process.execPath, [path.join('dist', 'server', 'index.mjs')], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
  const stop = () => child.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => {
    process.exitCode = code ?? 0; // the loop below ends, nothing else keeps the process alive
  });

  for (let i = 0; i < 120 && child.exitCode === null; i++) {
    if (await healthy(url)) {
      console.log(`\n已就绪：${url}`);
      openBrowser(url);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
