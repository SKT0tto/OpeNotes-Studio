import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../server/assets/indexer';
import { loadConfig } from '../../server/config';
import type { Catalog } from '../../shared/schema/assets';
import { ProjectSchema } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import type { CompileContext } from '../../shared/timeline/types';
import demo from '../fixtures/demo-project.json';
import { fakeCalibration } from '../unit/helpers/synthetic';

const config = loadConfig();
const available = fs.existsSync(path.join(config.assetRoot, 'models'));

describe.skipIf(!available)('demo project against the real catalog', () => {
  const project = ProjectSchema.parse(demo);
  let cat: Catalog;
  beforeAll(async () => {
    cat = await buildCatalog({ assetRoot: config.assetRoot, audioRoots: config.audioRoots });
  });

  const modelIds = () => {
    const ids = new Set<string>();
    for (const s of project.scenes) {
      Object.values(s.wardrobe).forEach((w) => ids.add(w.modelId));
      for (const t of s.tracks) if (t.channel === 'costume') t.keys.forEach((k) => ids.add(k.value.modelId));
    }
    return [...ids];
  };

  it('only references models, backgrounds and audio that exist in the library', () => {
    for (const id of modelIds()) expect(cat.models.some((m) => m.id === id), `model ${id}`).toBe(true);
    for (const s of project.scenes) {
      expect(cat.backgrounds.some((b) => b.id === s.background.assetId), `background ${s.background.assetId}`).toBe(true);
      if (s.audio.bgm && cat.audio.length > 0) expect(cat.audio.some((a) => a.id === s.audio.bgm!.assetId), `audio ${s.audio.bgm.assetId}`).toBe(true);
    }
    for (const c of project.cast) expect(cat.characters.some((x) => x.key === c.characterKey)).toBe(true);
  });

  it('compiles with every motion family and expression resolving on the real models (no warnings)', () => {
    const ctx: CompileContext = { models: {}, calibrations: {}, backgrounds: {} };
    for (const id of modelIds()) {
      const m = cat.models.find((x) => x.id === id)!;
      ctx.models[id] = { motions: m.motions, expressions: m.expressions.map((e) => e.name) };
      ctx.calibrations[id] = fakeCalibration(id);
    }
    for (const s of project.scenes) {
      const b = cat.backgrounds.find((x) => x.id === s.background.assetId)!;
      ctx.backgrounds[b.id] = { width: b.width ?? 2048, height: b.height ?? 1119, setting: b.setting };
    }
    const out = compileProject(project, ctx);
    expect(out.warnings.filter((w) => !/edge-cut .*hidden for this shot/.test(w))).toEqual([]);
  });
});
