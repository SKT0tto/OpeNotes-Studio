import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../server/assets/indexer';
import { loadConfig } from '../../server/config';
import type { Catalog } from '../../shared/schema/assets';

const config = loadConfig();
const available = fs.existsSync(path.join(config.assetRoot, 'models'));

describe.skipIf(!available)('motion facing statistics (real assets)', () => {
  let cat: Catalog;
  beforeAll(async () => {
    cat = await buildCatalog({ assetRoot: config.assetRoot, audioRoots: config.audioRoots });
  });

  it.each(['001', '002', '003', '004', '005'].map((k) => `${k}_casual_spring_01`))('%s: _L and _R idle have opposite nominal angles', (id) => {
    const m = cat.models.find((x) => x.id === id)!;
    const l = m.motions.find((x) => x.family === 'idle01' && x.side === 'L')?.stats?.angleX?.mean;
    const r = m.motions.find((x) => x.family === 'idle01' && x.side === 'R')?.stats?.angleX?.mean;
    expect(l).toBeGreaterThan(15);
    expect(r).toBeLessThan(-15);
  });
});
