import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yazl from 'yazl';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Files = Map<string, { read(): Buffer; mode: number }>;
type Plan = { add: string[]; change: string[]; remove: string[]; same: number; overrides: Record<string, Buffer>; labels: null | { kept: string[]; overridden: string[]; rulesKept: boolean } };
type Backup = { dir: string; manifest: { createdAt: string; completed?: boolean; rolledBack?: boolean; from: string; to: string } };
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
  recoverIncomplete(root: string): { action: string; failed: unknown[]; manifest: { from: string; to: string } }[];
  restoreBackup(root: string, dir: string): { failed: { rel: string }[] };
  listBackups(root: string): Backup[];
  mergeLabels(l: Buffer, p: Buffer): { buf: Buffer; kept: string[]; overridden: string[]; rulesKept: boolean } | null;
  readPrevManifest(root: string): Map<string, string> | null;
  tuning: { retries: number };
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
    expect(() => u.readZip(bad)[0]!.read()).toThrow(/已损坏/);
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
    for (const n of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'c:\\x', 'a\\b', 'a//b', 'a/.env:evil', 'data./x', 'a/b ', 'a/b.', 'a/CON', 'a/nul.txt', 'x/COM1', 'x/lpt9.log', './a','a/./b', 'a\0b', '']) expect(() => u.sanitizeEntryPath(n)).toThrow();
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
      fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_KEY=secret\nAPI_PORT = "6500" # mine\n');
      expect(u.configuredPort(dir, {})).toBe(6500); // .env beats studio.config.json, like the server
      expect(u.configuredPort(dir, { API_PORT: '7000' })).toBe(7000); // the real environment beats .env
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

const shaOf = (c: string) => crypto.createHash('sha256').update(c).digest('hex');
const filesOf = (o: Record<string, string>): Files => new Map(Object.entries(o).map(([k, v]) => [k, { read: () => Buffer.from(v), mode: 0 }]));
const manifestJson = (version: string, o: Record<string, string>) => JSON.stringify({ version, files: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shaOf(v)])) });
const labelFile = (labels: Record<string, unknown>, rules: unknown = { unknownPolicy: 'avoid' }) => JSON.stringify({ version: 1, rules, labels }, null, 1) + '\n';

describe('install fixtures', () => {
  let root: string;
  const abs = (rel: string) => path.join(root, rel);
  const write = (rel: string, c: string) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), c); };
  const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');
  const exists = (rel: string) => fs.existsSync(abs(rel));
  const protectedFiles = { 'data/projects/p1/project.json': 'MY STORY', '.env': 'SECRET=1', 'studio.config.json': '{"port":1}', 'node_modules/x/index.js': 'nm', 'vendor/live2dcubismcore.min.js': 'core', 'assets/m/a.moc3': 'asset' };
  /** an install at `version` whose files are exactly `o` (+ a matching release-files.json when withManifest) */
  const install = (version: string, o: Record<string, string>, withManifest = true) => {
    const all = { 'package.json': pkgJson(version), 'dist/server/index.mjs': 'server', ...o };
    for (const [k, v] of Object.entries(all)) write(k, v);
    if (withManifest) write('release-files.json', manifestJson(version, all));
    for (const [k, v] of Object.entries(protectedFiles)) write(k, v);
  };
  const pkgFiles = (version: string, o: Record<string, string>): Files => {
    const all = { 'package.json': pkgJson(version), 'dist/server/index.mjs': 'server', ...o };
    return filesOf({ ...all, 'release-files.json': manifestJson(version, all) });
  };
  const apply = (from: string, to: string, files: Files) => u.applyPlan(root, files, u.planUpdate(root, files), { fromVersion: from, toVersion: to });
  const tmpFiles = () => (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.update-tmp'));
  const tree = () => Object.fromEntries((fs.readdirSync(root, { recursive: true }) as string[]).map((f) => f.replaceAll('\\', '/')).filter((f) => !f.startsWith('update-backup') && fs.statSync(abs(f)).isFile()).sort().map((f) => [f, read(f)]));
  const markIncomplete = (backup: string) => {
    const m = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ ...m, completed: false }));
  };

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-install-')); });
  afterEach(() => { vi.restoreAllMocks(); u.tuning.retries = 40; fs.rmSync(root, { recursive: true, force: true }); });

  it('finds the install and refuses git checkouts and strangers', () => {
    install('1.0.0', {});
    expect(u.findInstall(root).version).toBe('1.0.0');
    fs.mkdirSync(abs('.git'));
    expect(() => u.findInstall(root)).toThrow(/git/);
    fs.rmSync(abs('.git'), { recursive: true });
    write('package.json', JSON.stringify({ name: 'other', version: '1.0.0' }));
    expect(() => u.findInstall(root)).toThrow(/不是 OpeNotes/);
  });

  describe('plan: manifest-based deletion', () => {
    const oldFiles = { 'dist/web/same.js': 'same', 'dist/web/old-chunk.js': 'gone', 'docs/OLD.md': 'old doc', 'README.md': 'old readme' };
    const newFiles = { 'dist/web/same.js': 'same', 'dist/web/new-chunk.js': 'fresh', 'README.md': 'new readme' };

    it('deletes only what the previous release shipped; local extras in managed dirs stay', () => {
      install('1.0.1', oldFiles);
      write('examples/我的示例.json', 'mine');
      write('dist/web/my-plugin.js', 'mine');
      write('notes-by-user.txt', 'mine');
      const plan = u.planUpdate(root, pkgFiles('1.1.0', newFiles));
      expect(plan.remove).toEqual(['dist/web/old-chunk.js', 'docs/OLD.md']);
      expect(plan.add).toContain('dist/web/new-chunk.js');
      expect(plan.change.at(-1)).toBe('package.json'); // written last
      apply('1.0.1', '1.1.0', pkgFiles('1.1.0', newFiles));
      for (const f of ['examples/我的示例.json', 'dist/web/my-plugin.js', 'notes-by-user.txt']) expect(read(f)).toBe('mine');
      expect(exists('docs/OLD.md')).toBe(false);
      for (const [k, v] of Object.entries(protectedFiles)) expect(read(k)).toBe(v);
    });

    it('1.0.x path: no manifest means overwrite and add only, nothing is deleted', () => {
      install('1.0.0', oldFiles, false);
      expect(u.readPrevManifest(root)).toBeNull();
      const files = pkgFiles('1.1.0', newFiles);
      expect(u.planUpdate(root, files).remove).toEqual([]);
      apply('1.0.0', '1.1.0', files);
      expect(read('docs/OLD.md')).toBe('old doc');
      expect(read('README.md')).toBe('new readme');
      expect(read('dist/web/new-chunk.js')).toBe('fresh');
      expect(exists('release-files.json')).toBe(true); // from now on updates have a baseline
    });

    it('ignores protected or unsafe paths listed in a tampered manifest', () => {
      install('1.0.0', {});
      write('release-files.json', JSON.stringify({ files: { '.env': 'x', 'data/projects/p1/project.json': 'x', '../evil': 'x' } }));
      const plan = u.planUpdate(root, filesOf({ 'package.json': pkgJson('1.1.0'), 'dist/server/index.mjs': 'server' }));
      expect(plan.remove).toEqual([]);
    });
  });

  describe('backup, rollback and ordering', () => {
    it('applies, backs up, leaves protected files alone and rolls back fully', () => {
      install('1.0.0', { 'dist/web/old.js': 'old', 'README.md': 'old readme' });
      const before = tree();
      const files = pkgFiles('1.1.0', { 'dist/web/new.js': 'new', 'README.md': 'new readme', 'scripts/update.mjs': 'upd' });
      const backup = apply('1.0.0', '1.1.0', files);
      expect(read('README.md')).toBe('new readme');
      expect(fs.readFileSync(path.join(backup, 'dist/web/old.js'), 'utf8')).toBe('old');
      expect(path.basename(backup)).toMatch(/^1\.0\.0-\d{8}-\d{6}-[0-9a-f]{6}$/);
      expect(tmpFiles()).toEqual([]);
      expect(u.rollbackLatest(root)?.manifest.from).toBe('1.0.0');
      expect(tree()).toEqual(before);
      expect(u.rollbackLatest(root)).toBeNull(); // already rolled back
    });

    it('orders backups by their recorded time, not by name (1.0.9 -> 1.0.10 -> 1.0.11)', () => {
      install('1.0.9', { 'dist/web/v9.js': '9' });
      const s9 = tree();
      apply('1.0.9', '1.0.10', pkgFiles('1.0.10', { 'dist/web/v10.js': '10' }));
      const s10 = tree();
      apply('1.0.10', '1.0.11', pkgFiles('1.0.11', { 'dist/web/v11.js': '11' }));
      expect(u.rollbackLatest(root)?.manifest.from).toBe('1.0.10');
      expect(tree()).toEqual(s10);
      expect(u.rollbackLatest(root)?.manifest.from).toBe('1.0.9');
      expect(tree()).toEqual(s9);
    });

    it('refuses to roll back when the installed version is not the one the backup updated to', () => {
      install('1.0.0', {});
      apply('1.0.0', '1.1.0', pkgFiles('1.1.0', { 'dist/web/a.js': 'a' }));
      write('package.json', pkgJson('1.5.0'));
      expect(() => u.rollbackLatest(root)).toThrow(/1\.5\.0/);
      expect(read('dist/web/a.js')).toBe('a');
    });

    it('two runs in the same second get distinct backup dirs', () => {
      install('1.0.0', {});
      const a = apply('1.0.0', '1.1.0', pkgFiles('1.1.0', { 'dist/web/a.js': 'a' }));
      write('package.json', pkgJson('1.0.0'));
      const b = apply('1.0.0', '1.2.0', pkgFiles('1.2.0', { 'dist/web/a.js': 'b' }));
      expect(a).not.toBe(b);
      expect(u.listBackups(root).length).toBe(2);
    });

    it('keeps only the last 3 backups', () => {
      install('1.0.0', {});
      for (let i = 1; i <= 5; i++) apply(`1.0.${i - 1}`, `1.0.${i}`, pkgFiles(`1.0.${i}`, { 'dist/web/a.js': String(i) }));
      expect(u.listBackups(root).map((b) => b.manifest.to)).toEqual(['1.0.3', '1.0.4', '1.0.5']);
    });

    it('an interrupted run is restored first, so the original state comes back', () => {
      install('1.0.0', { 'dist/web/old.js': 'old', 'README.md': 'old readme' });
      const original = tree();
      const backup = apply('1.0.0', '1.1.0', pkgFiles('1.1.0', { 'dist/web/new.js': 'new', 'README.md': 'new readme' }));
      markIncomplete(backup); // as if killed before the last step: package.json still old
      write('package.json', pkgJson('1.0.0'));
      expect(u.recoverIncomplete(root).map((r) => r.action)).toEqual(['restored']);
      expect(tree()).toEqual(original);
      expect(u.recoverIncomplete(root)).toEqual([]);
    });

    it('an interrupted run whose package.json was already written is marked finished, not undone', () => {
      install('1.0.0', {});
      markIncomplete(apply('1.0.0', '1.1.0', pkgFiles('1.1.0', { 'dist/web/a.js': 'a' })));
      expect(u.recoverIncomplete(root).map((r) => r.action)).toEqual(['finished']);
      expect(read('dist/web/a.js')).toBe('a');
      expect(u.rollbackLatest(root)?.manifest.from).toBe('1.0.0'); // now a normal rollback-able update
    });
  });

  describe('locked files (EPERM)', () => {
    const failRename = (suffix: string, times: () => boolean, code: string) => {
      const real = fs.renameSync.bind(fs);
      return vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
        if (String(b).replaceAll('\\', '/').endsWith(suffix) && times()) throw Object.assign(new Error(`${code}: locked`), { code });
        return real(a, b);
      });
    };
    const next = () => filesOf({ 'package.json': pkgJson('1.1.0'), 'dist/server/index.mjs': 'new-server', 'dist/web/new.js': 'new' });

    it('retries a briefly locked file and succeeds', () => {
      install('1.0.0', {});
      let n = 0;
      failRename('dist/server/index.mjs', () => n++ < 3, 'EBUSY');
      apply('1.0.0', '1.1.0', next());
      expect(read('dist/server/index.mjs')).toBe('new-server');
      expect(n).toBe(4);
    });

    it('a file that stays locked: original error kept, failures listed, no .update-tmp left, recovery works after unlock', () => {
      install('1.0.0', { 'dist/web/old.js': 'old' });
      const original = tree();
      u.tuning.retries = 1;
      let locked = true;
      failRename('dist/server/index.mjs', () => locked, 'EPERM');
      let err: Error | undefined;
      try { apply('1.0.0', '1.1.0', next()); } catch (e) { err = e as Error; }
      expect(err?.message).toMatch(/EPERM/);
      expect(err?.message).toMatch(/dist\/server\/index\.mjs/);
      expect(err?.message).toMatch(/--rollback/);
      expect(tmpFiles()).toEqual([]);
      locked = false;
      expect(u.recoverIncomplete(root).map((r) => r.action)).toEqual(['restored']);
      expect(tree()).toEqual(original);
    });

    it('a successful auto-restore says so', () => {
      install('1.0.0', {});
      const files = next();
      files.set('dist/web/new.js', { mode: 0, read: () => { throw new Error('boom'); } });
      expect(() => apply('1.0.0', '1.1.0', files)).toThrow(/boom[\s\S]*已自动还原/);
      expect(read('dist/server/index.mjs')).toBe('server');
    });
  });

  describe('case-only rename', () => {
    for (const withManifest of [true, false]) {
      it(`keeps the file under its new name (${withManifest ? 'with' : 'without'} manifest)`, () => {
        install('1.0.0', { 'docs/GUIDE.md': 'guide' }, withManifest);
        apply('1.0.0', '1.1.0', pkgFiles('1.1.0', { 'docs/guide.md': 'guide' }));
        expect(fs.readdirSync(abs('docs'))).toEqual(['guide.md']);
        expect(read('docs/guide.md')).toBe('guide');
        u.rollbackLatest(root);
        expect(fs.readdirSync(abs('docs'))).toEqual(['GUIDE.md']);
      });
    }
  });

  describe('asset-labels merge', () => {
    const L = 'asset-labels/backgrounds.json';
    const entry = (title: string, source = 'draft', updatedAt?: string) => ({ title, source, ...(updatedAt ? { updatedAt } : {}) });
    const shipped = labelFile({ 1: entry('a'), 2: entry('b'), 3: entry('c') });

    it('mergeLabels: newer user edits stay, older ones are overridden and listed, drafts follow the package, differing rules stay', () => {
      const local = labelFile({ 1: entry('mine1', 'user', '2026-10-02'), 2: entry('mine2', 'user', '2026-09-01'), 3: entry('draft-edit', 'draft'), 9: entry('only-mine', 'user', '2026-10-01') }, { unknownPolicy: 'allow' });
      const pkg = labelFile({ 1: entry('a2', 'draft', '2026-10-01'), 2: entry('b2', 'draft', '2026-09-15'), 3: entry('c2'), 4: entry('new') });
      const m = u.mergeLabels(Buffer.from(local), Buffer.from(pkg))!;
      const out = JSON.parse(m.buf.toString());
      expect(out.labels['1'].title).toBe('mine1');
      expect(out.labels['2'].title).toBe('b2');
      expect(out.labels['3'].title).toBe('c2');
      expect(out.labels['4'].title).toBe('new');
      expect(out.labels['9'].title).toBe('only-mine');
      expect(out.rules.unknownPolicy).toBe('allow');
      expect(m.kept.sort()).toEqual(['1', '9']);
      expect(m.overridden).toEqual(['2']);
      expect(m.rulesKept).toBe(true);
      expect(u.mergeLabels(Buffer.from('not json'), Buffer.from(pkg))).toBeNull();
    });

    it('a local file that matches the previous release is simply overwritten', () => {
      install('1.0.1', { [L]: shipped });
      const next = labelFile({ 1: entry('a'), 2: entry('b2'), 3: entry('c') });
      const files = pkgFiles('1.1.0', { [L]: next });
      expect(u.planUpdate(root, files).labels).toBeNull();
      apply('1.0.1', '1.1.0', files);
      expect(read(L)).toBe(next);
    });

    it('an edited local file is merged, and the old file is backed up', () => {
      install('1.0.1', { [L]: shipped });
      const edited = labelFile({ 1: entry('a'), 2: entry('my-b', 'user', '2026-10-20'), 3: entry('c') });
      write(L, edited);
      const files = pkgFiles('1.1.0', { [L]: labelFile({ 1: entry('a'), 2: entry('b2'), 3: entry('c3'), 4: entry('d') }) });
      expect(u.planUpdate(root, files).labels?.kept).toEqual(['2']);
      const backup = apply('1.0.1', '1.1.0', files);
      const out = JSON.parse(read(L));
      expect(out.labels['2'].title).toBe('my-b');
      expect(out.labels['3'].title).toBe('c3');
      expect(out.labels['4'].title).toBe('d');
      expect(fs.readFileSync(path.join(backup, L), 'utf8')).toBe(edited);
    });

    it('1.0.x (no manifest) always merges', () => {
      install('1.0.0', { [L]: shipped }, false);
      write(L, labelFile({ 1: entry('a'), 2: entry('my-b', 'user', '2026-10-20'), 3: entry('c') }));
      apply('1.0.0', '1.1.0', pkgFiles('1.1.0', { [L]: labelFile({ 1: entry('a'), 2: entry('b2'), 3: entry('c') }) }));
      expect(JSON.parse(read(L)).labels['2'].title).toBe('my-b');
    });
  });

  describe('main()', () => {
    it('updates an install in a path with spaces and Chinese, rejects unknown arguments, recovers an interrupted run, rolls back', async () => {
      const outer = root;
      const dir = path.join(outer, '安装 目录 测试');
      fs.mkdirSync(dir);
      root = dir;
      install('1.0.0', { 'dist/web/old.js': 'old' });
      const original = tree();
      const zipPath = path.join(outer, '发布包 1.1.0.zip');
      fs.writeFileSync(zipPath, await makeZip(top('1.1.0', { 'package.json': pkgJson('1.1.0'), 'dist/server/index.mjs': 'new-server', 'CHANGELOG.md': '# Changelog\n\n## 1.1.0\n\nnew stuff\n' })));
      const savedPort = process.env.API_PORT;
      process.env.API_PORT = '59871'; // nothing listens here
      try {
        await expect(u.main([dir, '--rolbak'])).rejects.toThrow(/不认识的参数/);
        await expect(u.main([dir, 'extra', '--check'])).rejects.toThrow(/多余的参数/);
        expect(await u.main([dir, '--from-zip', zipPath, '--check'])).toBe(0);
        expect(read('dist/server/index.mjs')).toBe('server');
        // a first run that got killed half-way ...
        const backup = u.applyPlan(dir, filesOf({ 'package.json': pkgJson('1.1.0'), 'dist/server/index.mjs': 'half' }), u.planUpdate(dir, filesOf({ 'package.json': pkgJson('1.1.0'), 'dist/server/index.mjs': 'half' })), { fromVersion: '1.0.0', toVersion: '1.1.0' });
        markIncomplete(backup);
        write('package.json', pkgJson('1.0.0'));
        // ... then the real update runs: it restores first, then updates
        expect(await u.main([dir, '--from-zip', zipPath, '--yes'])).toBe(0);
        expect(read('dist/server/index.mjs')).toBe('new-server');
        expect(await u.main([dir, '--from-zip', zipPath, '--yes'])).toBe(0); // up to date
        expect(await u.main([dir, '--rollback'])).toBe(0); // one rollback is enough
        expect(tree()).toEqual(original);
        await expect(u.main([dir, '--rollback'])).rejects.toThrow(/没有可还原/);
      } finally {
        if (savedPort === undefined) delete process.env.API_PORT; else process.env.API_PORT = savedPort;
        root = outer;
      }
    });
  });
});
