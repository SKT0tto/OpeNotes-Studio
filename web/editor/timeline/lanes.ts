/** Rows of the multi-track timeline for one scene: what is drawn on each lane, derived from the project and its compile result. */
import { costumeLabelZh, expressionLabel, motionLabel, SHOT_SHORT } from '@shared/catalog/labels';
import { parseCostume, splitModelId } from '@shared/catalog/costume';
import { absTime, storedBeatTimes, type Channel, type TrackTarget } from '@shared/project/mutate';
import type { Project, Scene } from '@shared/schema/project';
import type { CompiledScene, RuleKey } from '@shared/timeline/types';

export const CHANNEL_LABEL: Record<Channel, string> = {
  motion: '动作', expression: '表情', head: '头部', body: '身体', gaze: '视线', position: '位置', opacity: '透明度', costume: '服装',
  camera: '镜头关键帧', bgm: 'BGM', se: '音效', fade: '黑/白场', fx: '特效', background: '背景',
};
export const ACTOR_CHANNELS: Channel[] = ['motion', 'expression', 'head', 'body', 'gaze', 'position', 'opacity', 'costume'];

export interface LaneKey {
  id: string;
  at: number;
  duration: number;
  label: string;
  locked: boolean;
  /** A rule-director key that is not backed by a track key yet (double-click bakes it). */
  ghost?: { castId: string; keys: RuleKey[] };
  title: string;
}

export interface Lane {
  id: string;
  label: string;
  group: string;
  color: string;
  /** Lanes backed by a track (keys can be added / dragged). */
  track?: { target: TrackTarget; channel: Channel; trackId: string | null; locked: boolean };
  keys: LaneKey[];
  kind: 'keys' | 'beats' | 'shots' | 'transition' | 'banner' | 'background';
}

export interface Group {
  id: string;
  label: string;
  color: string;
  castId?: string;
  lanes: Lane[];
}

const FX_LABEL: Record<string, string> = { vignette_anxiety: '暗角', memory_glow: '泛光', dutch: '倾斜' };
const SPECIAL_TARGET: Record<string, string> = { camera: '镜头', away: '移开', down: '低头' };

/** Short Chinese text of a key value for the lane (the raw ids are only in the tooltip). */
const makeValueLabel = (nameOf: (castId: string) => string, audioName: (id: string) => string, bgName: (id: string) => string) => (channel: Channel, v: unknown): string => {
  const o = v as Record<string, unknown>;
  const who = (t: unknown) => SPECIAL_TARGET[String(t)] ?? nameOf(String(t));
  switch (channel) {
    case 'motion': return motionLabel(o.name as string | undefined);
    case 'expression': return expressionLabel(o.name as string | null | undefined);
    case 'head': case 'body': return o.mode === 'angle' ? `${Number(o.yaw).toFixed(2)}` : `看${who(o.target)}`;
    case 'gaze': return 'target' in o ? `看${who(o.target)}` : `${Number(o.x).toFixed(1)},${Number(o.y).toFixed(1)}`;
    case 'position': return `${Number(o.slot).toFixed(2)}/${Number(o.depth).toFixed(2)}`;
    case 'opacity': return Number(v).toFixed(2);
    case 'costume': {
      const id = String(o.modelId);
      const c = splitModelId(id).costume;
      return costumeLabelZh(parseCostume(c), c);
    }
    case 'camera': return 'manual' in o ? '手动' : (SHOT_SHORT[String(o.shot)] ?? String(o.shot));
    case 'bgm': case 'se': return o.assetId ? audioName(String(o.assetId)) : '停';
    case 'fade': return `${o.color === 'white' ? '白' : '黑'} ${Number(o.alpha).toFixed(1)}`;
    case 'fx': return `${FX_LABEL[String(o.fx)] ?? String(o.fx)} ${Number(o.strength).toFixed(1)}`;
    case 'background': return `${o.purpose === 'insert' ? '插入 ' : ''}${bgName(String(o.assetId))}`;
  }
};

export function buildGroups(project: Project, scene: Scene, sceneIndex: number, compiled: CompiledScene | undefined, audioName: (id: string) => string = (id) => id, bgName: (id: string) => string = (id) => id): Group[] {
  const valueLabel = makeValueLabel((id) => project.cast.find((c) => c.id === id)?.displayName ?? id, audioName, bgName);
  const beats = storedBeatTimes(project, sceneIndex);
  const keysOf = (target: TrackTarget, channel: Channel, ghosts: LaneKey[] = []): { keys: LaneKey[]; trackId: string | null; locked: boolean } => {
    const tr = scene.tracks.find((t) => t.channel === channel && t.target.kind === target.kind && (target.kind !== 'actor' || (t.target.kind === 'actor' && t.target.castId === target.castId)));
    const keys: LaneKey[] = [];
    for (const k of tr?.keys ?? []) {
      const at = absTime(beats, k.at);
      if (at === null) continue;
      keys.push({ id: k.id, at, duration: k.duration, label: valueLabel(channel, k.value), locked: tr!.meta.locked || k.meta.locked, title: `${CHANNEL_LABEL[channel]} · ${valueLabel(channel, k.value)} @ ${at.toFixed(2)}s` });
    }
    return { keys: [...keys, ...ghosts].sort((a, b) => a.at - b.at), trackId: tr?.id ?? null, locked: tr?.meta.locked ?? false };
  };
  const lane = (id: string, label: string, group: string, color: string, target: TrackTarget, channel: Channel, ghosts: LaneKey[] = [], kind: Lane['kind'] = 'keys'): Lane => {
    const k = keysOf(target, channel, ghosts);
    return { id, label, group, color, kind, track: { target, channel, trackId: k.trackId, locked: k.locked }, keys: k.keys };
  };

  const groups: Group[] = [];
  groups.push({
    id: 'script', label: '剧本与镜头', color: 'var(--track-screen)',
    lanes: [
      lane('bg', '背景', 'script', 'var(--track-bg)', { kind: 'stage' }, 'background', [], 'background'),
      { id: 'beats', label: '对白', group: 'script', color: 'var(--track-screen)', kind: 'beats', keys: [] },
      { id: 'trans', label: '转场', group: 'script', color: 'var(--track-screen)', kind: 'transition', keys: [] },
      { id: 'shots', label: '镜头', group: 'script', color: 'var(--track-camera)', kind: 'shots', track: { target: { kind: 'camera' }, channel: 'camera', trackId: scene.tracks.find((t) => t.channel === 'camera')?.id ?? null, locked: scene.tracks.find((t) => t.channel === 'camera')?.meta.locked ?? false }, keys: keysOf({ kind: 'camera' }, 'camera').keys },
      { id: 'banner', label: '地点条', group: 'script', color: 'var(--track-screen)', kind: 'banner', keys: [] },
    ],
  });
  groups.push({
    id: 'screen', label: '特效与音频', color: 'var(--track-fx)',
    lanes: [
      lane('fx', '特效', 'screen', 'var(--track-fx)', { kind: 'screen' }, 'fx'),
      lane('fade', '黑/白场', 'screen', 'var(--track-screen)', { kind: 'screen' }, 'fade'),
      lane('bgm', 'BGM', 'screen', 'var(--track-audio)', { kind: 'audio' }, 'bgm'),
      lane('se', '音效', 'screen', 'var(--track-audio)', { kind: 'audio' }, 'se'),
    ],
  });
  for (const castId of Object.keys(scene.wardrobe)) {
    const cast = project.cast.find((c) => c.id === castId);
    const actor = compiled?.actors.find((a) => a.castId === castId);
    const ghostFor = (ch: 'expression' | 'motion' | 'head'): LaneKey[] => {
      const rks = (actor?.ruleKeys ?? []).filter((r) => r.channel === ch);
      if (ch === 'head') {
        return rks.length === 0 ? [] : rks.map((r) => ({ id: `ghost:${castId}:head:${r.beatId}`, at: r.at, duration: r.duration, label: '听者转头', locked: false, ghost: { castId, keys: rks }, title: `规则导演：听者转头（双击烘焙全部 ${rks.length} 个，转为人工关键帧）` }));
      }
      return rks.map((r) => ({ id: `ghost:${castId}:${ch}:${r.beatId}:${r.offset}`, at: r.at, duration: 0, label: valueLabel(ch, r.value), locked: false, ghost: { castId, keys: [r] }, title: `规则导演：${CHANNEL_LABEL[ch]} ${valueLabel(ch, r.value)}（${(r.value as { name?: string }).name}，双击烘焙为关键帧）` }));
    };
    groups.push({
      id: `actor:${castId}`, label: cast?.displayName ?? castId, color: 'var(--track-actor)', castId,
      lanes: ACTOR_CHANNELS.map((ch) => lane(`${castId}:${ch}`, CHANNEL_LABEL[ch], `actor:${castId}`, 'var(--track-actor)', { kind: 'actor', castId }, ch, ch === 'expression' || ch === 'motion' || ch === 'head' ? ghostFor(ch) : [])),
    });
  }
  return groups;
}

/** Times keys snap to: beat starts / the scene ends, the playhead and the other keys. */
export function snapPoints(project: Project, sceneIndex: number, extra: number[]): number[] {
  return [...storedBeatTimes(project, sceneIndex).flatMap((b) => [b.start, b.end]), ...extra];
}
