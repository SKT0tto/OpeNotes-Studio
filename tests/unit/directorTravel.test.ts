import { describe, expect, it } from 'vitest';
import { SCENE_PROMPT_VERSION, SCENE_SYSTEM, SCENE_TRAVEL_SECTION, SCENE_TRAVEL_VERSION, scenePromptFor } from '../../server/llm/prompts/sceneDirection';
import { expandScene } from '../../shared/director/expand';
import { projectFromBreakdown } from '../../shared/director/fromBreakdown';
import { mergeLocks } from '../../shared/director/mergeLocks';
import { splitParagraphs } from '../../shared/director/paragraphs';
import { validateBreakdown, validateDirection } from '../../shared/director/validate';
import { BreakdownSchema, SceneDirectionSchema, SceneDirectionTravelSchema, type SceneDirection } from '../../shared/schema/ai';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import { STORY, fixtureCatalog, readFixture } from './helpers/directorCatalog';

const cat = fixtureCatalog();
const paragraphs = splitParagraphs(STORY);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const breakdown = BreakdownSchema.parse(readFixture('breakdown-story.json'));

function skeleton(): Project {
  const v = validateBreakdown(breakdown, { catalog: cat, paragraphCount: paragraphs.length });
  return ProjectSchema.parse(projectFromBreakdown({ title: '示例', text: STORY, paragraphs, breakdown: v.value, catalog: cat, genId: 'g1', now: 1000 }));
}
const project = skeleton();
const scene = project.scenes[2]!;
const inScene = paragraphs.filter((p) => p.start >= scene.sourceSpan.start && p.end <= scene.sourceSpan.end);
const ctxBase = {
  catalog: cat, paragraphs, range: { start: inScene[0]!.index, end: inScene.at(-1)!.index }, isPerformance: !!scene.brief?.isPerformance,
  cast: Object.keys(scene.wardrobe).map((castId) => ({ castId, characterKey: project.cast.find((c) => c.id === castId)!.characterKey, modelId: scene.wardrobe[castId]!.modelId })),
};
const WHO = ctxBase.cast[0]!.castId;
const OTHER = ctxBase.cast[1]!.castId;

/** The recorded first scene with the camera flow of a few beats set by hand. */
function direction(): SceneDirection {
  const d = clone(SceneDirectionSchema.parse(readFixture('scene-6-12-scene.json'))) as SceneDirection;
  const set = (i: number, type: 'mcu' | 'cu' | 'ecu' | 'two_shot', focus: string[], flow: 'auto' | 'cut' | 'move' | null) => {
    const b = d.beats[i]!;
    b.shot = { ...b.shot, type, focus, flow };
    b.cutIn = 'cut';
    b.bg = null;
  };
  set(0, 'mcu', [WHO], 'move'); // first beat: cannot move
  set(1, 'mcu', [WHO], 'auto');
  set(2, 'cu', [WHO], 'move'); // same person, mcu -> cu: stays
  set(3, 'cu', [OTHER], 'move'); // another person: a move to the next speaker, stays
  set(4, 'cu', [OTHER], 'move'); // same person, same size: the intent level cannot judge geometry, stays
  set(5, 'ecu', [OTHER], 'cut');
  set(6, 'ecu', [OTHER], null);
  return d;
}

describe('director: camera flow intent', () => {
  it('the classic prompt is untouched; travel appends the section and uses its own schema and version', () => {
    const c = scenePromptFor('classic');
    expect(c.system).toBe(SCENE_SYSTEM);
    expect(c.schema).toBe(SceneDirectionSchema);
    expect(c.schemaName).toBe('SceneDirection');
    expect(c.promptVersion).toBe(SCENE_PROMPT_VERSION);
    const t = scenePromptFor('travel');
    expect(t.system).toBe(`${SCENE_SYSTEM}\n\n${SCENE_TRAVEL_SECTION}`);
    expect(t.schema).toBe(SceneDirectionTravelSchema);
    expect(t.schemaName).toBe('SceneDirectionTravel');
    expect(t.promptVersion).toBe(SCENE_TRAVEL_VERSION);
    expect(SCENE_TRAVEL_VERSION).toBe('scene-3+travel-5');
    expect(SCENE_TRAVEL_SECTION).toContain('移到');
    expect(SCENE_TRAVEL_SECTION).not.toContain('一期');
    expect(SCENE_SYSTEM).not.toContain('shot.flow');
  });

  it('the travel schema accepts classic answers and the new flow field', () => {
    const raw = readFixture('scene-6-12-scene.json');
    expect(SceneDirectionTravelSchema.safeParse(raw).success).toBe(true);
    const d = direction();
    expect(SceneDirectionTravelSchema.safeParse(d).success).toBe(true);
    d.beats[0]!.shot.intent = 'reveal';
    expect(SceneDirectionTravelSchema.parse(d).beats[0]!.shot.intent).toBe('reveal');
    expect(SceneDirectionSchema.parse(d).beats[0]!.shot).not.toHaveProperty('intent');
    expect(SceneDirectionSchema.parse(d).beats[0]!.shot).not.toHaveProperty('flow');
  });

  it('travel validation only downgrades what the intent level can judge, and keeps moves to the next speaker', () => {
    const v = validateDirection(direction(), { ...ctxBase, cameraSystem: 'travel' });
    const flows = v.value.beats.slice(0, 7).map((b) => b.shot.flow);
    expect(flows).toEqual(['auto', 'auto', 'move', 'move', 'move', 'cut', 'auto']);
    expect(v.warnings.filter((w) => w.includes('运镜意图已改为自动')).length).toBe(1);
    expect(v.warnings.find((w) => w.includes('运镜意图已改为自动'))).toContain('第一拍');
  });

  it('a move is downgraded to auto for: a dip, an insert, a beat without focus; each with its reason', () => {
    const flowOf = (edit: (d: SceneDirection) => void) => {
      const d = direction();
      edit(d);
      const v = validateDirection(d, { ...ctxBase, cameraSystem: 'travel' });
      return { flow: v.value.beats[3]!.shot.flow, why: v.warnings.filter((w) => w.includes('运镜意图已改为自动')).join('|') };
    };
    expect(flowOf(() => undefined).flow).toBe('move');
    const dip = flowOf((d) => void (d.beats[3]!.cutIn = 'dip_black'));
    expect(dip.flow).toBe('auto');
    expect(dip.why).toContain('黑场');
    const insertNow = flowOf((d) => void (d.beats[3]!.shot.type = 'insert' as never));
    expect(insertNow.flow).toBe('auto');
    expect(insertNow.why).toContain('插入');
    const noFocus = flowOf((d) => {
      d.beats[3]!.shot.type = 'group' as never;
      d.beats[3]!.shot.focus = [];
      d.beats[3]!.speaker = null;
    });
    expect(noFocus.flow).toBe('auto');
    expect(noFocus.why).toContain('焦点');
    // group and two-shot moves are fine now (regroup)
    expect(flowOf((d) => void (d.beats[3]!.shot.type = 'two_shot' as never)).flow).toBe('move');
  });

  it('classic validation removes flow altogether', () => {
    for (const cameraSystem of ['classic', undefined] as const) {
      const d = direction(); d.beats[0]!.shot.intent = 'rupture';
      const v = validateDirection(d, { ...ctxBase, ...(cameraSystem ? { cameraSystem } : {}) });
      expect(v.value.beats.every((b) => !('intent' in b.shot))).toBe(true);
      expect(v.value.beats.every((b) => !('flow' in b.shot))).toBe(true);
    }
  });

  it('expand maps flow to the shot transition: move -> travel, cut -> cut, auto -> nothing', () => {
    const v = validateDirection(direction(), { ...ctxBase, cameraSystem: 'travel' });
    const out = expandScene({ base: scene, direction: v.value, paragraphs, genId: 'g2', now: 2000 });
    const tr = out.scene.beats.slice(0, 7).map((b) => b.shot.transition);
    expect(tr).toEqual([undefined, undefined, 'travel', 'travel', 'travel', 'cut', undefined]);
  });

  it('intent survives expand, save/reload and field-lock merge; AI motion cannot bypass it', () => {
    const d = direction();
    d.beats[2]!.shot.intent = 'reaction'; d.beats[2]!.shot.move = 'push_in';
    const v = validateDirection(d, { ...ctxBase, cameraSystem: 'travel' });
    expect(v.value.beats[2]!.shot.move).toBe('static');
    const fresh = expandScene({ base: scene, direction: v.value, paragraphs, genId: 'g2', now: 2000 }).scene;
    expect(ProjectSchema.parse({ ...project, scenes: [fresh] }).scenes[0]!.beats[2]!.shot.intent).toBe('reaction');
    const old = clone(fresh);
    old.beats[2]!.shot.intent = 'continue'; old.beats[2]!.shot.meta.lockedFields = ['intent'];
    const merged = mergeLocks(old, fresh, { scopes: ['camera'], overwriteUser: true });
    expect(merged.applied).toBe(true);
    expect(merged.scene.beats[2]!.shot.intent).toBe('continue');
  });

  it('invalid travel inserts fall back to a stable medium shot', () => {
    const d = direction();
    d.beats[3]!.shot.type = 'insert'; d.beats[3]!.shot.insertTarget = 'hands';
    d.beats[3]!.text = '嗯。'; d.beats[3]!.actors = [];
    expect(validateDirection(d, { ...ctxBase, cameraSystem: 'travel' }).value.beats[3]!.shot.type).toBe('ms');
  });

  it('a locked transition survives regeneration', () => {
    const v = validateDirection(direction(), { ...ctxBase, cameraSystem: 'travel' });
    const out = expandScene({ base: scene, direction: v.value, paragraphs, genId: 'g2', now: 2000 });
    const old = clone(out.scene);
    old.beats[2]!.shot.transition = 'cut';
    old.beats[2]!.shot.meta = { ...old.beats[2]!.shot.meta, source: 'user', locked: false, lockedFields: ['transition'], updatedAt: 9 };
    const merged = mergeLocks(old, clone(out.scene), { scopes: ['scene'] });
    const b = merged.scene.beats.find((x) => x.id === old.beats[2]!.id)!;
    expect(b.shot.transition).toBe('cut');
  });
});

describe('director: medium shot (ms) belongs to the travel system', () => {
  it('the travel schema accepts ms, the classic schema rejects it', () => {
    const d = direction();
    d.beats[1]!.shot = { ...d.beats[1]!.shot, type: 'ms' };
    expect(SceneDirectionTravelSchema.safeParse(d).success).toBe(true);
    expect(SceneDirectionSchema.safeParse(d).success).toBe(false);
  });

  it('classic validation turns ms into mcu with a note; travel validation keeps it', () => {
    const d = direction();
    d.beats[1]!.shot = { ...d.beats[1]!.shot, type: 'ms' };
    const classic = validateDirection(clone(d), { ...ctxBase });
    expect(classic.value.beats[1]!.shot.type).toBe('mcu');
    expect(classic.warnings.some((w) => w.includes('ms'))).toBe(true);
    const travel = validateDirection(clone(d), { ...ctxBase, cameraSystem: 'travel' });
    expect(travel.value.beats[1]!.shot.type).toBe('ms');
  });

  it('the travel prompt mentions ms and the shot mix of the original; the classic prompt does not', () => {
    expect(SCENE_TRAVEL_SECTION).toContain('ms');
    expect(SCENE_SYSTEM).not.toMatch(/\bms\b/);
  });
});

describe('rule director: the shot mix', () => {
  const shotMix = async (travel: boolean) => {
    const { novelProject } = await import('./helpers/travelNovel');
    const { runScenes } = await import('../../server/llm/sceneRunner');
    const { p, deps, project } = await novelProject();
    void p;
    const sys = travel ? ({ ...project, settings: { ...project.settings, cameraSystem: 'travel' as const } } as Project) : project;
    const items = await runScenes(deps, sys, project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
    const count: Record<string, number> = {};
    let n = 0;
    for (const i of items) for (const b of i.result!.scene.beats) {
      if (b.shot.type === 'establishing') continue;
      count[b.shot.type] = (count[b.shot.type] ?? 0) + 1;
      n++;
    }
    return { beats: items.flatMap((i) => i.result!.scene.beats), count, n, share: (k: string) => (count[k] ?? 0) / n };
  };

  it('travel organizes stable dialogue with narrative intent without shot quotas', async () => {
    const m = await shotMix(true);
    const directed = m.beats.filter((b) => b.shot.intent);
    expect(directed.length).toBeGreaterThan(50);
    expect(directed.some((b) => b.shot.intent === 'continue')).toBe(true);
    expect(directed.some((b) => b.shot.intent === 'reaction' || b.shot.intent === 'emphasis')).toBe(true);
    expect(directed.every((b) => b.shot.move === 'static')).toBe(true);
    for (let i = 1; i < m.beats.length; i++) {
      const b = m.beats[i]!, prev = m.beats[i - 1]!;
      if (b.shot.type === 'two_shot' && b.shot.intent === 'continue') {
        expect(b.shot.type).toBe(prev.shot.type);
        expect(b.shot.focus).toEqual(prev.shot.focus);
      }
    }
  });

  it('classic: no ms at all, and the old rhythm (mcu is the default dialogue shot)', async () => {
    const m = await shotMix(false);
    expect(m.count.ms ?? 0).toBe(0);
    expect(m.share('mcu')).toBeGreaterThan(0.4);
  });
});
