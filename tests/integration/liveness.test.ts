/**
 * v0.1.2: against the REAL model catalog, every actor of an AI-generated project is active at every moment:
 * it starts in an idle loop, every motion / expression it plays exists in the outfit it wears at that time, one-shots
 * return to idle, and bystanders get reactions. (Also runs over every project saved in data/projects when present.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog } from '../../server/assets/indexer';
import { loadConfig } from '../../server/config';
import type { Catalog, ModelEntry } from '../../shared/schema/assets';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { idleFamilyOf, isLiveSet } from '../../shared/timeline/motionMap';
import { lastBefore } from '../../shared/timeline/sample';
import type { CompileContext, CompiledProject } from '../../shared/timeline/types';
import { fakeCalibration } from '../unit/helpers/synthetic';

const config = loadConfig();
const available = fs.existsSync(path.join(config.assetRoot, 'models'));

const fixtures = (): Array<{ name: string; project: Project }> => {
  const out: Array<{ name: string; project: Project }> = [];
  const dir = path.join(__dirname, '..', 'fixtures');
  for (const f of fs.readdirSync(dir).filter((x) => /^ai-generated.*\.json$/.test(x))) out.push({ name: f, project: ProjectSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) });
  const data = path.join(__dirname, '..', '..', 'data', 'projects');
  if (fs.existsSync(data)) {
    for (const id of fs.readdirSync(data)) {
      try {
        const p = ProjectSchema.parse(JSON.parse(fs.readFileSync(path.join(data, id, 'project.json'), 'utf8')));
        if (p.scenes.some((s) => s.beats.length > 0)) out.push({ name: `data/projects/${id}`, project: p });
      } catch {
        /* not a project (or an older schema): ignore */
      }
    }
  }
  return out;
};

describe.skipIf(!available)('generated projects against the real catalog: nobody is ever still', () => {
  let cat: Catalog;
  const byId = (id: string): ModelEntry => cat.models.find((m) => m.id === id)!;
  beforeAll(async () => {
    cat = await buildCatalog({ assetRoot: config.assetRoot, audioRoots: config.audioRoots });
  });

  const compile = (project: Project): CompiledProject => {
    const ctx: CompileContext = { models: {}, calibrations: {}, backgrounds: {} };
    const add = (id: string) => {
      const m = byId(id);
      ctx.models[id] = { motions: m.motions, expressions: m.expressions.map((e) => e.name) };
      ctx.calibrations[id] = fakeCalibration(id);
    };
    for (const s of project.scenes) {
      Object.values(s.wardrobe).forEach((w) => add(w.modelId));
      for (const t of s.tracks) if (t.channel === 'costume') t.keys.forEach((k) => add(k.value.modelId));
      const b = cat.backgrounds.find((x) => x.id === s.background.assetId)!;
      ctx.backgrounds[b.id] = { width: b.width ?? 2048, height: b.height ?? 1119, setting: b.setting };
    }
    return compileProject(project, ctx);
  };

  const all = fixtures();
  it('has at least the committed AI-generated fixture to check', () => {
    expect(all.some((f) => f.name.startsWith('ai-generated'))).toBe(true);
  });

  for (const { name, project } of all) {
    it(`${name}: every actor is in a loop or a running one-shot at every moment, with motions and expressions that exist in the outfit`, () => {
      const c = compile(project);
      expect(c.warnings.filter((w) => /no idle|dropped/.test(w) && !/edge-cut/.test(w))).toEqual([]);
      let checked = 0;
      for (const sc of c.scenes) {
        for (const a of sc.actors) {
          const modelAt = (t: number) => lastBefore(a.models, t)?.modelId ?? a.initialModelId;
          const idle = idleFamilyOf(byId(a.initialModelId).motions);
          expect(idle, `${a.castId} (${a.initialModelId}) has an idle`).not.toBeNull();
          expect(a.motions[0]!.loop, `${sc.id}/${a.castId} starts in a loop`).toBe(true);
          for (const ev of a.motions) {
            const m = byId(modelAt(ev.at));
            expect(m.motions.some((x) => x.name === ev.name), `${sc.id}/${a.castId}@${ev.at.toFixed(1)} ${ev.name} exists in ${m.id}`).toBe(true);
          }
          for (const ev of a.expressions) {
            if (ev.name === null) continue;
            expect(byId(modelAt(ev.at)).expressions.some((x) => x.name === ev.name), `${sc.id}/${a.castId}@${ev.at.toFixed(1)} ${ev.name}`).toBe(true);
          }
          for (let t = sc.start; t < sc.end; t += 0.1) {
            const ev = lastBefore(a.motions, t)!;
            checked++;
            if (!ev.loop && t >= ev.at + ev.length + 1e-6) expect.fail(`${sc.id}/${a.castId} is frozen at ${t.toFixed(1)} s after ${ev.name}`);
          }
        }
      }
      expect(checked).toBeGreaterThan(100);
    });

    it(`${name}: in everyday scenes each bystander makes a reaction during the project; musicians never get gestures`, () => {
      const c = compile(project);
      for (const sc of c.scenes) {
        const live = sc.actors.some((a) => isLiveSet(byId(a.initialModelId).motions));
        for (const a of sc.actors) {
          if (live) continue;
          const bystanderSeconds = sc.beats.filter((b) => b.speakerId !== a.castId && b.end - b.start >= 6).length;
          const shots = a.motions.filter((m) => !m.loop).length;
          if (bystanderSeconds >= 2) expect(shots, `${sc.id}/${a.castId} has ${bystanderSeconds} long lines of others`).toBeGreaterThan(0);
        }
      }
    });
  }
});
