import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../server/assets/indexer';
import { loadConfig } from '../../server/config';
import type { Catalog } from '../../shared/schema/assets';

const config = loadConfig();
const available = fs.existsSync(path.join(config.assetRoot, 'models'));
if (!available) console.warn(`[integration] skipped: ASSET_ROOT not readable (${config.assetRoot})`);

describe.skipIf(!available)('real asset library', () => {
  let cat: Catalog;
  beforeAll(async () => {
    const t0 = Date.now();
    cat = await buildCatalog({ assetRoot: config.assetRoot, audioRoots: config.audioRoots });
    console.log(`[integration] full index in ${Date.now() - t0} ms`);
  });

  it('has the expected counts', () => {
    expect(cat.models).toHaveLength(241);
    expect(cat.backgrounds).toHaveLength(341);
    expect(cat.audio.length).toBeGreaterThanOrEqual(1);
    expect(cat.models.filter((m) => m.quality === 'low')).toHaveLength(26);
    expect(cat.models.filter((m) => m.mode === 'live')).toHaveLength(52);
    expect(cat.models.filter((m) => !m.hasPhysics)).toHaveLength(58);
    expect(cat.models.filter((m) => m.isSub)).toHaveLength(39);
  });

  it('every model has motions and a preview, and no missing referenced files', () => {
    for (const m of cat.models) {
      expect(m.motions.length, m.id).toBeGreaterThan(0);
      expect(m.preview, m.id).not.toBeNull();
      expect(m.missingFiles, m.id).toEqual([]);
    }
  });

  it('resolves 25 band members plus NPC characters from model ids', () => {
    const members = cat.characters.filter((c) => !c.isSub);
    expect(members.map((c) => c.key)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(3, '0')));
    for (const c of members) expect(c.bandKey, c.key).not.toBeNull();
    const npcs = cat.characters.filter((c) => c.isSub);
    expect(npcs.length).toBeGreaterThanOrEqual(20);
    for (const c of npcs) expect(c.bandName).toBe('配角 / NPC');
  });

  it('live-mode models have play motions and no expressions', () => {
    const live = cat.models.find((m) => m.id === '001_live-mode_live_01')!;
    expect(live.mode).toBe('live');
    expect(live.expressions).toHaveLength(0);
    expect(live.motions.map((m) => m.name)).toContain('mtn_play01_01');
  });

  it('motion variants _L/_R carry opposite nominal head angles', () => {
    const m = cat.models.find((x) => x.id === '001_casual_spring_01')!;
    const idle = (n: string) => m.motions.find((x) => x.name === n)!.stats!;
    expect(idle('mtn_idle01_L').angleX!.first).toBeGreaterThan(15);
    expect(idle('mtn_idle01_L').angleX!.mean).toBeGreaterThan(15);
    expect(idle('mtn_idle01_R').angleX!.mean).toBeLessThan(-15);
    expect(Math.abs(idle('mtn_idle01_C').angleX!.mean)).toBeLessThan(5);
  });

  it('keeps irregular motion names intact', () => {
    const m = cat.models.find((x) => x.id === '004_casual_spring_01')!;
    const spaced = m.motions.find((x) => x.name === 'mtn_haruhikage01_C%20')!;
    expect(spaced.file).toBe('motions/mtn_haruhikage01_C .motion3.json');
    expect(spaced.stats).not.toBeNull();
  });

  it('background metadata is merged from the manifest and matches RiNG night search', () => {
    const ring = cat.backgrounds.filter((b) => b.name.includes('RiNG'));
    expect(ring.length).toBeGreaterThan(0);
    expect(cat.backgrounds.every((b) => b.width && b.height)).toBe(true);
  });
});
