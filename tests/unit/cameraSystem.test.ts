import { describe, expect, it } from 'vitest';
import demo from '../fixtures/demo-project.json';
import aiA from '../fixtures/ai-generated-project.json';
import aiB from '../fixtures/ai-generated-project-b.json';
import aiC from '../fixtures/ai-generated-project-c.json';
import { ProjectSchema, ShotSchema, cameraSystemOf, type CameraSystem } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { MINI_CTX, miniProject } from './helpers/synthetic';

describe('camera system selection', () => {
  const proj: Array<CameraSystem | undefined> = [undefined, 'classic', 'travel'];
  const scene: Array<'inherit' | CameraSystem | undefined> = [undefined, 'inherit', 'classic', 'travel'];
  it('scene override beats the project; absent / inherit follow the project; absent project = classic', () => {
    for (const p of proj) for (const s of scene) {
      const project = { settings: { ...miniProject().settings, ...(p ? { cameraSystem: p } : {}) } };
      const want = s === 'classic' || s === 'travel' ? s : (p ?? 'classic');
      expect(cameraSystemOf(project, { cameraSystem: s }), `${p}/${s}`).toBe(want);
    }
  });

  it('old fixtures parse to a fixed point and never gain a cameraSystem field', () => {
    for (const raw of [demo, aiA, aiB, aiC]) {
      const p = ProjectSchema.parse(raw);
      const again = ProjectSchema.parse(JSON.parse(JSON.stringify(p)));
      expect(JSON.parse(JSON.stringify(again))).toEqual(JSON.parse(JSON.stringify(p)));
      expect(JSON.stringify(p)).not.toContain('cameraSystem');
    }
  });

  it('accepts transition travel and the new system fields, rejects bad values', () => {
    const shot = { type: 'mcu', focus: ['a'], move: 'static' };
    expect(ShotSchema.parse({ ...shot, transition: 'travel' }).transition).toBe('travel');
    expect(() => ShotSchema.parse({ ...shot, transition: 'zoom' })).toThrow();
    const base = JSON.parse(JSON.stringify(miniProject()));
    base.settings.cameraSystem = 'travel';
    base.scenes[0].cameraSystem = 'inherit';
    expect(ProjectSchema.parse(base).settings.cameraSystem).toBe('travel');
    base.settings.cameraSystem = 'inherit';
    expect(() => ProjectSchema.parse(base)).toThrow();
    base.settings.cameraSystem = 'travel';
    base.scenes[0].cameraSystem = 'nope';
    expect(() => ProjectSchema.parse(base)).toThrow();
  });
});

describe('classic output carries no travel data', () => {
  it('no scene has a travel / cameraSystem key and no actor has inFocus', () => {
    const c = compileProject(miniProject(), MINI_CTX);
    for (const s of c.scenes) {
      expect('travel' in s).toBe(false);
      expect('cameraSystem' in s).toBe(false);
      for (const a of s.actors) expect('inFocus' in a).toBe(false);
    }
  });
});

describe('scenesNeedingTravelDirection', () => {
  const base = () => ProjectSchema.parse(JSON.parse(JSON.stringify(demo)));
  it('counts travel scenes without any beat intent; classic scenes and directed scenes are excluded', async () => {
    const { scenesNeedingTravelDirection } = await import('../../shared/director/travelDirection');
    const p = base();
    expect(scenesNeedingTravelDirection(p)).toEqual([]); // classic project
    p.settings.cameraSystem = 'travel';
    expect(scenesNeedingTravelDirection(p).map((s) => s.id)).toEqual(p.scenes.map((s) => s.id));
    p.scenes[0]!.beats[0]!.shot.intent = 'reaction';
    expect(scenesNeedingTravelDirection(p).map((s) => s.id)).toEqual(p.scenes.slice(1).map((s) => s.id));
    p.scenes[1]!.cameraSystem = 'classic';
    expect(scenesNeedingTravelDirection(p).map((s) => s.id)).toEqual(p.scenes.slice(2).map((s) => s.id));
  });
});
