import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../server/assets/indexer';
import { applyPlan } from '../../server/assets/import/apply';
import { buildPlan } from '../../server/assets/import/plan';
import { ZipSafetyError, extractZip } from '../../server/assets/import/zip';
import { buildZip } from './helpers/zipBuilder';
import { writePng, writeSitePackage } from './helpers/sitePackage';

let tmp: string;
let pkg: string;
let lib: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ons-import-'));
  pkg = path.join(tmp, 'pkg');
  lib = path.join(tmp, 'lib');
  await fs.mkdir(pkg);
  await fs.mkdir(lib);
});
afterEach(() => fs.rm(tmp, { recursive: true, force: true }));

const plan = (root = pkg, ids?: Record<string, string>) =>
  buildPlan(root, 'p1', root, { assetRoot: lib, labelled: new Set(['adv_bkg_stage_000001']), cardNames: new Map([['bg_fake_01', '1']]), ...(ids ? { ids } : {}) });

describe('import plan', () => {
  it('normalizes a site-style package, recognises backgrounds and imports with the right motion count', async () => {
    await writeSitePackage(pkg, '001_casual_spring_01', 5);
    await writePng(path.join(pkg, 'bgs', 'adv_bkg_stage_000001.png'));
    await writePng(path.join(pkg, 'bgs', 'bg_fake_01.png'));
    await writePng(path.join(pkg, 'bgs', 'mystery.png'));
    const prepared = await plan();
    const m = prepared.plan.models[0]!;
    expect(m).toMatchObject({ id: '001_casual_spring_01', status: 'new', normalized: true, motions: 5, expressions: 1, textures: 2, mocVersion: 5 });
    const bgs = Object.fromEntries(prepared.plan.backgrounds.map((b) => [b.src, b]));
    expect(bgs['bgs/adv_bkg_stage_000001.png']).toMatchObject({ id: 'adv_bkg_stage_000001', status: 'new', labelled: true });
    expect(bgs['bgs/bg_fake_01.png']).toMatchObject({ id: '1', status: 'new' });
    expect(bgs['bgs/mystery.png']!.status).toBe('unrecognized');
    expect(prepared.plan.skipped.some((s) => s.path === 'bgs/mystery.png')).toBe(true);
    expect(prepared.plan.fileCount).toBeGreaterThan(5);

    const report = await applyPlan(prepared, lib, { overwrite: false });
    expect(report.imported.models).toEqual(['001_casual_spring_01']);
    expect(report.imported.backgrounds.sort()).toEqual(['1', 'adv_bkg_stage_000001']);
    expect(report.totals.motions).toBe(5);
    // originals untouched
    expect(JSON.parse(await fs.readFile(path.join(pkg, 'live2d', '001_casual_spring_01', 'model3.json'), 'utf8')).FileReferences.Motions.Motion).toHaveLength(5);
    // the indexer sees every motion (the site format would have yielded exactly one)
    const cat = await buildCatalog({ assetRoot: lib });
    const entry = cat.models.find((x) => x.id === '001_casual_spring_01')!;
    expect(entry.motions).toHaveLength(5);
    expect(entry.expressions).toHaveLength(1);
    expect(cat.backgrounds.map((b) => b.id).sort()).toEqual(['1', 'adv_bkg_stage_000001']);
    expect(cat.warnings.filter((w) => w.includes('001_casual_spring_01'))).toEqual([]);
    await expect(fs.access(path.join(lib, '.import-tmp'))).rejects.toThrow();
  });

  it('skips identical content on a second import and flags changed content as a conflict', async () => {
    await writeSitePackage(pkg);
    await writePng(path.join(pkg, 'adv_bkg_stage_000002.png'));
    await applyPlan(await plan(), lib, { overwrite: false });
    const again = await plan();
    expect(again.plan.models[0]!.status).toBe('duplicate');
    expect(again.plan.backgrounds[0]!.status).toBe('duplicate');
    expect(again.plan.fileCount).toBe(0);
    const rep = await applyPlan(again, lib, { overwrite: false });
    expect(rep.imported.models).toEqual([]);
    expect(rep.skipped).toHaveLength(2);

    await fs.writeFile(path.join(pkg, 'live2d', '001_casual_spring_01', 'physics3.json'), '{"Version":3,"changed":true}');
    const changed = await plan();
    expect(changed.plan.models[0]!.status).toBe('conflict');
    const skip = await applyPlan(changed, lib, { overwrite: false });
    expect(skip.imported.models).toEqual([]);
    expect(await fs.readFile(path.join(lib, 'models', '001_casual_spring_01', 'physics3.json'), 'utf8')).toBe('{"Version":3}');
    const over = await applyPlan(await plan(), lib, { overwrite: true });
    expect(over.imported.models).toEqual(['001_casual_spring_01']);
    expect(await fs.readFile(path.join(lib, 'models', '001_casual_spring_01', 'physics3.json'), 'utf8')).toContain('changed');
  });

  it('reports a model with a missing texture as an error and does not write it', async () => {
    await writeSitePackage(pkg);
    await fs.rm(path.join(pkg, 'unity'), { recursive: true });
    const prepared = await plan();
    expect(prepared.plan.models[0]!.status).toBe('error');
    expect(prepared.plan.errors[0]!.message).toContain('找不到纹理');
    const rep = await applyPlan(prepared, lib, { overwrite: false });
    expect(rep.imported.models).toEqual([]);
    expect(await fs.readdir(path.join(lib, 'models'))).toEqual([]);
  });

  it('rejects a moc file without the MOC3 header', async () => {
    await writeSitePackage(pkg);
    await fs.writeFile(path.join(pkg, 'live2d', '001_casual_spring_01', 'model.moc3'), 'not a moc');
    expect((await plan()).plan.models[0]!.errors[0]).toContain('MOC3');
  });

  it('lets the user supply ids for unrecognised backgrounds and models', async () => {
    await writeSitePackage(pkg, 'weird');
    await writePng(path.join(pkg, 'x', 'mystery.png'));
    const p = await plan(pkg, { 'x/mystery.png': 'adv_bkg_stage_000777', 'live2d/weird/model3.json': '002_casual_spring_01' });
    expect(p.plan.backgrounds[0]).toMatchObject({ id: 'adv_bkg_stage_000777', status: 'new' });
    expect(p.plan.models[0]).toMatchObject({ id: '002_casual_spring_01', idGuessed: false });
  });

  it('warns when the model id cannot be derived from the package', async () => {
    await writeSitePackage(pkg, 'model');
    expect((await plan()).plan.models[0]!.warnings.join('')).toContain('无法从目录名识别模型 id');
  });
});

describe('zip extraction', () => {
  const zipAt = async (entries: Parameters<typeof buildZip>[0]) => {
    const f = path.join(tmp, 'a.zip');
    await fs.writeFile(f, buildZip(entries));
    return f;
  };

  it('extracts a plain archive', async () => {
    const r = await extractZip(await zipAt([{ name: 'a/b.txt', data: 'hi' }, { name: 'a/' }]), path.join(tmp, 'out'));
    expect(r.files).toBe(1);
    expect(await fs.readFile(path.join(tmp, 'out', 'a', 'b.txt'), 'utf8')).toBe('hi');
  });

  it.each([['../evil.txt'], ['a/../../evil.txt'], ['/abs.txt'], ['C:/win.txt']])('rejects zip-slip entry %s', async (name) => {
    await expect(extractZip(await zipAt([{ name, data: 'x' }]), path.join(tmp, 'out'))).rejects.toThrow(ZipSafetyError);
    await expect(fs.access(path.join(tmp, 'evil.txt'))).rejects.toThrow();
  });

  it('skips symlink entries', async () => {
    const r = await extractZip(await zipAt([{ name: 'link', data: '/etc/passwd', symlink: true }, { name: 'ok.txt', data: 'x' }]), path.join(tmp, 'out'));
    expect(r.skipped).toEqual([{ path: 'link', reason: '符号链接，已跳过' }]);
    await expect(fs.access(path.join(tmp, 'out', 'link'))).rejects.toThrow();
  });

  it('enforces size, entry-count and case-collision limits', async () => {
    const big = await zipAt([{ name: 'a.bin', data: Buffer.alloc(5000) }]);
    await expect(extractZip(big, path.join(tmp, 'o1'), { maxBytes: 1000, maxEntries: 10, maxPathLength: 240 })).rejects.toThrow(/上限/);
    const many = await zipAt([{ name: 'a', data: 'x' }, { name: 'b', data: 'x' }, { name: 'c', data: 'x' }]);
    await expect(extractZip(many, path.join(tmp, 'o2'), { maxBytes: 1e6, maxEntries: 2, maxPathLength: 240 })).rejects.toThrow(/条目数/);
    const dup = await zipAt([{ name: 'A.txt', data: 'x' }, { name: 'a.TXT', data: 'y' }]);
    await expect(extractZip(dup, path.join(tmp, 'o3'))).rejects.toThrow(/大小写/);
  });

  it('imports a zipped site package end to end', async () => {
    const src = path.join(tmp, 'src');
    await writeSitePackage(src);
    const entries: Parameters<typeof buildZip>[0] = [];
    const walk = async (d: string) => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const abs = path.join(d, e.name);
        if (e.isDirectory()) await walk(abs);
        else entries.push({ name: path.relative(src, abs).split(path.sep).join('/'), data: await fs.readFile(abs) });
      }
    };
    await walk(src);
    const f = path.join(tmp, 'site.zip');
    await fs.writeFile(f, buildZip(entries));
    const out = path.join(tmp, 'extracted');
    await extractZip(f, out);
    const prepared = await plan(out);
    expect(prepared.plan.models[0]).toMatchObject({ status: 'new', motions: 4 });
  });
});
