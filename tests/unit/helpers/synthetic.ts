import type { MotionEntry } from '../../../shared/schema/assets';
import type { Calibration } from '../../../shared/schema/calibration';
import { ProjectSchema, type Project } from '../../../shared/schema/project';
import type { CompileContext } from '../../../shared/timeline/types';

/** Hand-made calibration in model-local pixels: 7000 px tall model, head 1200 px, feet at the bottom. */
export function fakeCalibration(modelId: string, headSign: 1 | -1 = 1): Calibration {
  return {
    version: 1,
    modelId,
    bounds: { x: 1000, y: 200, w: 2400, h: 6800 },
    ground: { x: 2200, y: 7000 },
    totalHeight: 6800,
    head: { bbox: { x: 1700, y: 200, w: 1000, h: 1150 }, center: { x: 2200, y: 775 }, height: 1150 },
    headSign,
    bodySign: headSign,
    eyeSign: headSign,
    hasEyeBallX: true,
    verified: false,
    probedAt: '2026-01-01T00:00:00.000Z',
  };
}

function motion(family: string, side: 'L' | 'C' | 'R', angle: number, duration: number): MotionEntry {
  const stat = (mean: number) => ({ first: mean, mean });
  return {
    name: `mtn_${family}_${side}`,
    file: `motions/mtn_${family}_${side}.motion3.json`,
    family,
    side,
    variant: '',
    stats: { duration, fps: 30, loop: false, angleX: stat(angle), bodyAngleX: stat(angle / 2), eyeBallX: stat(0) },
  };
}

const FAMILIES: Array<[string, number]> = [['idle01', 6], ['nod01', 2.5], ['smile01', 3], ['surprised01', 2], ['thinking01', 4]];

/** Synthetic model entry: every family has L(+22) / C(0) / R(-22) variants. */
export function fakeModel() {
  const motions = FAMILIES.flatMap(([f, d]) => [motion(f, 'L', 22, d), motion(f, 'C', 0, d), motion(f, 'R', -22, d)]);
  const expressions = ['exp_smile01', 'exp_smile02', 'exp_surprised01', 'exp_shy01', 'exp_sad01', 'exp_angry01', 'exp_bsmile01', 'exp_bsmile02'];
  return { motions, expressions };
}

export function fakeContext(modelIds: string[], backgroundIds: string[]): CompileContext {
  return {
    models: Object.fromEntries(modelIds.map((id) => [id, fakeModel()])),
    calibrations: Object.fromEntries(modelIds.map((id) => [id, fakeCalibration(id)])),
    backgrounds: Object.fromEntries(backgroundIds.map((id) => [id, { width: 2048, height: 1119 }])),
  };
}

type Raw = Record<string, unknown>;

/** Smallest valid project: one scene, two actors facing each other, three dialogue beats. */
export function miniProject(over: { tracks?: Raw[]; text?: string[]; transition?: Raw; style?: Raw; scene?: Raw; beats?: Raw[] } = {}): Project {
  const text = over.text ?? ['你好呀，今天天气真不错。', '是啊。', '我们去哪里？'];
  const shot = (type: string, focus: string[], move = 'static', dof = 0) => ({ type, focus, move, dof });
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'mini',
    title: 'mini',
    createdAt: 0,
    updatedAt: 0,
    settings: { aspect: '16:9', fps: 30, textSpeedCps: 10, defaultLineGap: 0.2 },
    source: { text: '', format: 'script' },
    // the rule director and the minimum-shot rule have their own tests; the older tests want exactly what they wrote
    style: { overrides: { 'performance.ruleDirector': false, 'rhythm.enforceMinShot': false, ...over.style } },
    cast: [
      { id: 'a', characterKey: '001', displayName: 'A' },
      { id: 'b', characterKey: '002', displayName: 'B' },
    ],
    scenes: [
      {
        id: 's1',
        title: 's1',
        background: { assetId: 'bg1' },
        wardrobe: { a: { modelId: 'mA' }, b: { modelId: 'mB' } },
        blocking: { a: { slot: -0.4, depth: 0.1 }, b: { slot: 0.4, depth: 0.1 } },
        transitionIn: over.transition ?? { kind: 'cut', duration: 0 },
        beats: over.beats ?? [
          { id: 'b1', kind: 'dialogue', speakerId: 'a', text: text[0], shot: shot('two_shot', ['a', 'b']) },
          { id: 'b2', kind: 'dialogue', speakerId: 'b', text: text[1], shot: shot('mcu', ['b'], 'push_in', 3) },
          { id: 'b3', kind: 'dialogue', speakerId: 'a', text: text[2], shot: shot('cu', ['a'], 'static', 5) },
        ],
        tracks: over.tracks ?? [],
        ...over.scene,
      },
    ],
  });
}

export const MINI_CTX = fakeContext(['mA', 'mB', 'mA2'], ['bg1']);
