// OpeNotes Studio 自动更新（发布包专用，Node 22+，无 npm 依赖）。
//
//   node scripts/update.mjs [安装目录] [--check] [--yes] [--rollback]
//   （Windows 双击 Update-Windows.cmd；macOS / Linux 运行 bash update.sh）
//
// 流程：定位安装目录 -> 查询 GitHub 最新正式版 -> 下载发布包 -> 逐文件 sha256 比对 -> 只写入有变化的文件。
// 只在发布包自带的路径内增删文件；data/、.env、studio.config.json、node_modules/、vendor/ 和素材库永远不会被碰。
// 被替换或删除的旧文件先备份到 update-backup/<旧版本>-<时间>/，可用 --rollback 还原。
// 离线测试：--from-zip <发布包> [--release-json <release 的 JSON>]。
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const REPO = 'SKT0tto/OpeNotes-Studio';
const BACKUP_DIR = 'update-backup';
/** 发布包管理的目录与顶层文件：只有这些位置里「本地有、新包没有」的文件才会被删除。 */
export const MANAGED_DIRS = ['dist', 'scripts', 'asset-labels', 'examples', 'docs'];
export const MANAGED_FILES = [
  'package.json', 'package-lock.json', 'Start-Windows.cmd', 'start.sh', 'Update-Windows.cmd', 'update.sh',
  'LICENSE', 'NOTICE', 'THIRD_PARTY.md', 'README.md', 'CHANGELOG.md', 'studio.config.example.json', '.env.example',
];
/** 无论如何都不读、不写、不删的位置（第一段，不区分大小写）。 */
const PROTECTED = ['data', '.env', 'studio.config.json', 'node_modules', 'vendor', 'assets', BACKUP_DIR, '.git'];
export const isProtected = (rel) => PROTECTED.includes(rel.split('/')[0].toLowerCase());
const LAST = ['package.json', 'package-lock.json']; // 最后写入：中途失败时版本号仍是旧的，重跑即可

// ---------- 版本比较 ----------
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) throw new Error(`无法识别的版本号：${v}`);
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}
/** semver 比较：a<b 返回 -1，相等 0，a>b 返回 1（预发布版低于同号正式版）。 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---------- zip 读取（stored / deflate，不支持 zip64） ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 校验 zip 条目路径：拒绝绝对路径、盘符、反斜杠、NUL 和 `..`。返回规范化的相对路径（目录以 / 结尾）。 */
export function sanitizeEntryPath(name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`发布包里有不安全的路径：${JSON.stringify(name)}`);
  const parts = name.split('/');
  if (parts.some((p, i) => p === '..' || p === '.' || (p === '' && i < parts.length - 1))) throw new Error(`发布包里有不安全的路径：${JSON.stringify(name)}`);
  return name;
}

/** 解析 zip，返回 [{ name, isDir, mode, size, read() }]；name 已经过 sanitizeEntryPath。 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾）');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) throw new Error('不支持 zip64');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('不支持 zip64');
  if (buf.readUInt16LE(eocd + 4) !== 0 || cdOffset + cdSize > buf.length) throw new Error('zip 文件已损坏或不完整');
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录已损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const next = nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const unixMode = buf.readUInt16LE(p + 5) === 3 ? buf.readUInt32LE(p + 38) >>> 16 : 0;
    const localOff = buf.readUInt32LE(p + 42);
    const name = sanitizeEntryPath(buf.toString('utf8', p + 46, p + 46 + nlen));
    p += 46 + next;
    if (csize === 0xffffffff || usize === 0xffffffff || localOff === 0xffffffff) throw new Error('不支持 zip64');
    if (flags & 1) throw new Error(`不支持加密的 zip 条目：${name}`);
    if ((unixMode & 0xf000) === 0xa000) throw new Error(`发布包里有符号链接：${name}`);
    const isDir = name.endsWith('/');
    if (!isDir && method !== 0 && method !== 8) throw new Error(`不支持的压缩方式 ${method}：${name}`);
    entries.push({
      name, isDir, mode: unixMode & 0o777, size: usize,
      read() {
        if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip 条目已损坏：${name}`);
        const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
        if (start + csize > buf.length) throw new Error(`zip 条目超出文件范围：${name}`);
        const raw = buf.subarray(start, start + csize);
        const out = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
        if (out.length !== usize || crc32(out) !== crc) throw new Error(`zip 条目校验失败：${name}`);
        return out;
      },
    });
  }
  return entries;
}

/** 去掉唯一的顶层目录（OpeNotes-Studio-vX.Y.Z/），返回 Map<相对路径, { read, mode }>。 */
export function packageFiles(entries) {
  const files = new Map();
  let top = null;
  for (const e of entries) {
    const i = e.name.indexOf('/');
    const first = i < 0 ? e.name : e.name.slice(0, i);
    if (i < 0 && !e.isDir) throw new Error(`发布包的文件不在顶层目录里：${e.name}`);
    if (top !== null && first !== top) throw new Error('发布包有多个顶层目录');
    top = first;
    const rel = e.name.slice(i + 1);
    if (e.isDir || rel === '') continue;
    if (isProtected(rel)) throw new Error(`发布包里含有受保护的路径：${rel}`);
    files.set(rel, { read: e.read, mode: e.mode });
  }
  if (!files.size) throw new Error('发布包是空的');
  return files;
}

// ---------- 安装目录 ----------
export function findInstall(dir) {
  const root = path.resolve(dir);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { /* 下面统一报错 */ }
  if (!pkg || pkg.name !== 'openotes-studio' || !fs.existsSync(path.join(root, 'dist', 'server', 'index.mjs'))) {
    throw new Error(`${root} 不是 OpeNotes Studio 发布包的安装目录（需要 package.json 和 dist/server/index.mjs）。`);
  }
  if (fs.existsSync(path.join(root, '.git'))) throw new Error('这是 git 仓库，不能用自动更新。请运行 git pull，然后 npm install && npm run build。');
  return { root, version: String(pkg.version) };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function listManaged(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(path.join(dir, d.name), r);
      else if (d.isFile()) out.push(r);
    }
  };
  for (const d of MANAGED_DIRS) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d), d);
  for (const f of MANAGED_FILES) if (fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile()) out.push(f);
  return out;
}

/** 计算更新计划：add（新文件）/ change（内容不同）/ remove（新包里没有的受管文件）/ same（数量）。 */
export function planUpdate(root, files) {
  const plan = { add: [], change: [], remove: [], same: 0 };
  for (const [rel, f] of files) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) plan.add.push(rel);
    else if (!fs.statSync(abs).isFile() || sha256(fs.readFileSync(abs)) !== sha256(f.read())) plan.change.push(rel);
    else plan.same++;
  }
  for (const rel of listManaged(root)) if (!files.has(rel) && !isProtected(rel)) plan.remove.push(rel);
  for (const k of ['add', 'change', 'remove']) plan[k].sort((a, b) => Number(LAST.includes(a)) - Number(LAST.includes(b)) || a.localeCompare(b));
  return plan;
}

// ---------- 应用、备份、回滚 ----------
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

function writeAtomic(abs, data, mode) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.update-tmp`;
  fs.writeFileSync(tmp, data);
  if (mode & 0o111) fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, abs);
}

/** 把旧文件备份到 update-backup/<旧版本>-<时间>/，再原子写入新文件、删除多余文件。失败会自动还原。返回备份目录。 */
export function applyPlan(root, files, plan, { fromVersion, toVersion }) {
  const backup = path.join(root, BACKUP_DIR, `${fromVersion}-${stamp()}`);
  const manifest = { from: fromVersion, to: toVersion, added: plan.add, changed: plan.change, removed: plan.remove, rolledBack: false };
  for (const rel of [...plan.change, ...plan.remove]) {
    fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(backup, rel));
  }
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
  try {
    for (const rel of [...plan.add, ...plan.change]) writeAtomic(path.join(root, rel), files.get(rel).read(), files.get(rel).mode);
    for (const rel of plan.remove) fs.rmSync(path.join(root, rel), { force: true });
    removeEmptyDirs(root);
  } catch (e) {
    restoreBackup(root, backup);
    throw new Error(`更新中途失败，已自动还原：${e.message}`, { cause: e });
  }
  return backup;
}

function removeEmptyDirs(root) {
  const prune = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) prune(path.join(dir, d.name));
    if (dir !== root && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  };
  for (const d of MANAGED_DIRS) if (fs.existsSync(path.join(root, d))) prune(path.join(root, d));
}

/** 还原一个备份目录：放回被替换/删除的文件，删掉这次新增的文件。 */
export function restoreBackup(root, backup) {
  const m = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  for (const rel of [...m.changed, ...m.removed]) {
    if (isProtected(rel)) continue;
    writeAtomic(path.join(root, rel), fs.readFileSync(path.join(backup, rel)), 0);
    if (rel.endsWith('.sh')) fs.chmodSync(path.join(root, rel), 0o755);
  }
  for (const rel of m.added) if (!isProtected(rel)) fs.rmSync(path.join(root, rel), { force: true });
  removeEmptyDirs(root);
  m.rolledBack = true;
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(m, null, 2));
  return m;
}

/** 还原最近一次尚未回滚的备份；没有则返回 null。 */
export function rollbackLatest(root) {
  const base = path.join(root, BACKUP_DIR);
  if (!fs.existsSync(base)) return null;
  const dirs = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'manifest.json'))).sort().reverse();
  for (const d of dirs) {
    if (JSON.parse(fs.readFileSync(path.join(base, d, 'manifest.json'), 'utf8')).rolledBack) continue;
    return { dir: path.join(base, d), manifest: restoreBackup(root, path.join(base, d)) };
  }
  return null;
}

// ---------- 联网 ----------
export function pickRelease(rel) {
  if (!rel || rel.draft || rel.prerelease) throw new Error('最新的发布不是正式版（草稿或预发布），已跳过。');
  const version = String(rel.tag_name).replace(/^v/, '');
  parseVersion(version);
  const asset = (rel.assets ?? []).find((a) => a.name === `OpeNotes-Studio-v${version}.zip`);
  return { version, asset, notes: String(rel.body ?? '') };
}

async function fetchLatestRelease() {
  let r;
  try {
    r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpeNotes-Studio-updater', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`无法连接 GitHub：${e.message}。请检查网络后重试。`, { cause: e });
  }
  if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    throw new Error(`GitHub API 请求次数已达上限（未登录每小时 60 次）。${reset ? `请在 ${new Date(reset * 1000).toLocaleTimeString()} 之后重试，` : '请稍后重试，'}或手动到 Releases 页面下载。`);
  }
  if (r.status === 404) throw new Error('GitHub 上还没有正式发布。');
  if (!r.ok) throw new Error(`GitHub 返回了 ${r.status}，请稍后重试。`);
  return r.json();
}

async function download(asset, dest) {
  const r = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'OpeNotes-Studio-updater' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`下载失败：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf;
}

export function verifyDownload(buf, asset) {
  if (asset?.size && buf.length !== asset.size) throw new Error(`下载的文件大小不对（应为 ${asset.size} 字节，实际 ${buf.length}），请重试。`);
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '');
  if (m && sha256(buf) !== m[1].toLowerCase()) throw new Error('下载的文件 sha256 与 GitHub 公布的不一致，已中止。');
}

/** 应用是否在运行：和 launch.mjs 用同一个端口规则（API_PORT > studio.config.json 的 port > 5274）。 */
export function configuredPort(root, env = process.env) {
  if ((env.API_PORT ?? '').trim()) return Number(env.API_PORT);
  try {
    const file = JSON.parse(fs.readFileSync(path.resolve(root, env.STUDIO_CONFIG_FILE?.trim() || 'studio.config.json'), 'utf8'));
    if (Number.isInteger(file.port)) return file.port;
  } catch { /* 没有配置文件 */ }
  return 5274;
}
const portInUse = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1', timeout: 1000 });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('timeout', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(false));
});

function changelogSection(root, version) {
  try {
    const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === `## ${version}`);
    if (start < 0) return '';
    let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    if (end < 0) end = lines.length;
    return lines.slice(start + 1, end).join('\n').trim();
  } catch { return ''; }
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()} ……` : s);
const list = (title, arr) => { if (arr.length) console.log(`${title}（${arr.length}）：\n${arr.slice(0, 40).map((f) => `  ${f}`).join('\n')}${arr.length > 40 ? `\n  …… 另有 ${arr.length - 40} 个` : ''}`); };

// ---------- 主流程 ----------
export async function main(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(n);
  const opt = (n) => (flag(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const valueArgs = new Set([opt('--from-zip'), opt('--release-json')]);
  const dirArg = argv.find((a) => !a.startsWith('--') && !valueArgs.has(a));
  const { root, version: current } = findInstall(dirArg ?? path.join(import.meta.dirname, '..'));
  console.log(`安装目录：${root}\n当前版本：${current}`);

  if (flag('--rollback')) {
    if (await portInUse(configuredPort(root))) throw new Error('OpeNotes Studio 正在运行，请先关闭它的窗口再还原。');
    const r = rollbackLatest(root);
    if (!r) throw new Error('没有可还原的备份（update-backup/ 里没有记录）。');
    console.log(`已从 ${r.dir} 还原到 ${r.manifest.from}（替换 ${r.manifest.changed.length}，恢复 ${r.manifest.removed.length}，移除新增 ${r.manifest.added.length}）。`);
    return 0;
  }

  const fromZip = opt('--from-zip');
  const releaseJson = opt('--release-json');
  const release = releaseJson ? JSON.parse(fs.readFileSync(releaseJson, 'utf8')) : fromZip ? null : await fetchLatestRelease();
  let buf;
  let latest;
  let asset;
  let notes = '';
  if (release) ({ version: latest, asset, notes } = pickRelease(release));
  if (fromZip) buf = fs.readFileSync(fromZip);
  if (!release && buf) {
    const pk = packageFiles(readZip(buf)).get('package.json');
    latest = JSON.parse(pk.read().toString('utf8')).version;
  }
  if (compareVersions(latest, current) <= 0) { console.log(`已经是最新版本（${current}）。`); return 0; }
  console.log(`发现新版本：${current} -> ${latest}`);
  if (notes.trim()) console.log(`\n更新说明：\n${clip(notes.trim(), 600)}\n`);
  if (flag('--check')) { console.log('（仅检查，没有改动任何文件。运行 Update-Windows.cmd / update.sh 来更新。）'); return 0; }

  if (await portInUse(configuredPort(root))) throw new Error('OpeNotes Studio 正在运行。请先关闭它的启动窗口，再重新运行更新。');
  if (!flag('--yes')) {
    if (!process.stdin.isTTY) throw new Error('需要确认：请在终端里运行，或加 --yes。');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`更新到 ${latest}？数据、设置和素材不会被改动。[y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== 'y' && ans !== 'yes') { console.log('已取消。'); return 0; }
  }

  if (!buf) {
    if (!asset) throw new Error(`v${latest} 的发布里没有 OpeNotes-Studio-v${latest}.zip，请到 Releases 页面手动下载。`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openotes-update-'));
    try {
      console.log(`正在下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）……`);
      buf = await download(asset, path.join(tmp, asset.name));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  verifyDownload(buf, asset);

  const files = packageFiles(readZip(buf));
  const newPkg = JSON.parse(files.get('package.json')?.read().toString('utf8') ?? '{}');
  if (newPkg.name !== 'openotes-studio' || newPkg.version !== latest || !files.has('dist/server/index.mjs')) throw new Error('下载的发布包内容不对（package.json 或 dist/server 不符），已中止。');
  const plan = planUpdate(root, files);
  console.log(`比对完成：新增 ${plan.add.length}，修改 ${plan.change.length}，删除 ${plan.remove.length}，未变 ${plan.same}。`);
  list('修改', plan.change); list('新增', plan.add); list('删除', plan.remove);

  const backup = applyPlan(root, files, plan, { fromVersion: current, toVersion: latest });
  console.log(`\n更新完成：${current} -> ${latest}。旧文件已备份到：\n  ${backup}\n如需还原：运行 node scripts/update.mjs --rollback（或在更新脚本后加 --rollback）。`);
  if (plan.change.includes('package-lock.json')) console.log('依赖有变化：下次启动（Start-Windows.cmd / start.sh）会自动重新安装依赖，需要联网。');
  const log = changelogSection(root, latest);
  if (log) console.log(`\n${latest} 更新内容：\n${clip(log, 3000)}`);
  console.log('\n现在可以重新启动 OpeNotes Studio。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`\n[错误] ${e.message}`); process.exitCode = 1; });
}
