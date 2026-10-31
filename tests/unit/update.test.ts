import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yazl from 'yazl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Files = Map<string, { read(): Buffer; mode: number }>;
type Plan = { add: string[]; change: string[]; remove: string[]; same: number };
const u = (await import(pathToFileURL(path.resolve('scripts', 'update.mjs')).href)) as {
  compareVersions(a: string, b: string): number;
  parseVersion(v: string): unknown;
  sanitizeEntryPath(n: string): string;
  readZip(b: Buffer): { name: string; isDir: boolean; size: number; read(): Buffer }[];
  packageFiles(e: unknown): Files;
  findInstall(d: string): { root: string; version: string };
  planUpdate(root: string, f: Files): Plan;
  applyPlan(root: string, f: Files, p: Plan, v: { fromVersion: string; toVersion: string }): string;
  rollbackLatest(root: string): { dir: string; manifest: { from: string } } | null;
  pickRelease(r: unknown): { version: string; asset?: { name: string }; notes: string };
  verifyDownload(b: Buffer, a: unknown): void;
  configuredPort(root: string, env: Record<string, string>): number;
  main(argv: string[]): Promise<number>;
};

async function makeZip(entries: Record<string, string | Buffer>, opts: { store?: boolean } = {}): Promise<Buffer> {
  const z = new yazl.ZipFile();
  for (const [n, c] of Object.entries(entries)) z.addBuffer(Buffer.from(c), n, { compress: !opts.store, mtime: new Date(0) });
  z.end();
  const chunks: Buffer[] = [];
  for await (const c of z.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const pkgJson = (version: string) => JSON.stringify({ name: 'openotes-studio', version });
const top = (v: string, files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([k, c]) => [`OpeNotes-Studio-v${v}/${k}`, c]));

describe('semver', () => {
  it('compares versions', () => {
    const c = u.compareVersions;
    expect(c('1.0.0', '1.0.1')).toBe(-1);
    expect(c('v1.10.0', '1.9.9')).toBe(1);
    expect(c('2.0.0', '2.0.0')).toBe(0);
    expect(c('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(c('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(c('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(c('1.0.0-1', '1.0.0-beta')).toBe(-1);
    expect(() => u.parseVersion('banana')).toThrow();
  });
});

describe('zip reader', () => {
  it('reads deflate and stored entries and skips directories', async () => {
    for (const store of [false, true]) {
      const zip = await makeZip({ 'a/x.txt': 'hello '.repeat(100), 'a/sub/y.bin': Buffer.from([0, 1, 2, 3]), 'a/empty.txt': '' }, { store });
      const entries = u.readZip(zip);
      const byName = new Map(entries.map((e) => [e.name, e]));
      expect(byName.get('a/x.txt')!.read().toString()).toBe('hello '.repeat(100));
      expect([...byName.get('a/sub/y.bin')!.read()]).toEqual([0, 1, 2, 3]);
      expect(byName.get('a/empty.txt')!.read().length).toBe(0);
    }
  });

  it('strips the top folder', async () => {
    const files = u.packageFiles(u.readZip(await makeZip(top('1.0.1', { 'package.json': pkgJson('1.0.1'), 'dist/a.js': 'x' }))));
    expect([...files.keys()].sort()).toEqual(['dist/a.js', 'package.json']);
  });

  it('rejects multiple top folders, loose files and protected paths', async () => {
    const two = await makeZip({ 'a/x': '1', 'b/y': '2' });
    const loose = await makeZip({ 'x.txt': '1' });
    expect(() => u.packageFiles(u.readZip(two))).toThrow(/多个顶层/);
    expect(() => u.packageFiles(u.readZip(loose))).toThrow(/顶层/);
    for (const p of ['data/p.json', '.env', 'studio.config.json', 'node_modules/x/i.js', 'vendor/core.js', 'Data/p.json']) {
      const z = await makeZip({ [`top/${p}`]: '1' });
      expect(() => u.packageFiles(u.readZip(z))).toThrow(/受保护/);
    }
  });

  it('rejects corrupt data, bad compression, truncated and non-zip input', async () => {
    const zip = await makeZip({ 'a/x.txt': 'hello world hello world' }, { store: true });
    const bad = Buffer.from(zip);
    bad[bad.indexOf('hello')]! ^= 0xff; // flips a content byte: crc mismatch
    expect(() => u.readZip(bad)[0]!.read()).toThrow(/校验/);
    expect(() => u.readZip(Buffer.from('not a zip at all, definitely'))).toThrow();
    expect(() => u.readZip(zip.subarray(0, zip.length - 10))).toThrow();
    // unsupported method (bzip2 = 12) in the central directory
    const m = Buffer.from(zip);
    m.writeUInt16LE(12, m.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(() => u.readZip(m)).toThrow(/压缩方式/);
  });

  it('rejects zip64 and encrypted entries', async () => {
    const zip = await makeZip({ 'a/x.txt': 'x' });
    const z64 = Buffer.from(zip);
    z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
    expect(() => u.readZip(z64)).toThrow(/zip64/);
    const enc = Buffer.from(zip);
    enc.writeUInt16LE(1, enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    expect(() => u.readZip(enc)).toThrow(/加密/);
  });
});

describe('path safety', () => {
  it('rejects traversal, absolute and odd paths', () => {
    for (const n of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'c:\\x', 'a\\b', 'a//b', './a', 'a/./b', 'a\0b', '']) expect(() => u.sanitizeEntryPath(n)).toThrow();
    for (const n of ['a/b.txt', 'a/', 'top/dist/x.js', 'a/..foo/b']) expect(u.sanitizeEntryPath(n)).toBe(n);
  });

  it('rejects an unsafe entry found inside a zip', async () => {
    const zip = await makeZip({ 'AAAAAA/x.txt': '1' });
    const evil = Buffer.from(zip);
    let at = -1;
    while ((at = evil.indexOf('AAAAAA/', at + 1)) >= 0) evil.write('../../x', at); // 7 bytes: same length, both headers
    expect(() => u.readZip(evil)).toThrow(/不安全/);
    const abs = Buffer.from(zip);
    at = -1;
    while ((at = abs.indexOf('AAAAAA/', at + 1)) >= 0) abs.write('/etc/pw', at);
    expect(() => u.readZip(abs)).toThrow(/不安全/);
  });
});

describe('release picking and download checks', () => {
  it('skips drafts and prereleases and finds the asset', () => {
    expect(() => u.pickRelease({ tag_name: 'v1.1.0-beta.1', prerelease: true })).toThrow();
    expect(() => u.pickRelease({ tag_name: 'v1.1.0', draft: true })).toThrow();
    const r = u.pickRelease({ tag_name: 'v1.1.0', body: 'notes', assets: [{ name: 'OpeNotes-Studio-v1.1.0.zip' }] });
    expect(r.version).toBe('1.1.0');
    expect(r.asset?.name).toBe('OpeNotes-Studio-v1.1.0.zip');
  });

  it('verifies size and digest', () => {
    const buf = Buffer.from('abc');
    const digest = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(() => u.verifyDownload(buf, { size: 3, digest })).not.toThrow();
    expect(() => u.verifyDownload(buf, { size: 4 })).toThrow(/大小/);
    expect(() => u.verifyDownload(buf, { size: 3, digest: `sha256:${'0'.repeat(64)}` })).toThrow(/sha256/);
  });

  it('uses the same port rules as launch.mjs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-port-'));
    try {
      expect(u.configuredPort(dir, {})).toBe(5274);
      fs.writeFileSync(path.join(dir, 'studio.config.json'), '{"port":6001}');
      expect(u.configuredPort(dir, {})).toBe(6001);
      expect(u.configuredPort(dir, { API_PORT: '7000' })).toBe(7000);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('plan, apply, backup and rollback', () => {
  let root: string;
  const write = (rel: string, c: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); };
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));
  const protectedFiles = { 'data/projects/p1/project.json': 'MY STORY', '.env': 'SECRET=1', 'studio.config.json': '{"port":1}', 'node_modules/x/index.js': 'nm', 'vendor/live2dcubismcore.min.js': 'core', 'assets/m/a.moc3': 'asset' };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-install-'));
    write('package.json', pkgJson('1.0.0'));
    write('dist/server/index.mjs', 'old-server');
    write('dist/web/same.js', 'same');
    write('dist/web/old-chunk.js', 'gone');
    write('scripts/launch.mjs', 'old-launch');
    write('docs/OLD.md', 'old doc');
    write('README.md', 'old readme');
    write('notes-by-user.txt', 'not in package: untouched');
    for (const [k, v] of Object.entries(protectedFiles)) write(k, v);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function newFiles(): Promise<Files> {
    const zip = await makeZip(top('1.1.0', {
      'package.json': pkgJson('1.1.0'), 'dist/server/index.mjs': 'new-server', 'dist/web/same.js': 'same',
      'dist/web/new-chunk.js': 'fresh', 'scripts/launch.mjs': 'old-launch', 'scripts/update.mjs': 'upd', 'README.md': 'new readme',
    }));
    return u.packageFiles(u.readZip(zip));
  }

  it('finds the install and refuses git checkouts and strangers', () => {
    expect(u.findInstall(root).version).toBe('1.0.0');
    fs.mkdirSync(path.join(root, '.git'));
    expect(() => u.findInstall(root)).toThrow(/git/);
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    fs.rmSync(path.join(root, 'dist/server/index.mjs'));
    expect(() => u.findInstall(root)).toThrow(/不是 OpeNotes/);
    write('dist/server/index.mjs', 'x');
    write('package.json', JSON.stringify({ name: 'other', version: '1.0.0' }));
    expect(() => u.findInstall(root)).toThrow(/不是 OpeNotes/);
  });

  it('plans adds, changes and removals only inside managed paths', async () => {
    const plan = u.planUpdate(root, await newFiles());
    expect(plan.add.sort()).toEqual(['dist/web/new-chunk.js', 'scripts/update.mjs']);
    expect(plan.change.sort()).toEqual(['README.md', 'dist/server/index.mjs', 'package.json']);
    expect(plan.remove.sort()).toEqual(['dist/web/old-chunk.js', 'docs/OLD.md']);
    expect(plan.same).toBe(2);
    expect(plan.change.at(-1)).toBe('package.json'); // written last
  });

  it('applies the update, leaves protected files alone, backs up and rolls back', async () => {
    const files = await newFiles();
    const plan = u.planUpdate(root, files);
    const backup = u.applyPlan(root, files, plan, { fromVersion: '1.0.0', toVersion: '1.1.0' });

    expect(read('package.json')).toContain('1.1.0');
    expect(read('dist/server/index.mjs')).toBe('new-server');
    expect(read('dist/web/new-chunk.js')).toBe('fresh');
    expect(exists('dist/web/old-chunk.js')).toBe(false);
    expect(exists('docs')).toBe(false); // emptied directory is pruned
    expect(read('notes-by-user.txt')).toBe('not in package: untouched');
    for (const [k, v] of Object.entries(protectedFiles)) expect(read(k)).toBe(v);
    expect(fs.readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('.update-tmp'))).toEqual([]);

    expect(path.basename(backup)).toMatch(/^1\.0\.0-\d{8}-\d{6}$/);
    expect(fs.readFileSync(path.join(backup, 'dist/server/index.mjs'), 'utf8')).toBe('old-server');
    expect(fs.readFileSync(path.join(backup, 'docs/OLD.md'), 'utf8')).toBe('old doc');
    expect(fs.existsSync(path.join(backup, 'dist/web/new-chunk.js'))).toBe(false);

    const rb = u.rollbackLatest(root);
    expect(rb?.manifest.from).toBe('1.0.0');
    expect(read('package.json')).toContain('1.0.0');
    expect(read('dist/server/index.mjs')).toBe('old-server');
    expect(read('dist/web/old-chunk.js')).toBe('gone');
    expect(read('docs/OLD.md')).toBe('old doc');
    expect(read('README.md')).toBe('old readme');
    expect(exists('dist/web/new-chunk.js')).toBe(false);
    expect(exists('scripts/update.mjs')).toBe(false);
    for (const [k, v] of Object.entries(protectedFiles)) expect(read(k)).toBe(v);
    expect(u.rollbackLatest(root)).toBeNull(); // already rolled back
  });

  it('restores automatically when a write fails midway', async () => {
    const files = await newFiles();
    const plan = u.planUpdate(root, files);
    const bad: Files = new Map(files);
    bad.set('scripts/update.mjs', { mode: 0, read: () => { throw new Error('boom'); } });
    expect(() => u.applyPlan(root, bad, plan, { fromVersion: '1.0.0', toVersion: '1.1.0' })).toThrow(/已自动还原/);
    expect(read('package.json')).toContain('1.0.0');
    expect(read('dist/server/index.mjs')).toBe('old-server');
    expect(exists('dist/web/new-chunk.js')).toBe(false);
    expect(read('docs/OLD.md')).toBe('old doc');
  });

  it('main(--from-zip) updates, is idempotent, and --check changes nothing', async () => {
    const zip = await makeZip(top('1.1.0', { 'package.json': pkgJson('1.1.0'), 'dist/server/index.mjs': 'new-server', 'CHANGELOG.md': '# Changelog\n\n## 1.1.0\n\nnew stuff\n' }));
    const zipPath = path.join(root, '..', `upd-${path.basename(root)}.zip`);
    fs.writeFileSync(zipPath, zip);
    const saved = process.env.API_PORT;
    process.env.API_PORT = '59871'; // a port nothing listens on
    try {
      expect(await u.main([root, '--from-zip', zipPath, '--check'])).toBe(0);
      expect(read('dist/server/index.mjs')).toBe('old-server');
      expect(await u.main([root, '--from-zip', zipPath, '--yes'])).toBe(0);
      expect(read('dist/server/index.mjs')).toBe('new-server');
      expect(await u.main([root, '--from-zip', zipPath, '--yes'])).toBe(0); // up to date now
      expect(fs.readdirSync(path.join(root, 'update-backup')).length).toBe(1);
      expect(await u.main([root, '--rollback'])).toBe(0);
      expect(read('dist/server/index.mjs')).toBe('old-server');
    } finally {
      if (saved === undefined) delete process.env.API_PORT; else process.env.API_PORT = saved;
      fs.rmSync(zipPath, { force: true });
    }
  });
});
