import fs from 'node:fs';
import path from 'node:path';
import { parseCostume, splitModelId } from '../../../shared/catalog/costume';
import { parseMotionName } from '../../../shared/catalog/motionNames';
import type { MotionEntry, ModelEntry, BackgroundEntry } from '../../../shared/schema/assets';
import type { DirectorCatalog } from '../../../shared/director/resources';
import bandsJson from '../../../shared/data/bands.json';
import charsJson from '../../../shared/data/characters.json';
import type { Breakdown, SceneDirection } from '../../../shared/schema/ai';
import type { CompileContext } from '../../../shared/timeline/types';
import { fakeCalibration } from './synthetic';

export const FIXTURE_DIR = path.resolve('tests/fixtures/llm');
export const readFixture = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as T;
export const STORY = fs.readFileSync(path.resolve('tests/fixtures/story-short.txt'), 'utf8');

const stat = (m: number) => ({ first: m, mean: m });
const motion = (family: string, side: 'L' | 'C' | 'R' | null): MotionEntry => ({
  name: side ? `mtn_${family}_${side}` : `mtn_${family}`, file: `motions/${family}.motion3.json`, family, side, variant: '',
  stats: { duration: 3, fps: 30, loop: false, angleX: stat(side === 'L' ? 22 : side === 'R' ? -22 : 0), bodyAngleX: stat(0), eyeBallX: stat(0) },
});

const baseFamilies = ['idle01', 'nod01', 'smile01', 'thinking01', 'look01', 'surprised01', 'sad01'];
const baseExpressions = ['exp_idle01', 'exp_smile01', 'exp_smile02', 'exp_sad01', 'exp_serious01', 'exp_shy01', 'exp_surprised01', 'exp_thinking01'];

/** Every motion family / expression the recorded model outputs ever used: the synthetic library offers all of them (so the clean fixtures need no repair). */
function usedByFixtures(): { families: Set<string>; expressions: Set<string> } {
  const families = new Set(baseFamilies);
  const expressions = new Set(baseExpressions);
  for (const f of fs.readdirSync(FIXTURE_DIR).filter((x) => x.startsWith('scene-') && !x.includes('bad'))) {
    const d = readFixture<SceneDirection>(f);
    for (const b of d.beats) for (const a of b.actors) {
      if (a.motion) families.add(a.motion);
      if (a.expression) expressions.add(a.expression);
    }
  }
  return { families, expressions };
}

export function fixtureCatalog(extraKeys: string[] = []): DirectorCatalog {
  const bd = readFixture<Breakdown>('breakdown-story.json');
  const ids = new Set<string>();
  for (const s of bd.scenes) for (const w of s.wardrobe) ids.add(w.modelId);
  const keys = new Set([...bd.cast.flatMap((c) => (c.characterKey ? [c.characterKey] : [])), ...extraKeys]);
  for (const id of [...ids]) keys.add(splitModelId(id).characterKey);
  const { families, expressions } = usedByFixtures();
  const sided = [...families].flatMap((f) => (f.startsWith('play') ? [motion(f, null)] : (['L', 'C', 'R'] as const).map((s) => motion(f, s))));
  const model = (id: string): ModelEntry => {
    const { characterKey, costume, isSub } = splitModelId(id);
    const info = parseCostume(costume);
    return {
      id, characterKey, isSub, costume, costumeInfo: info, mode: info.mode, quality: info.quality, still: info.still, hasPhysics: true,
      url: `/assets/models/${id}/model3.json`, preview: null, textureCount: 1,
      motions: info.mode === 'live' ? [motion('idle', null), motion('play01_01', null), motion('play02_01', null), motion('action_01', null)] : sided,
      expressions: info.mode === 'live' ? [] : [...expressions].map((name) => ({ name, file: `expressions/${name}.exp3.json`, family: name.replace(/\d+$/, ''), index: 1 })),
      missingFiles: [],
    };
  };
  for (const k of keys) {
    ids.add(`${k}_casual_spring_01`);
    ids.add(`${k}_school_winter_hs_1st`);
    ids.add(`${k}_live-mode_live_01`);
  }
  ids.add('001_casual_spring_01_low');
  const chars = (charsJson.characters as Array<{ key: string; name: string; band: string; role: string }>).filter((c) => keys.has(c.key));
  const bg = (id: string, name: string, over: Partial<BackgroundEntry> = {}): BackgroundEntry => ({
    id, url: `/assets/backgrounds/${id}.png`, width: 2048, height: 1119, name, aliases: [], kind: 'scene', location: name, category: null, setting: '室内', time: '日间', weather: null, description: null, tags: [], ...over,
  });
  const backgrounds = [...new Set(bd.scenes.map((s) => s.location.backgroundId))].map((id, i) => bg(id, `背景 ${i + 1}`));
  backgrounds.push(bg('bg_ring_night', 'RiNG 咖啡厅', { location: 'RiNG', time: '夜间', description: '木地板和吧台' }), bg('bg_roof_night', '学校天台', { location: '天台', setting: '室外', time: '夜间', description: '夜晚的天台' }));
  return {
    models: [...ids].map(model),
    backgrounds,
    audio: [{ id: 'media/test.wav', name: 'test', url: '/audio/0/test.wav', source: 'media', ext: 'wav', bytes: 10 }],
    characters: chars.map((c) => ({ key: c.key, name: c.name, nickname: null, bandKey: c.band, bandName: c.band === 'mygo' ? 'MyGO!!!!!' : c.band, role: c.role, color: null, isSub: false, aliases: [], modelIds: [] })),
    bands: bandsJson.bands.map((b) => ({ key: b.key, name: b.name, memberKeys: b.members, formation: b.formation })),
  };
}

export function compileContext(cat: DirectorCatalog): CompileContext {
  return {
    models: Object.fromEntries(cat.models.map((m) => [m.id, { motions: m.motions, expressions: m.expressions.map((e) => e.name) }])),
    calibrations: Object.fromEntries(cat.models.map((m) => [m.id, fakeCalibration(m.id)])),
    backgrounds: Object.fromEntries(cat.backgrounds.map((b) => [b.id, { width: b.width ?? 2048, height: b.height ?? 1119 }])),
  };
}

export { parseMotionName };
