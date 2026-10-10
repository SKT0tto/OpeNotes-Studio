import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../server/assets/indexer';
import { applyPlan } from '../../server/assets/import/apply';
import { buildPlan } from '../../server/assets/import/plan';
import { extractZip } from '../../server/assets/import/zip';
import { writePackZip } from '../../server/assets/pack';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ons-pack-'));
});
afterEach(() => fs.rm(tmp, { recursive: true, force: true }));

async function makePack() {
  const lib = path.join(tmp, 'lib');
  await fs.cp(path.resolve('tests/fixtures/fake-assets'), lib, { recursive: true });
  for (const id of await fs.readdir(path.join(lib, 'models'))) await fs.writeFile(path.join(lib, 'models', id, 'model.moc3'), Buffer.concat([Buffer.from('MOC3'), Buffer.from([5, 0, 0, 0])]));
  const zip = path.join(tmp, 'pack.zip');
  const pack = await writePackZip(lib, zip);
  return { lib, zip, pack };
}

describe('asset pack (native layout)', () => {
  it('describes the library and round-trips through the importer without normalisation', async () => {
    const { zip, pack } = await makePack();
    expect(pack).toMatchObject({ format: 'openotes-pack', version: 1, counts: { models: 4, backgrounds: 2, media: 2 } });
    expect(pack.files!.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);

    const out = path.join(tmp, 'x');
    await extractZip(zip, out);
    const target = path.join(tmp, 'target');
    const prepared = await buildPlan(out, 'p', zip, { assetRoot: target });
    expect(prepared.plan.pack).toMatchObject({ problems: [], verified: pack.files!.length });
    expect(prepared.plan.models.map((m) => m.status)).toEqual(['new', 'new', 'new', 'new']);
    expect(prepared.plan.models.every((m) => !m.normalized)).toBe(true);
    expect(prepared.plan.media).toMatchObject({ files: 2, new: 2 });
    expect(prepared.plan.manifest).toBe('new');

    const progress: string[] = [];
    const report = await applyPlan(prepared, target, { overwrite: false, onProgress: (p) => progress.push(p.phase) });
    expect(report.totals).toMatchObject({ models: 4, backgrounds: 2, media: 2 });
    expect(report.manifest).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    const a = await buildCatalog({ assetRoot: target });
    expect(a.models).toHaveLength(4);
    await fs.access(path.join(target, 'media', 'test-song.wav'));
    await fs.access(path.join(target, 'manifest.json'));

    // second import: everything is a duplicate
    const again = await buildPlan(out, 'p2', zip, { assetRoot: target });
    expect(again.plan.fileCount).toBe(0);
  });

  it('also works when the pack is wrapped in one top-level directory', async () => {
    const { zip } = await makePack();
    const out = path.join(tmp, 'x');
    await extractZip(zip, out);
    const wrapped = path.join(tmp, 'w');
    await fs.mkdir(wrapped);
    await fs.rename(out, path.join(wrapped, 'openotes-assets'));
    const prepared = await buildPlan(wrapped, 'p', 'w', { assetRoot: path.join(tmp, 'target') });
    expect(prepared.plan.pack?.problems).toEqual([]);
    expect(prepared.plan.models).toHaveLength(4);
    expect(prepared.plan.media?.files).toBe(2);
  });

  it('flags a corrupted or missing file listed in openotes-pack.json', async () => {
    const { zip } = await makePack();
    const out = path.join(tmp, 'x');
    await extractZip(zip, out);
    await fs.appendFile(path.join(out, 'backgrounds', '1.png'), 'tamper');
    await fs.rm(path.join(out, 'media', 'test-song.wav'));
    const prepared = await buildPlan(out, 'p', zip, { assetRoot: path.join(tmp, 'target') });
    const problems = prepared.plan.pack!.problems.join('\n');
    expect(problems).toContain('backgrounds/1.png');
    expect(problems).toContain('media/test-song.wav');
    expect(prepared.plan.errors.some((e) => e.path === 'openotes-pack.json')).toBe(true);
  });

  it('rejects a malformed pack description', async () => {
    const { zip } = await makePack();
    const out = path.join(tmp, 'x');
    await extractZip(zip, out);
    await fs.writeFile(path.join(out, 'openotes-pack.json'), '{"format":"nope"}');
    expect((await buildPlan(out, 'p', zip, { assetRoot: path.join(tmp, 't') })).plan.pack!.problems[0]).toContain('格式不正确');
  });

  it('cancelling stops extraction', async () => {
    const { zip } = await makePack();
    const ac = new AbortController();
    ac.abort();
    await expect(extractZip(zip, path.join(tmp, 'c'), undefined, { signal: ac.signal })).rejects.toThrow('已取消');
  });
});
