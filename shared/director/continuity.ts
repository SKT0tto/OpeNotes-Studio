/**
 * Whole-project continuity check after a generation: things a person would notice while watching.
 * Pure and deterministic; every finding points at a scene (and a beat when it has one) so the UI can jump to it.
 */
import type { BgLabel, LabelRules } from '../schema/assetLabels';
import type { Project, Scene } from '../schema/project';
import { bandText, bgFit, sceneBands } from './bandFit';
import { bgCategoryOf } from './bgCategory';
import { MAX_BG_SWITCHES } from './vocab';

export interface ContinuityWarning {
  kind: 'costume_change' | 'speaker_absent' | 'speaks_after_exit' | 'live_outside_performance' | 'adv_in_performance' | 'formation' | 'time_mismatch' | 'undirected' | 'bg_band_conflict' | 'bg_unknown_owner' | 'bg_not_stage' | 'bg_switch_decor' | 'bg_switch_band_conflict' | 'bg_switch_too_many' | 'bg_start_category';
  sceneId: string;
  beatId?: string;
  message: string;
}

export interface ContinuityLookups {
  /** modelId -> 'adv' | 'live'. */
  modeOf?: (modelId: string) => 'adv' | 'live' | undefined;
  /** characterKey -> role ("Vo.", "Dr." ...). */
  roleOf?: (characterKey: string) => string | null | undefined;
  /** background asset id -> time ("夜间" ...). */
  bgTime?: (assetId: string) => string | null | undefined;
  /** background asset id -> category (scene / insert / decor / event). */
  bgCategory?: (assetId: string) => string | undefined;
  /** background asset id -> its label. */
  bgLabel?: (assetId: string) => BgLabel | undefined;
  /** characterKey -> band / sub flag. */
  charInfo?: (characterKey: string) => { bandKey: string | null; isSub: boolean } | undefined;
  bandName?: (bandKey: string) => string;
  rules?: LabelRules;
}

/** Lookups for checkContinuity from a catalog (client and server share this). */
export function catalogLookups(cat: { models: Array<{ id: string; mode: 'adv' | 'live' }>; characters: Array<{ key: string; role: string | null; bandKey: string | null; isSub: boolean }>; backgrounds: Array<{ id: string; time: string | null; kind?: string | null; labels?: BgLabel | undefined }>; bands: Array<{ key: string; name: string }>; labelRules?: LabelRules | undefined } | null): ContinuityLookups {
  return {
    modeOf: (id) => cat?.models.find((m) => m.id === id)?.mode,
    roleOf: (key) => cat?.characters.find((c) => c.key === key)?.role,
    bgTime: (id) => cat?.backgrounds.find((b) => b.id === id)?.time,
    bgLabel: (id) => cat?.backgrounds.find((b) => b.id === id)?.labels,
    bgCategory: (id) => { const b = cat?.backgrounds.find((x) => x.id === id); return b ? bgCategoryOf({ id: b.id, kind: b.kind ?? null, labels: b.labels }) : undefined; },
    charInfo: (key) => cat?.characters.find((c) => c.key === key),
    bandName: (k) => cat?.bands.find((b) => b.key === k)?.name ?? k,
    ...(cat?.labelRules ? { rules: cat.labelRules } : {}),
  };
}

const TIME_GROUP: Record<string, string> = { 夜晚: 'night', 夜间: 'night', 傍晚: 'dusk', 早晨: 'day', 白天: 'day', 日间: 'day' };

const nameOf = (p: Project, id: string) => p.cast.find((c) => c.id === id)?.displayName ?? id;

export function checkContinuity(project: Project, lk: ContinuityLookups = {}): ContinuityWarning[] {
  const out: ContinuityWarning[] = [];
  const keyOf = (id: string) => project.cast.find((c) => c.id === id)?.characterKey ?? '';
  project.scenes.forEach((scene, si) => {
    const prev: Scene | undefined = project.scenes[si - 1];
    const t = `「${scene.title}」`;
    const performance = scene.brief?.isPerformance === true;

    if (scene.beats.length > 0 && scene.beats.every((b) => b.meta.source === 'rule' && b.meta.reason?.startsWith('原文段落'))) {
      out.push({ kind: 'undirected', sceneId: scene.id, message: `${t}还只是原文旁白，没有生成演出` });
    }

    // costumes across scenes: a change needs a reason (the director's wardrobe reason or a costume key at the start)
    if (prev) {
      for (const [castId, w] of Object.entries(scene.wardrobe)) {
        const before = prev.wardrobe[castId];
        if (!before || before.modelId === w.modelId) continue;
        const firstBeat = scene.beats[0]?.id;
        const hasKey = scene.tracks.some((tr) => tr.channel === 'costume' && tr.target.kind === 'actor' && tr.target.castId === castId && tr.keys.some((k) => k.at.beatId === firstBeat));
        if (!w.meta.reason && !hasKey) out.push({ kind: 'costume_change', sceneId: scene.id, message: `${t}：${nameOf(project, castId)} 的服装与上一场景不同（${before.modelId} → ${w.modelId}），没有换装理由` });
      }
    }

    // modes
    for (const [castId, w] of Object.entries(scene.wardrobe)) {
      const mode = lk.modeOf?.(w.modelId);
      if (mode === 'live' && !performance) out.push({ kind: 'live_outside_performance', sceneId: scene.id, message: `${t}：${nameOf(project, castId)} 穿着演出形态（live-mode）但这不是正式演出` });
      if (mode === 'adv' && performance && scene.brief?.band) out.push({ kind: 'adv_in_performance', sceneId: scene.id, message: `${t}：正式演出里 ${nameOf(project, castId)} 不是演奏形态` });
    }

    // performance formation: the vocalist stands in front and near the middle, the drummer at the back
    if (performance && lk.roleOf) {
      for (const [castId, b] of Object.entries(scene.blocking)) {
        const role = lk.roleOf(keyOf(castId));
        if (role === 'Vo.' && (Math.abs(b.slot) > 0.35 || b.depth > 0.35)) out.push({ kind: 'formation', sceneId: scene.id, message: `${t}：主唱 ${nameOf(project, castId)} 应站在前排中央（现在 ${b.slot.toFixed(2)} / ${b.depth.toFixed(2)}）` });
        if (role === 'Dr.' && b.depth < 0.5) out.push({ kind: 'formation', sceneId: scene.id, message: `${t}：鼓手 ${nameOf(project, castId)} 应在后排（现在深度 ${b.depth.toFixed(2)}）` });
      }
    }

    // time of day against the background
    const bt = lk.bgTime?.(scene.background.assetId);
    const want = scene.brief?.timeOfDay ? TIME_GROUP[scene.brief.timeOfDay] : undefined;
    const have = bt ? TIME_GROUP[bt] : undefined;
    if (want && have && want !== have && !(want === 'dusk' && have === 'day')) out.push({ kind: 'time_mismatch', sceneId: scene.id, message: `${t}：场景是「${scene.brief?.timeOfDay}」，背景却是「${bt}」` });

    // background against the bands on stage (manual choices are allowed, but flagged)
    const label = lk.bgLabel?.(scene.background.assetId);
    if (label && lk.charInfo) {
      const keys = Object.keys(scene.wardrobe).map(keyOf).filter(Boolean);
      const infos = new Map(keys.flatMap((k) => { const i = lk.charInfo!(k); return i ? [[k, i] as const] : []; }));
      const fit = bgFit(label, { bands: sceneBands(infos, keys), cast: keys, guestOf: scene.brief?.guestOf ?? null, mood: scene.brief?.mood, text: `${scene.title} ${scene.brief?.mood ?? ''}` }, lk.rules);
      const bn = lk.bandName ?? ((k: string) => k);
      if (fit === 'no') out.push({ kind: 'bg_band_conflict', sceneId: scene.id, message: `${t}：背景属于 ${bandText(label, bn)}，与出场角色冲突` });
      else if (fit === 'fallback') out.push({ kind: 'bg_unknown_owner', sceneId: scene.id, message: `${t}：背景的主人/归属不明（仅作兜底），请确认是否合适` });
      if (performance && !label.stage) out.push({ kind: 'bg_not_stage', sceneId: scene.id, message: `${t}：这是正式演出，背景却不是舞台` });
    }

    // the start background is a story background
    const startCat = lk.bgCategory?.(scene.background.assetId);
    if (startCat === 'decor' || startCat === 'insert') out.push({ kind: 'bg_start_category', sceneId: scene.id, message: `${t}：开场背景是${startCat === 'decor' ? '装饰素材（logo / 纯色 / 界面）' : '插入镜头素材'}，建议换成剧情背景` });

    // background switches inside the scene (P20)
    const switches = scene.tracks.filter((tr) => tr.channel === 'background').flatMap((tr) => tr.keys);
    if (switches.length > MAX_BG_SWITCHES) out.push({ kind: 'bg_switch_too_many', sceneId: scene.id, message: `${t}：一个场景里换了 ${switches.length} 次背景（超过 ${MAX_BG_SWITCHES} 次），观感会很碎` });
    for (const k of switches) {
      const v = k.value as { assetId: string; purpose?: string };
      if (lk.bgCategory?.(v.assetId) === 'decor') out.push({ kind: 'bg_switch_decor', sceneId: scene.id, beatId: k.at.beatId, message: `${t}：背景切换用了装饰素材 ${v.assetId}（手动选择的话请确认）` });
      const lab = lk.bgLabel?.(v.assetId);
      if (lab && lk.charInfo && v.purpose !== 'insert') {
        const keys = Object.keys(scene.wardrobe).map(keyOf).filter(Boolean);
        const infos = new Map(keys.flatMap((kk) => { const i = lk.charInfo!(kk); return i ? [[kk, i] as const] : []; }));
        if (bgFit(lab, { bands: sceneBands(infos, keys), cast: keys, guestOf: scene.brief?.guestOf ?? null, mood: scene.brief?.mood, text: `${scene.title} ${scene.brief?.mood ?? ''}` }, lk.rules) === 'no') {
          out.push({ kind: 'bg_switch_band_conflict', sceneId: scene.id, beatId: k.at.beatId, message: `${t}：切换后的背景属于 ${bandText(lab, lk.bandName ?? ((x: string) => x))}，与出场角色冲突` });
        }
      }
    }

    // speakers: on stage, and not after leaving
    const gone = new Set<string>();
    const opacity = (castId: string, beatId: string) =>
      scene.tracks.flatMap((tr) => (tr.channel === 'opacity' && tr.target.kind === 'actor' && tr.target.castId === castId ? tr.keys : [])).filter((k) => k.at.beatId === beatId).map((k) => k.value);
    for (const b of scene.beats) {
      for (const castId of Object.keys(scene.wardrobe)) {
        const v = opacity(castId, b.id);
        if (v.length > 0) {
          if (v.at(-1)! <= 0) gone.add(castId);
          else gone.delete(castId);
        }
      }
      if (b.kind !== 'dialogue' || !b.speakerId) continue;
      if (!scene.wardrobe[b.speakerId]) out.push({ kind: 'speaker_absent', sceneId: scene.id, beatId: b.id, message: `${t}：${nameOf(project, b.speakerId)} 说话了，但不在这个场景里` });
      else if (gone.has(b.speakerId)) out.push({ kind: 'speaks_after_exit', sceneId: scene.id, beatId: b.id, message: `${t}：${nameOf(project, b.speakerId)} 离场之后又说话了` });
    }
  });
  return out;
}
