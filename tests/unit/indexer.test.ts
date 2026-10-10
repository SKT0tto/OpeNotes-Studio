import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog, mapPool, readPngSize } from '../../server/assets/indexer';
import { CatalogSchema } from '../../shared/schema/assets';

const FIXTURE = path.resolve('tests/fixtures/fake-assets');
let tmp: string;
let assets: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-idx-'));
  assets = path.join(tmp, 'assets');
  await fs.cp(FIXTURE, assets, { recursive: true });
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('buildCatalog (fixture library)', () => {
  it('indexes models from model3.json and validates against the schema', async () => {
    const cat = await buildCatalog({ assetRoot: assets });
    expect(() => CatalogSchema.parse(cat)).not.toThrow();
    expect(cat.models.map((m) => m.id)).toEqual([
      '001_casual_spring_01', '001_live-mode_live_01', '002_casual_spring_01_glasses_low', 'sub_bota_casual_spring_01_still',
    ]);
  });

  it('handles irregular motion names, missing files and optional parts', async () => {
    const cat = await buildCatalog({ assetRoot: assets });
    const byId = new Map(cat.models.map((m) => [m.id, m]));

    const main = byId.get('001_casual_spring_01')!;
    expect(main.hasPhysics).toBe(true);
    expect(main.expressions.map((e) => e.name)).toEqual(['exp_smile01', 'exp_bsmile02']);
    const names = main.motions.map((m) => m.name);
    expect(names).toContain('mtn_haruhikage01_C%20');
    const spaced = main.motions.find((m) => m.name === 'mtn_haruhikage01_C%20')!;
    expect(spaced.file).toBe('motions/mtn_haruhikage01_C .motion3.json');
    expect(spaced).toMatchObject({ family: 'haruhikage01', side: 'C' });
    expect(spaced.stats?.angleX?.first).toBe(1);
    expect(main.motions.find((m) => m.name === 'mtn_check01_R2')).toMatchObject({ family: 'check01', side: 'R', variant: '2' });
    expect(main.motions.find((m) => m.name === 'misc_tear01')).toMatchObject({ side: null });
    // a motion whose file is absent keeps its entry with null stats and is reported
    expect(main.motions.find((m) => m.name === 'mtn_ghost01_C')?.stats).toBeNull();
    expect(main.missingFiles).toEqual(['motions/does_not_exist.motion3.json']);
    expect(main.preview).toBe('/assets/models/001_casual_spring_01/preview.png');

    const L = main.motions.find((m) => m.name === 'mtn_idle01_L')!.stats!;
    const R = main.motions.find((m) => m.name === 'mtn_idle01_R')!.stats!;
    expect(L.angleX!.mean).toBeGreaterThan(15);
    expect(R.angleX!.mean).toBeLessThan(-15);

    const live = byId.get('001_live-mode_live_01')!;
    expect(live).toMatchObject({ mode: 'live', hasPhysics: false, quality: '' });
    expect(live.expressions).toEqual([]);

    const low = byId.get('002_casual_spring_01_glasses_low')!;
    expect(low).toMatchObject({ quality: 'low', preview: null });
    expect(low.costumeInfo.glasses).toBe(true);
    expect(low.missingFiles).toContain('physics3.json');
    expect(cat.warnings.some((w) => w.includes('002_casual_spring_01_glasses_low'))).toBe(true);

    const still = byId.get('sub_bota_casual_spring_01_still')!;
    expect(still).toMatchObject({ isSub: true, still: true, characterKey: 'sub_bota' });
    expect(still.motions).toHaveLength(1);
  });

  it('merges the manifest and builds characters and bands', async () => {
    const cat = await buildCatalog({ assetRoot: assets });
    const tomori = cat.characters.find((c) => c.key === '001')!;
    expect(tomori).toMatchObject({ name: '高松灯', bandName: 'MyGO!!!!!', role: 'Vo.', color: '#77BBDD', isSub: false });
    expect(tomori.modelIds).toEqual(['001_casual_spring_01', '001_live-mode_live_01']);
    expect(cat.characters.find((c) => c.key === 'sub_bota')).toMatchObject({ bandName: '配角 / NPC', isSub: true, name: 'bota' });
    expect(cat.bands).toHaveLength(5);

    const bg = cat.backgrounds.find((b) => b.id === '1')!;
    expect(bg).toMatchObject({ name: 'RiNG 咖啡厅 · 夜间', time: '夜间', width: 2048, height: 1119 });
    const plain = cat.backgrounds.find((b) => b.id === '2')!;
    expect(plain).toMatchObject({ name: '2', kind: null, width: 1600, height: 900 });
    expect(cat.backgrounds).toHaveLength(2);
  });

  it('works without a manifest', async () => {
    const bare = path.join(tmp, 'bare');
    await fs.cp(assets, bare, { recursive: true });
    await fs.rm(path.join(bare, 'manifest.json'));
    const cat = await buildCatalog({ assetRoot: bare });
    expect(cat.models).toHaveLength(4);
    expect(cat.characters.find((c) => c.key === '001')).toMatchObject({ name: '高松灯', color: null });
    expect(cat.characters.find((c) => c.key === 'sub_bota')?.name).toBe('bota');
    expect(cat.backgrounds[0]?.name).toBe('1');
  });

  it('indexes media and extra audio roots', async () => {
    const extra = path.join(tmp, 'extra-audio');
    await fs.mkdir(path.join(extra, 'nested'), { recursive: true });
    await fs.writeFile(path.join(extra, 'nested', 'bgm 1.ogg'), 'x');
    await fs.writeFile(path.join(extra, 'notes.txt'), 'x');
    const cat = await buildCatalog({ assetRoot: assets, audioRoots: [extra] });
    expect(cat.audio.map((a) => a.id)).toEqual(['media/sub/jingle.mp3', 'media/test-song.wav', 'user0/nested/bgm 1.ogg']);
    expect(cat.audio.at(-1)).toMatchObject({ source: 'user', url: '/audio/0/nested/bgm%201.ogg', ext: 'ogg' });
    expect(cat.audio[0]).toMatchObject({ source: 'media', url: '/assets/media/sub/jingle.mp3' });
  });

  it('reports an empty library with warnings instead of throwing', async () => {
    const cat = await buildCatalog({ assetRoot: path.join(tmp, 'does-not-exist') });
    expect(cat.models).toEqual([]);
    expect(cat.backgrounds).toEqual([]);
  });
});

describe('index cache', () => {
  it('reuses unchanged models, re-reads changed ones, and keeps a stable version', async () => {
    const cacheFile = path.join(tmp, 'cache', 'catalog.json');
    const first = await buildCatalog({ assetRoot: assets, cacheFile });
    const logs: string[] = [];
    const second = await buildCatalog({ assetRoot: assets, cacheFile, log: (m) => logs.push(m) });
    expect(logs.join()).toContain('4 cached');
    expect(second.version).toBe(first.version);
    expect(second.models).toEqual(first.models);

    // adding a motion changes the motions dir mtime and model3.json size -> only that model is rebuilt
    const m3 = path.join(assets, 'models', 'sub_bota_casual_spring_01_still');
    const json = JSON.parse(await fs.readFile(path.join(m3, 'model3.json'), 'utf8'));
    json.FileReferences.Motions['mtn_new01_C'] = [{ File: 'motions/mtn_idle01_C.motion3.json' }];
    await fs.writeFile(path.join(m3, 'model3.json'), JSON.stringify(json));
    const logs3: string[] = [];
    const third = await buildCatalog({ assetRoot: assets, cacheFile, log: (m) => logs3.push(m) });
    expect(logs3.join()).toContain('3 cached');
    expect(third.version).not.toBe(first.version);
    expect(third.models.find((m) => m.id.startsWith('sub_bota'))?.motions).toHaveLength(2);
  });
});

describe('helpers', () => {
  it('mapPool preserves order and bounds concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('readPngSize reads IHDR and rejects non-PNG', async () => {
    expect(await readPngSize(path.join(assets, 'backgrounds', '1.png'))).toEqual({ width: 2048, height: 1119 });
    expect(await readPngSize(path.join(assets, 'backgrounds', 'readme.txt'))).toEqual({ width: null, height: null });
    expect(await readPngSize(path.join(assets, 'nope.png'))).toEqual({ width: null, height: null });
  });
});
