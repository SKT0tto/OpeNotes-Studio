/**
 * Difference between the scene as it is and the scene an AI / rule run proposes (already merged with the locks).
 * Items are grouped by the scope table (`scope.ts`) so "accept" / "reject" works per scope; `structural` means the beat list
 * itself (text, speaker, order) differs, in which case only the whole result can be accepted.
 */
import type { Beat, Scene, Track } from '../schema/project';
import { EMOTION_LABEL, MOVE_LABEL, SHOT_LABEL, TRANSITION_LABEL, expressionLabel, motionLabel } from '../catalog/labels';
import { SCOPES, SCOPE_LABEL, type ScopeName } from './scope';

export type DiffScope = Exclude<ScopeName, 'scene'> | 'structure';
export const DIFF_LABEL: Record<DiffScope, string> = { ...SCOPE_LABEL, structure: '台词结构 / 转场 / 音乐' };

export interface DiffItem {
  scope: DiffScope;
  /** Where: "第3句" or "场景". */
  where: string;
  field: string;
  before: string;
  after: string;
  beatId?: string;
}

export interface SceneDiff {
  items: DiffItem[];
  structural: boolean;
  /** Changed items per scope. */
  counts: Partial<Record<DiffScope, number>>;
  /** Keys of the proposal that the rule director filled in (listener turns ...), per scope. */
  ruleFilled: Partial<Record<DiffScope, number>>;
  /** Number of AI / rule keys of the proposal in total. */
  newKeys: number;
}

const CHANNEL_SCOPE = new Map<string, Exclude<ScopeName, 'scene'>>();
for (const [scope, spec] of Object.entries(SCOPES)) for (const c of spec.tracks) CHANNEL_SCOPE.set(c, scope as Exclude<ScopeName, 'scene'>);

const CHANNEL_LABEL: Record<string, string> = {
  motion: '动作', expression: '表情', head: '头部朝向', body: '身体朝向', gaze: '视线', position: '走位', opacity: '出入场', costume: '换装', camera: '镜头', fade: '黑场', fx: '特效',
};

type AnyKey = { at: { beatId: string; offset: number }; value: unknown; meta: { source: string } };
type AnyTrack = Omit<Track, 'keys'> & { keys: AnyKey[] };

/** Display names: cast ids -> names, model ids -> costume names (the raw ids never reach the screen). */
export interface DiffNames {
  cast?: (id: string) => string;
  model?: (id: string) => string;
}

const GAZE_TARGET: Record<string, string> = { camera: '看镜头', away: '移开视线', down: '低头' };
const shortOf = (channel: string, v: unknown, modelName: (id: string) => string, castName: (id: string) => string): string => {
  const o = v as Record<string, unknown> | null;
  const name = o && typeof o === 'object' && typeof o.name === 'string' ? o.name : typeof v === 'string' ? v : null;
  if (name !== null && channel === 'motion') return motionLabel(name);
  if (name !== null && channel === 'expression') return expressionLabel(name);
  if (o && typeof o === 'object' && typeof o.modelId === 'string') return modelName(o.modelId);
  if (channel === 'camera' && o && typeof o === 'object') return '镜头';
  if (channel === 'gaze' && o && typeof o === 'object' && typeof o.target === 'string') return GAZE_TARGET[o.target] ?? `看${castName(o.target)}`;
  return short(v);
};

const short = (v: unknown): string => {
  if (v === null || v === undefined) return '无';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const o = v as Record<string, unknown>;
  if (typeof o.name === 'string') return o.name;
  if (typeof o.modelId === 'string') return o.modelId;
  const s = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x));
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

const shotText = (b: Beat['shot']) => `${SHOT_LABEL[b.type] ?? b.type}${b.focus.length ? `·${b.focus.length}人` : ''}${b.move !== 'static' ? `·${MOVE_LABEL[b.move] ?? b.move}` : ''}${b.dof !== undefined ? `·景深${b.dof}` : ''}`;
const CUT_LABEL: Record<string, string> = TRANSITION_LABEL;

export function diffScene(old: Scene, fresh: Scene, namesIn: DiffNames | ((id: string) => string) = {}): SceneDiff {
  const names: DiffNames = typeof namesIn === 'function' ? { cast: namesIn } : namesIn;
  const castName = names.cast ?? ((id: string) => id);
  const modelName = names.model ?? ((id: string) => id);
  const items: DiffItem[] = [];
  const oldBeats = new Map(old.beats.map((b) => [b.id, b]));
  const freshIds = new Set(fresh.beats.map((b) => b.id));
  const idx = new Map(fresh.beats.map((b, i) => [b.id, i + 1]));
  const where = (id: string) => `第${idx.get(id) ?? '?'}句`;
  let structural = old.beats.length !== fresh.beats.length || old.beats.some((b) => !freshIds.has(b.id));

  for (const f of fresh.beats) {
    const o = oldBeats.get(f.id);
    if (!o) {
      items.push({ scope: 'structure', where: where(f.id), field: '新增台词', before: '—', after: f.text.slice(0, 24), beatId: f.id });
      continue;
    }
    if (o.text !== f.text || o.speakerId !== f.speakerId || o.kind !== f.kind) {
      structural = true;
      items.push({ scope: 'structure', where: where(f.id), field: '台词', before: `${o.speakerId ? `${castName(o.speakerId)}：` : ''}${o.text.slice(0, 18)}`, after: `${f.speakerId ? `${castName(f.speakerId)}：` : ''}${f.text.slice(0, 18)}`, beatId: f.id });
    }
    if (shotText(o.shot) !== shotText(f.shot) || o.cutIn !== f.cutIn) items.push({ scope: 'camera', where: where(f.id), field: '景别 / 切入', before: `${shotText(o.shot)} ${CUT_LABEL[o.cutIn] ?? o.cutIn}`, after: `${shotText(f.shot)} ${CUT_LABEL[f.cutIn] ?? f.cutIn}`, beatId: f.id });
    if ((o.emotion ?? '') !== (f.emotion ?? '')) items.push({ scope: 'performance', where: where(f.id), field: '情绪', before: o.emotion ? (EMOTION_LABEL[o.emotion] ?? o.emotion) : '无', after: f.emotion ? (EMOTION_LABEL[f.emotion] ?? f.emotion) : '无', beatId: f.id });
  }
  for (const o of old.beats) if (!freshIds.has(o.id)) items.push({ scope: 'structure', where: '原第?句', field: '删除台词', before: o.text.slice(0, 24), after: '—', beatId: o.id });

  // keys, per channel + target + beat
  const collect = (s: Scene) => {
    const m = new Map<string, { channel: string; who: string; beatId: string; values: string[]; rule: number }>();
    for (const t of s.tracks as AnyTrack[]) {
      const who = t.target.kind === 'actor' ? castName(t.target.castId) : '';
      for (const k of t.keys) {
        const key = `${t.channel}|${who}|${k.at.beatId}`;
        const e = m.get(key) ?? { channel: t.channel, who, beatId: k.at.beatId, values: [], rule: 0 };
        e.values.push(shortOf(t.channel, k.value, modelName, castName));
        if (k.meta.source === 'rule') e.rule++;
        m.set(key, e);
      }
    }
    return m;
  };
  const a = collect(old);
  const b = collect(fresh);
  let newKeys = 0;
  const ruleFilled: SceneDiff['ruleFilled'] = {};
  for (const [key, e] of b) {
    const scope = CHANNEL_SCOPE.get(e.channel);
    if (!scope) continue;
    newKeys += e.values.length;
    if (e.rule > 0) ruleFilled[scope] = (ruleFilled[scope] ?? 0) + e.rule;
    const before = a.get(key)?.values.join(' → ') ?? '无';
    const after = e.values.join(' → ');
    if (before !== after) items.push({ scope, where: where(e.beatId), field: `${CHANNEL_LABEL[e.channel] ?? e.channel}${e.who ? `（${e.who}）` : ''}`, before, after, beatId: e.beatId });
  }
  for (const [key, e] of a) {
    const scope = CHANNEL_SCOPE.get(e.channel);
    if (scope && !b.has(key) && freshIds.has(e.beatId)) items.push({ scope, where: where(e.beatId), field: `${CHANNEL_LABEL[e.channel] ?? e.channel}${e.who ? `（${e.who}）` : ''}`, before: e.values.join(' → '), after: '无', beatId: e.beatId });
  }

  // scene-level fields
  for (const id of new Set([...Object.keys(old.wardrobe), ...Object.keys(fresh.wardrobe)])) {
    const x = old.wardrobe[id]?.modelId;
    const y = fresh.wardrobe[id]?.modelId;
    if (x !== y) items.push({ scope: 'costume', where: '场景', field: `服装（${castName(id)}）`, before: x ? modelName(x) : '无', after: y ? modelName(y) : '无' });
  }
  for (const id of new Set([...Object.keys(old.blocking), ...Object.keys(fresh.blocking)])) {
    const x = old.blocking[id];
    const y = fresh.blocking[id];
    if (x?.slot !== y?.slot || x?.depth !== y?.depth) items.push({ scope: 'staging', where: '场景', field: `站位（${castName(id)}）`, before: x ? `${x.slot.toFixed(2)} / ${x.depth.toFixed(2)}` : '无', after: y ? `${y.slot.toFixed(2)} / ${y.depth.toFixed(2)}` : '无' });
  }
  if (old.transitionIn.kind !== fresh.transitionIn.kind) items.push({ scope: 'structure', where: '场景', field: '转场', before: TRANSITION_LABEL[old.transitionIn.kind] ?? old.transitionIn.kind, after: TRANSITION_LABEL[fresh.transitionIn.kind] ?? fresh.transitionIn.kind });
  if ((old.audio.bgm?.assetId ?? '') !== (fresh.audio.bgm?.assetId ?? '')) items.push({ scope: 'structure', where: '场景', field: '背景音乐', before: old.audio.bgm?.assetId ?? '无', after: fresh.audio.bgm?.assetId ?? '无' });

  const counts: SceneDiff['counts'] = {};
  for (const i of items) counts[i.scope] = (counts[i.scope] ?? 0) + 1;
  return { items, structural, counts, ruleFilled, newKeys };
}

/**
 * For accepting only some scopes of a proposal whose beat list differs from the scene: gives the beats of `fresh` that say the
 * same thing as a beat of `old` (same speaker and text) the id of that old beat, and everything pointing at them (keys, enter /
 * exit markers) with it. Beats that exist only in the proposal keep their ids and are therefore not part of a partial
 * (non-structure) merge; old beats the proposal dropped stay as they were.
 */
export function alignToOld(old: Scene, fresh: Scene): Scene {
  const taken = new Set<string>();
  const map = new Map<string, string>();
  for (const f of fresh.beats) {
    if (old.beats.some((o) => o.id === f.id)) {
      taken.add(f.id);
      continue;
    }
  }
  for (const f of fresh.beats) {
    if (taken.has(f.id) || !f.text) continue;
    const o = old.beats.find((b) => !taken.has(b.id) && b.text === f.text && b.speakerId === f.speakerId);
    if (o) {
      taken.add(o.id);
      map.set(f.id, o.id);
    }
  }
  if (map.size === 0) return fresh;
  const re = (id: string) => map.get(id) ?? id;
  const out = JSON.parse(JSON.stringify(fresh)) as Scene;
  for (const b of out.beats) b.id = re(b.id);
  for (const t of out.tracks) for (const k of t.keys as Array<{ at: { beatId: string } }>) k.at.beatId = re(k.at.beatId);
  for (const bl of Object.values(out.blocking)) {
    if (bl.enter) bl.enter.beatId = re(bl.enter.beatId);
    if (bl.exit) bl.exit.beatId = re(bl.exit.beatId);
  }
  return out;
}
