// OpeNotes Studio 自动更新（发布包专用，Node 22+，无 npm 依赖）。
//
//   node scripts/update.mjs [安装目录] [--check] [--yes] [--rollback] [--from-zip <zip>]
//   （Windows 双击 Update-Windows.cmd；macOS / Linux 运行 bash update.sh）
//
// 流程：定位安装目录 -> 查询 GitHub 最新正式版 -> 下载发布包 -> 逐文件 sha256 比对 -> 只写入有变化的文件。
// data/、.env、studio.config.json、node_modules/、vendor/ 和素材库永远不会被碰；只删除「上一版发布包清单
// (release-files.json) 里有、新版没有」的文件，没有清单（从 1.0.x 升级）时不删任何文件。
// asset-labels/backgrounds.json 被本地改过时按条目合并，保留你在标签工作台里的编辑。
// 被替换或删除的旧文件先备份到 update-backup/<旧版本>-<本地时间>-<随机>/，--rollback 还原；中断的更新下次运行时自动还原。
// 离线/代理环境：手动下载 zip，用 --from-zip <zip> 更新（可再加 --release-json <release 的 JSON>）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const REPO = 'SKT0tto/OpeNotes-Studio';
const BACKUP_DIR = 'update-backup';
const MANIFEST = 'release-files.json';
const LABELS = 'asset-labels/backgrounds.json';
const KEEP_BACKUPS = 3;
/** 发布包管理的目录与顶层文件（枚举本地文件时用）。 */
export const MANAGED_DIRS = ['dist', 'scripts', 'asset-labels', 'examples', 'docs'];
export const MANAGED_FILES = [
  'package.json', 'package-lock.json', MANIFEST, 'Start-Windows.cmd', 'start.sh', 'Update-Windows.cmd', 'update.sh',
  'LICENSE', 'NOTICE', 'THIRD_PARTY.md', 'README.md', 'CHANGELOG.md', 'studio.config.example.json', '.env.example',
];
/** 无论如何都不读、不写、不删的位置（第一段，不区分大小写）。 */
const PROTECTED = ['data', '.env', 'studio.config.json', 'node_modules', 'vendor', 'assets', BACKUP_DIR, '.git'];
export const isProtected = (rel) => PROTECTED.includes(rel.split('/')[0].toLowerCase());
const LAST = [MANIFEST, 'package-lock.json', 'package.json']; // 最后写入：中途失败时版本号仍是旧的，重跑即可
const lastFirst = (a, b) => LAST.indexOf(a) - LAST.indexOf(b) || a.localeCompare(b);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- 文件操作：Windows 上被占用（杀毒、编辑器）时短暂重试 ----------
export const tuning = { retries: 40 };
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retrying(fn) {
  for (let a = 0; ; a++) {
    try { return fn(); } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || a >= tuning.retries) throw e;
      nap(10 + a * 5);
    }
  }
}
function writeAtomic(abs, data, exec) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.update-tmp`;
  try {
    fs.writeFileSync(tmp, data);
    if (exec) fs.chmodSync(tmp, 0o755);
    retrying(() => fs.renameSync(tmp, abs));
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    throw e;
  }
}
const removeFile = (abs) => retrying(() => fs.rmSync(abs, { force: true }));

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

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/** 校验 zip 条目路径：拒绝绝对路径、盘符/流（:）、反斜杠、NUL、`..`、以点或空格结尾的段、Windows 保留名。目录以 / 结尾。 */
export function sanitizeEntryPath(name) {
  const bad = () => new Error(`发布包里有不安全的路径：${JSON.stringify(name)}`);
  if (!name || name.includes('\0') || name.includes('\\') || name.includes(':') || name.startsWith('/')) throw bad();
  const parts = name.split('/');
  for (const [i, p] of parts.entries()) {
    if (p === '' && i === parts.length - 1) continue; // 目录条目的结尾斜杠
    if (p === '' || p === '.' || p === '..' || /[. ]$/.test(p) || RESERVED.test(p)) throw bad();
  }
  return name;
}

/** 解析 zip，返回 [{ name, isDir, mode, size, read() }]；name 已经过 sanitizeEntryPath。 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件（找不到目录结尾），下载可能不完整。');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) throw new Error('不支持 zip64 格式的发布包。');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('不支持 zip64 格式的发布包。');
  if (buf.readUInt16LE(eocd + 4) !== 0 || cdOffset + cdSize > buf.length) throw new Error('zip 文件已损坏或不完整。');
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目录已损坏。');
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
    if (csize === 0xffffffff || usize === 0xffffffff || localOff === 0xffffffff) throw new Error('不支持 zip64 格式的发布包。');
    if (flags & 1) throw new Error(`不支持加密的 zip 条目：${name}`);
    if ((unixMode & 0xf000) === 0xa000) throw new Error(`发布包里有符号链接：${name}`);
    const isDir = name.endsWith('/');
    if (!isDir && method !== 0 && method !== 8) throw new Error(`不支持的压缩方式 ${method}：${name}`);
    entries.push({
      name, isDir, mode: unixMode & 0o777, size: usize,
      read() {
        const broken = (e) => new Error(`zip 条目已损坏：${name}`, { cause: e });
        try {
          if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header');
          const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
          if (start + csize > buf.length) throw new Error('out of range');
          const raw = buf.subarray(start, start + csize);
          const out = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
          if (out.length !== usize || crc32(out) !== crc) throw new Error('size or crc mismatch');
          return out;
        } catch (e) { throw broken(e); }
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
    if (top !== null && first !== top) throw new Error('发布包有多个顶层目录。');
    top = first;
    const rel = e.name.slice(i + 1);
    if (e.isDir || rel === '') continue;
    if (isProtected(rel)) throw new Error(`发布包里含有受保护的路径：${rel}`);
    files.set(rel, { read: e.read, mode: e.mode });
  }
  if (!files.size) throw new Error('发布包是空的。');
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

/** 本地的上一版清单 release-files.json：Map<路径, sha256>；没有（1.0.x）或不可用返回 null。 */
export function readPrevManifest(root) {
  try {
    const files = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')).files;
    const map = new Map();
    for (const [rel, sha] of Object.entries(files)) {
      try { sanitizeEntryPath(rel); } catch { continue; }
      if (!isProtected(rel) && typeof sha === 'string') map.set(rel, sha);
    }
    return map;
  } catch { return null; }
}

// ---------- asset-labels 合并 ----------
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
/** 以新包为底合并标签文件：保留本地 source:"user"、与新包不同且 updatedAt 不早于新包的条目；rules 不同时保留本地。解析失败返回 null。 */
export function mergeLabels(localBuf, pkgBuf) {
  let local;
  let pkg;
  try { local = JSON.parse(localBuf.toString('utf8')); pkg = JSON.parse(pkgBuf.toString('utf8')); } catch { return null; }
  if (!local?.labels || !pkg?.labels) return null;
  const labels = { ...pkg.labels };
  const kept = [];
  const overridden = [];
  for (const [id, mine] of Object.entries(local.labels)) {
    const theirs = pkg.labels[id];
    if (!theirs || canon(mine) === canon(theirs)) { if (!theirs && mine?.source === 'user') { labels[id] = mine; kept.push(id); } continue; }
    if (mine?.source !== 'user') continue; // 草稿条目：以新包为准
    if ((mine.updatedAt ?? '') >= (theirs.updatedAt ?? '')) { labels[id] = mine; kept.push(id); } else overridden.push(id);
  }
  const rulesKept = local.rules !== undefined && canon(local.rules) !== canon(pkg.rules);
  const merged = { ...pkg, rules: rulesKept ? local.rules : pkg.rules, labels };
  return { buf: Buffer.from(`${JSON.stringify(merged, null, 1)}\n`), kept, overridden, rulesKept };
}

// ---------- 更新计划 ----------
/** 计算更新计划：add / change / remove / same，以及 overrides（要写入的替代内容，如合并后的标签）和 labels（合并报告）。 */
export function planUpdate(root, files) {
  const plan = { add: [], change: [], remove: [], same: 0, overrides: {}, labels: null };
  const local = listManaged(root);
  const localSet = new Set(local);
  const lower = new Map(local.map((p) => [p.toLowerCase(), p]));
  const prev = readPrevManifest(root);
  const removes = new Set();
  for (const [rel, f] of files) {
    const abs = path.join(root, rel);
    if (!localSet.has(rel)) {
      const variant = lower.get(rel.toLowerCase());
      if (variant) { removes.add(variant); plan.add.push(rel); continue; } // 只改了大小写：先删旧名再写新名
      if (!fs.existsSync(abs)) { plan.add.push(rel); continue; }
    }
    let data = f.read();
    const mine = fs.statSync(abs).isFile() ? fs.readFileSync(abs) : null;
    if (mine && rel === LABELS && !mine.equals(data) && sha256(mine) !== prev?.get(rel)) {
      const m = mergeLabels(mine, data);
      if (m) { data = m.buf; plan.overrides[rel] = m.buf; plan.labels = m; }
    }
    if (mine?.equals(data)) plan.same++; else plan.change.push(rel);
  }
  // 只删上一版清单里发过、新版不再有的文件；没有清单就不删
  if (prev) {
    for (const rel of prev.keys()) {
      const abs = path.join(root, rel);
      if (!files.has(rel) && fs.existsSync(abs) && fs.statSync(abs).isFile()) removes.add(rel);
    }
  }
  plan.remove = [...removes].filter((r) => !files.has(r) && !isProtected(r)).sort();
  plan.add.sort(lastFirst);
  plan.change.sort(lastFirst);
  return plan;
}

// ---------- 应用、备份、回滚 ----------
function localStamp() {
  const d = new Date();
  const n = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}-${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
}
const writeManifest = (dir, m) => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));

/** 全部备份（有 manifest 的），按创建时间从旧到新。 */
export function listBackups(root) {
  const base = path.join(root, BACKUP_DIR);
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const d of fs.readdirSync(base)) {
    try { out.push({ dir: path.join(base, d), manifest: JSON.parse(fs.readFileSync(path.join(base, d, 'manifest.json'), 'utf8')) }); } catch { /* 不是备份 */ }
  }
  return out.sort((a, b) => String(a.manifest.createdAt ?? '').localeCompare(String(b.manifest.createdAt ?? '')) || a.dir.localeCompare(b.dir));
}

/** 备份旧文件，再原子写入新文件、删除多余文件。失败会尽力还原，并把失败项写进错误信息。返回备份目录。 */
export function applyPlan(root, files, plan, { fromVersion, toVersion }) {
  const base = path.join(root, BACKUP_DIR);
  fs.mkdirSync(base, { recursive: true });
  let backup;
  for (;;) {
    backup = path.join(base, `${fromVersion}-${localStamp()}-${crypto.randomBytes(3).toString('hex')}`);
    try { fs.mkdirSync(backup); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const manifest = { from: fromVersion, to: toVersion, createdAt: new Date().toISOString(), added: plan.add, changed: plan.change, removed: plan.remove, completed: false, rolledBack: false };
  try {
    for (const rel of [...plan.change, ...plan.remove]) {
      fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(backup, rel));
    }
    writeManifest(backup, manifest);
  } catch (e) {
    fs.rmSync(backup, { recursive: true, force: true }); // 还没动任何文件
    throw new Error(`无法创建备份，更新未开始：${e.message}`, { cause: e });
  }
  try {
    for (const rel of plan.remove) removeFile(path.join(root, rel));
    for (const rel of [...plan.add, ...plan.change]) writeAtomic(path.join(root, rel), plan.overrides[rel] ?? files.get(rel).read(), files.get(rel).mode & 0o111);
    removeEmptyDirs(root);
  } catch (e) {
    const { failed } = restoreBackup(root, backup);
    const why = `更新中途失败（${e.message}）。`;
    throw new Error(failed.length
      ? `${why}自动还原也有 ${failed.length} 个文件失败：${failed.map((f) => f.rel).join('、')}。请关闭 OpeNotes Studio 和其它可能占用这些文件的程序，然后运行 --rollback 完成还原。`
      : `${why}已自动还原到更新前的状态。`, { cause: e });
  }
  manifest.completed = true;
  writeManifest(backup, manifest);
  pruneBackups(root);
  return backup;
}

function pruneBackups(root) {
  const all = listBackups(root);
  for (const b of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
    if (b.manifest.completed !== false || b.manifest.rolledBack) fs.rmSync(b.dir, { recursive: true, force: true });
  }
}

function removeEmptyDirs(root) {
  const prune = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) prune(path.join(dir, d.name));
    if (dir !== root && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
  };
  for (const d of MANAGED_DIRS) if (fs.existsSync(path.join(root, d))) prune(path.join(root, d));
}

/** 逐个文件尽力还原一个备份：先删这次新增的，再放回被替换/删除的，清理 .update-tmp。全部成功才标记 rolledBack。 */
export function restoreBackup(root, backup) {
  const m = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  const failed = [];
  const attempt = (rel, fn) => { try { fn(); } catch (e) { failed.push({ rel, error: e.message }); } };
  for (const rel of m.added) if (!isProtected(rel)) attempt(rel, () => removeFile(path.join(root, rel)));
  for (const rel of [...m.changed, ...m.removed]) {
    if (isProtected(rel)) continue;
    attempt(rel, () => writeAtomic(path.join(root, rel), fs.readFileSync(path.join(backup, rel)), rel.endsWith('.sh')));
  }
  for (const rel of [...m.added, ...m.changed, ...m.removed]) {
    try { fs.rmSync(`${path.join(root, rel)}.update-tmp`, { force: true }); } catch { /* 尽力 */ }
  }
  try { removeEmptyDirs(root); } catch { /* 尽力 */ }
  if (!failed.length) { m.rolledBack = true; writeManifest(backup, m); }
  return { manifest: m, failed };
}

/** 发现上次被中断的更新（completed:false）并处理：包已全部写完则补标完成，否则还原。返回处理记录。 */
export function recoverIncomplete(root) {
  const current = findInstall(root).version;
  const done = [];
  for (const b of listBackups(root).reverse()) {
    const m = b.manifest;
    if (m.completed !== false || m.rolledBack) continue;
    if (m.to === current) { m.completed = true; writeManifest(b.dir, m); done.push({ ...b, action: 'finished', failed: [] }); continue; } // package.json 最后写，已是新版说明都写完了
    const r = restoreBackup(root, b.dir);
    done.push({ dir: b.dir, manifest: m, action: 'restored', failed: r.failed });
  }
  return done;
}

/** 还原最近一次已完成且未回滚的更新；没有返回 null；当前版本不是它更新到的版本则拒绝。 */
export function rollbackLatest(root) {
  const { version } = findInstall(root);
  const last = listBackups(root).filter((b) => b.manifest.completed !== false && !b.manifest.rolledBack).pop();
  if (!last) return null;
  if (last.manifest.to !== version) throw new Error(`最近一次更新是 ${last.manifest.from} -> ${last.manifest.to}，但当前安装的是 ${version}，不能直接还原（安装可能被手动改动过）。备份仍在 ${last.dir}。`);
  const { manifest, failed } = restoreBackup(root, last.dir);
  if (failed.length) throw new Error(`有 ${failed.length} 个文件没能还原：${failed.map((f) => f.rel).join('、')}。请关闭 OpeNotes Studio 和其它占用这些文件的程序，再运行一次 --rollback。`);
  return { dir: last.dir, manifest };
}

// ---------- 联网 ----------
export function pickRelease(rel) {
  if (!rel || rel.draft || rel.prerelease) throw new Error('最新的发布不是正式版（草稿或预发布），已跳过。');
  const version = String(rel.tag_name).replace(/^v/, '');
  parseVersion(version);
  const asset = (rel.assets ?? []).find((a) => a.name === `OpeNotes-Studio-v${version}.zip`);
  return { version, asset, notes: String(rel.body ?? '') };
}

const MANUAL = '如果网络需要代理：Node 24 可设置环境变量 NODE_USE_ENV_PROXY=1 和 HTTPS_PROXY；也可以手动下载 zip，再运行 update 脚本并加 --from-zip <zip 路径>。';

async function fetchLatestRelease() {
  let r;
  try {
    r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpeNotes-Studio-updater', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`无法连接 GitHub：${e.message}。请检查网络后重试。${MANUAL}`, { cause: e });
  }
  if ((r.status === 403 || r.status === 429) && r.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    throw new Error(`GitHub API 请求次数已达上限（未登录每小时 60 次）。${reset ? `请在 ${new Date(reset * 1000).toLocaleTimeString()} 之后重试，` : '请稍后重试，'}或手动到 Releases 页面下载。`);
  }
  if (r.status === 404) throw new Error('GitHub 上还没有正式发布。');
  if (!r.ok) throw new Error(`GitHub 返回了 ${r.status}，请稍后重试。`);
  return r.json();
}

/** 下载发布包：30 秒收不到数据就超时，终端里显示进度。 */
async function download(asset) {
  const ctl = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 30000); };
  arm();
  try {
    const r = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'OpeNotes-Studio-updater' }, redirect: 'follow', signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const chunks = [];
    let got = 0;
    for await (const c of r.body) {
      arm();
      chunks.push(c);
      got += c.length;
      if (process.stdout.isTTY) process.stdout.write(`\r  已下载 ${(got / 1048576).toFixed(1)} / ${((asset.size ?? 0) / 1048576).toFixed(1)} MB`);
    }
    if (process.stdout.isTTY) process.stdout.write('\n');
    return Buffer.concat(chunks);
  } catch (e) {
    throw new Error(`下载失败：${ctl.signal.aborted ? '30 秒没有收到数据（超时）' : e.message}。${MANUAL}`, { cause: e });
  } finally { clearTimeout(timer); }
}

export function verifyDownload(buf, asset) {
  if (asset?.size && buf.length !== asset.size) throw new Error(`下载的文件大小不对（应为 ${asset.size} 字节，实际 ${buf.length}），请重试。`);
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '');
  if (m && sha256(buf) !== m[1].toLowerCase()) throw new Error('下载的文件 sha256 与 GitHub 公布的不一致，已中止。');
}

/** 应用使用的端口，规则同服务器：环境变量 API_PORT > 安装目录 .env 里的 API_PORT > studio.config.json 的 port > 5274。 */
export function configuredPort(root, env = process.env) {
  if ((env.API_PORT ?? '').trim()) return Number(env.API_PORT);
  try {
    const m = /^\s*API_PORT\s*=\s*(.*)$/m.exec(fs.readFileSync(path.join(root, '.env'), 'utf8')); // 只取这一项，不输出
    const v = m?.[1].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
    if (v && Number.isInteger(Number(v))) return Number(v);
  } catch { /* 没有 .env */ }
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

const USAGE = `用法：node scripts/update.mjs [安装目录] [--check] [--yes] [--rollback] [--from-zip <zip>] [--release-json <json>]
  --check      只检查有没有新版，不改任何文件
  --yes        不再询问，直接更新
  --rollback   还原最近一次更新
  --from-zip   用手动下载的发布包更新（不联网；路径按当前目录解析）`;

function parseArgs(argv) {
  const out = { flags: new Set(), dir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-zip' || a === '--release-json') {
      if (i + 1 >= argv.length) throw new Error(`${a} 后面需要一个路径。\n${USAGE}`);
      out[a === '--from-zip' ? 'zip' : 'releaseJson'] = argv[++i];
    } else if (['--check', '--yes', '--rollback', '--help'].includes(a)) out.flags.add(a);
    else if (a.startsWith('-')) throw new Error(`不认识的参数：${a}\n${USAGE}`);
    else if (out.dir === undefined) out.dir = a;
    else throw new Error(`多余的参数：${a}\n${USAGE}`);
  }
  return out;
}

const reportFailed = (failed) => failed.map((f) => f.rel).join('、');

// ---------- 主流程 ----------
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.flags.has('--help')) { console.log(USAGE); return 0; }
  const { root, version: current } = findInstall(args.dir ?? path.join(import.meta.dirname, '..'));
  console.log(`安装目录：${root}\n当前版本：${current}`);
  const guardRunning = async () => {
    if (await portInUse(configuredPort(root))) throw new Error('OpeNotes Studio 正在运行。请先关闭它的启动窗口，再重新运行。');
  };

  if (args.flags.has('--rollback')) {
    await guardRunning();
    const rec = recoverIncomplete(root);
    if (rec.length) {
      for (const r of rec) console.log(r.action === 'finished' ? `发现上次更新其实已写完（${r.manifest.from} -> ${r.manifest.to}），已标记完成。` : `上次更新（${r.manifest.from} -> ${r.manifest.to}）被中断，已还原到 ${r.manifest.from}。`);
      const bad = rec.flatMap((r) => r.failed);
      if (bad.length) throw new Error(`有 ${bad.length} 个文件没能还原：${reportFailed(bad)}。请关闭占用它们的程序后再运行一次 --rollback。`);
      if (rec.some((r) => r.action === 'restored')) return 0; // 已经回到更新前的状态，不再多退一步
    }
    const r = rollbackLatest(root);
    if (!r) throw new Error('没有可还原的备份（update-backup/ 里没有未还原的更新记录）。');
    console.log(`已从 ${r.dir} 还原到 ${r.manifest.from}（替换 ${r.manifest.changed.length}，恢复 ${r.manifest.removed.length}，移除新增 ${r.manifest.added.length}）。`);
    return 0;
  }

  const release = args.releaseJson ? JSON.parse(fs.readFileSync(args.releaseJson, 'utf8')) : args.zip ? null : await fetchLatestRelease();
  let buf = args.zip ? fs.readFileSync(args.zip) : undefined;
  let latest;
  let asset;
  let notes = '';
  if (release) ({ version: latest, asset, notes } = pickRelease(release));
  else latest = JSON.parse(packageFiles(readZip(buf)).get('package.json').read().toString('utf8')).version;
  if (compareVersions(latest, current) <= 0) { console.log(`已经是最新版本（${current}）。`); return 0; }
  console.log(`发现新版本：${current} -> ${latest}`);
  if (notes.trim()) console.log(`\n更新说明：\n${clip(notes.trim(), 600)}\n`);
  if (args.flags.has('--check')) { console.log('（仅检查，没有改动任何文件。运行 Update-Windows.cmd / update.sh 来更新。）'); return 0; }

  await guardRunning();
  if (!args.flags.has('--yes')) {
    if (!process.stdin.isTTY) throw new Error('需要确认：请在终端里运行，或加 --yes。');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`更新到 ${latest}？数据、设置和素材不会被改动。[y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== 'y' && ans !== 'yes') { console.log('已取消。'); return 0; }
  }

  const rec = recoverIncomplete(root);
  for (const r of rec) {
    console.log(r.action === 'finished' ? `发现上次更新其实已写完（${r.manifest.from} -> ${r.manifest.to}）。` : `上次更新（${r.manifest.from} -> ${r.manifest.to}）被中断，已先还原到 ${r.manifest.from}。`);
    if (r.failed.length) throw new Error(`上次中断的更新有 ${r.failed.length} 个文件没能还原：${reportFailed(r.failed)}。请关闭占用它们的程序后运行 --rollback。`);
  }
  const from = findInstall(root).version;

  if (!buf) {
    if (!asset) throw new Error(`v${latest} 的发布里没有 OpeNotes-Studio-v${latest}.zip，请到 Releases 页面手动下载。`);
    console.log(`正在下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）……`);
    buf = await download(asset);
  }
  verifyDownload(buf, asset);

  const files = packageFiles(readZip(buf));
  const newPkg = JSON.parse(files.get('package.json')?.read().toString('utf8') ?? '{}');
  if (newPkg.name !== 'openotes-studio' || newPkg.version !== latest || !files.has('dist/server/index.mjs')) throw new Error('下载的发布包内容不对（package.json 或 dist/server 不符），已中止。');
  const plan = planUpdate(root, files);
  console.log(`比对完成：新增 ${plan.add.length}，修改 ${plan.change.length}，删除 ${plan.remove.length}，未变 ${plan.same}。`);
  list('修改', plan.change); list('新增', plan.add); list('删除', plan.remove);
  if (!readPrevManifest(root)) console.log('（当前安装没有文件清单，这次只覆盖和新增，不删除任何文件。）');
  if (plan.labels && plan.change.includes(LABELS)) {
    const l = plan.labels;
    console.log(`\n标签文件 ${LABELS} 在本地有改动，已按条目合并：保留你的 ${l.kept.length} 条编辑。`);
    if (l.overridden.length) console.log(`以下条目的你的编辑比新版的旧，被新版覆盖了（旧文件在备份里）：${l.overridden.join('、')}`);
    if (l.rulesKept) console.log('提示：你本地的标签 rules 与新版不同，已保留你的设置。');
  }

  const backup = applyPlan(root, files, plan, { fromVersion: from, toVersion: latest });
  console.log(`\n更新完成：${from} -> ${latest}。旧文件已备份到：\n  ${backup}\n如需还原：关闭程序后运行 update 脚本并加 --rollback。`);
  if (plan.change.includes('package-lock.json')) console.log('依赖有变化：下次启动（Start-Windows.cmd / start.sh）会自动重新安装依赖，需要联网。');
  const log = changelogSection(root, latest);
  if (log) console.log(`\n${latest} 更新内容：\n${clip(log, 3000)}`);
  console.log('\n现在可以重新启动 OpeNotes Studio。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`\n[错误] ${e.message}`); process.exitCode = 1; });
}
