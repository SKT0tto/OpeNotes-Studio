/**
 * Semantic validation + deterministic repair of the two AI passes (after the zod parse succeeded).
 * Nothing here trusts the model: every id must exist in the catalog / scene, otherwise it is repaired or dropped with a
 * warning. `errors` are what could not be repaired (the caller may spend one LLM repair call on them).
 */
import type { BgMove, Breakdown, DirectedBeat, SceneDirection } from '../schema/ai';
import type { BackgroundEntry, ModelEntry } from '../schema/assets';
import { EMOTION_EXPR } from '../timeline/compile';
import { canon, familyOfName, isIdleFamily, mapExpressionName, mapMotionFamily } from '../timeline/motionMap';
import { traceability, type Paragraph } from './paragraphs';
import { defaultModel, lookup, rankBackgrounds, selectable, type DirectorCatalog, type Lookup } from './resources';
import { INSERT_HINT, MAX_BG_MOVES, MAX_DIM_BEATS, MEMORY_CUE, MONOLOGUE_TEXT, SPECIAL_ATTENTION, TRAVEL_INSERT_HINT } from './vocab';
import { stageEvents, stageTimeline } from './stage';
import { normalizeIntents } from './intentNormalize';
import { allowedBackgrounds, bandText, bgFit, sceneBands, type SceneWho } from './bandFit';
import { EVENT_CUE, autoSelectable, bgCategoryOf } from './bgCategory';

export interface Validated<T> {
  value: T;
  warnings: string[];
  /** Structural problems the deterministic repair could not fix. */
  errors: string[];
}

// ---- Pass 1 ------------------------------------------------------------------------------------------------------
export function validateBreakdown(input: Breakdown, ctx: { catalog: DirectorCatalog; paragraphCount: number; paragraphOffset?: number }): Validated<Breakdown> {
  const L = lookup(ctx.catalog);
  const warnings: string[] = [];
  const errors: string[] = [];
  const b: Breakdown = JSON.parse(JSON.stringify(input)) as Breakdown;
  const isChar = (k: string) => L.characters.has(k) && !L.characters.get(k)!.isSub;

  for (const c of b.cast) {
    if (c.characterKey !== null && !isChar(c.characterKey)) {
      warnings.push(`角色「${c.nameInText}」的 characterKey ${c.characterKey} 不存在，已作为未映射角色（仅旁白）`);
      c.characterKey = null;
    }
  }

  const first = ctx.paragraphOffset ?? 0;
  const last = first + ctx.paragraphCount - 1;
  // contiguous, ordered, covering ranges
  b.scenes.sort((x, y) => x.startParagraph - y.startParagraph);
  b.scenes = b.scenes.filter((s) => s.endParagraph >= first && s.startParagraph <= last);
  if (b.scenes.length === 0) errors.push('没有任何场景（或场景段落范围都在文本之外）');
  b.scenes.forEach((s, i) => {
    const start = i === 0 ? first : Math.max(s.startParagraph, b.scenes[i - 1]!.endParagraph + 1);
    const next = b.scenes[i + 1];
    const end = next ? Math.max(start, Math.min(s.endParagraph, next.startParagraph - 1)) : last;
    if (start !== s.startParagraph || end !== s.endParagraph) warnings.push(`场景「${s.title}」的段落范围 ${s.startParagraph}–${s.endParagraph} 已调整为 ${start}–${end}`);
    s.startParagraph = start;
    s.endParagraph = end;
  });
  // an end that stops short of the next start leaves a gap: extend
  b.scenes.forEach((s, i) => {
    const next = b.scenes[i + 1];
    if (next && next.startParagraph > s.endParagraph + 1) {
      warnings.push(`场景「${s.title}」与下一场景之间有段落空缺，已延长`);
      s.endParagraph = next.startParagraph - 1;
    }
  });

  for (const s of b.scenes) {
    // background
    if (!L.backgrounds.has(s.location.backgroundId)) {
      const best = rankBackgrounds(ctx.catalog.backgrounds.filter((b) => autoSelectable(b, 'scene')), `${s.title} ${s.location.reason} ${s.location.backgroundId} ${s.mood}`, { time: s.timeOfDay })[0];
      if (best) {
        warnings.push(`场景「${s.title}」的背景 ${s.location.backgroundId} 不存在，已换成最相近的 ${best.id}（${best.name}）`);
        s.location.backgroundId = best.id;
      } else errors.push(`场景「${s.title}」没有可用背景`);
    }
    // people: keys must be real, stage-capable characters
    const present = new Set<string>();
    for (const k of s.presentCast) {
      if (isChar(k)) present.add(k);
      else warnings.push(`场景「${s.title}」的在场角色 ${k} 不存在，已忽略`);
    }
    const wardrobe = new Map<string, Breakdown['scenes'][number]['wardrobe'][number]>();
    for (const w of s.wardrobe) {
      if (!isChar(w.characterKey)) {
        warnings.push(`场景「${s.title}」的服装条目角色 ${w.characterKey} 不存在，已忽略`);
        continue;
      }
      present.add(w.characterKey);
      wardrobe.set(w.characterKey, w);
    }
    for (const key of present) {
      const w = wardrobe.get(key);
      const m = w ? L.models.get(w.modelId) : undefined;
      let bad: string | null = null;
      if (!w) bad = '缺少服装';
      else if (!m) bad = `服装 ${w.modelId} 不存在`;
      else if (m.characterKey !== key) bad = `服装 ${w.modelId} 不属于该角色`;
      else if (m.quality === 'low' || m.still) bad = `服装 ${w.modelId} 是低质量/静态版本`;
      else if (m.mode === 'live' && !s.isPerformance) bad = `非演出场景不能用 live-mode 服装 ${w.modelId}`;
      else if (m.mode === 'adv' && s.isPerformance && defaultModel(L, key, { live: true })) bad = `演出场景应使用 live-mode 服装（${w!.modelId} 不是）`;
      if (bad) {
        const wantLive = s.isPerformance && !!defaultModel(L, key, { live: true });
        const fix = defaultModel(L, key, { live: wantLive }) ?? defaultModel(L, key);
        if (fix) {
          warnings.push(`场景「${s.title}」${L.characters.get(key)?.name ?? key}：${bad}，已改为 ${fix.id}`);
          wardrobe.set(key, { characterKey: key, modelId: fix.id, reason: w?.reason ?? '默认服装' });
        } else {
          warnings.push(`场景「${s.title}」${key} 没有可用服装，已移出在场角色`);
          present.delete(key);
          wardrobe.delete(key);
        }
      }
    }
    s.presentCast = [...present];
    s.wardrobe = s.presentCast.map((k) => wardrobe.get(k)!);
    warnings.push(...repairBackground(s, ctx.catalog, L));
    warnings.push(...repairMoves(s, ctx.catalog, L));
    if (s.band !== null && !ctx.catalog.bands.some((x) => x.key === s.band || x.name === s.band)) {
      warnings.push(`场景「${s.title}」的乐队 ${s.band} 不存在，已清除`);
      s.band = null;
    }
  }
  return { value: b, warnings, errors };
}

/** Why a background must not be chosen automatically for a scene (category rules), or null. */
export function categoryProblem(b: BackgroundEntry, text: string, performance: boolean): string | null {
  if (b.labels?.duplicateOf) return '同一画面的重复拷贝';
  const c = bgCategoryOf(b);
  if (c === 'decor') return '装饰素材';
  if (c === 'insert') return '插入镜头素材';
  if (c === 'event' && !(performance && b.labels?.stage) && !EVENT_CUE.test(text)) return '特殊画面（原文没有梦境、回忆等线索）';
  return null;
}

export interface BgScope {
  title: string;
  reason: string;
  mood: string;
  timeOfDay: string;
  isPerformance: boolean;
  presentCast: readonly string[];
  guestOf?: string | null | undefined;
}

/**
 * Deterministic check of one background choice for a scene: category (decor / insert / event / duplicate), band and stage fit.
 * Returns the id to use (the same one when it is fine), and the Chinese warning when it had to change. `label` names the place in the text.
 */
export function repairBgChoice(id: string, scope: BgScope, cat: DirectorCatalog, L: Lookup, label: string, extraText = ''): { id: string; warning: string | null } {
  const cur = L.backgrounds.get(id);
  if (!cur) return { id, warning: null };
  const text = `${scope.title} ${scope.reason} ${scope.mood} ${extraText}`;
  const catBad = categoryProblem(cur, text, scope.isPerformance);
  if (!catBad && !cat.backgrounds.some((b) => b.labels)) return { id, warning: null };
  const who: SceneWho = { bands: sceneBands(L.characters, [...scope.presentCast]), cast: scope.presentCast, guestOf: scope.guestOf ?? null, mood: `${scope.mood} ${scope.timeOfDay}`, text };
  const bandName = (k: string) => cat.bands.find((b) => b.key === k)?.name ?? k;
  const stageBad = scope.isPerformance && cur.labels !== undefined && !cur.labels.stage;
  const fit = bgFit(cur.labels, who, cat.labelRules);
  if (!catBad && fit === 'ok' && !stageBad) return { id, warning: null };
  if (!catBad && fit === 'fallback' && !stageBad) return { id, warning: `${label}的背景 ${cur.id}（${cur.name}）主人不明，仅作兜底使用，请确认` };
  const { ok, fallback } = allowedBackgrounds(cat.backgrounds, who, { performance: scope.isPerformance, rules: cat.labelRules });
  const pool = ok.length > 0 ? ok : fallback;
  const why = catBad ? `是${catBad}` : stageBad && fit !== 'no' ? '正式演出需要舞台背景' : `属于 ${bandText(cur.labels, bandName)}，与出场乐队冲突`;
  // a duplicate copy goes back to its master when the master is fine
  const master = cur.labels?.duplicateOf ? pool.find((b) => b.id === cur.labels!.duplicateOf) : undefined;
  const best = master ?? rankBackgrounds(pool, `${scope.title} ${scope.reason} ${cur.name} ${cur.location ?? ''}`, { ...(cur.setting ? { setting: cur.setting } : {}), time: scope.timeOfDay })[0];
  if (!best) return { id, warning: `${label}的背景 ${cur.name} ${why}，但没有可替换的合规背景，已保留` };
  return { id: best.id, warning: `${label}的背景 ${cur.id}（${cur.name}）${why}，已换成 ${best.id}（${best.name}）` };
}

/** Band/stage/category fit of the chosen background; a conflicting one is replaced by the best compliant background (deterministic). Returns warnings. */
export function repairBackground(s: Breakdown['scenes'][number], cat: DirectorCatalog, L: Lookup): string[] {
  const r = repairBgChoice(s.location.backgroundId, { title: s.title, reason: s.location.reason, mood: s.mood, timeOfDay: s.timeOfDay, isPerformance: s.isPerformance, presentCast: s.presentCast, guestOf: s.location.guestOf ?? null }, cat, L, `场景「${s.title}」`);
  if (r.id !== s.location.backgroundId) {
    s.location.reason = `${s.location.reason}（已由 ${s.location.backgroundId} 换成合规背景）`;
    s.location.backgroundId = r.id;
  }
  return r.warning ? [r.warning] : [];
}

/**
 * Place changes inside a scene (Pass 1 `moves`): inside the scene's paragraphs, existing and compliant backgrounds only (same rules as the
 * start background), several in one paragraph merge into the last, a move to the place already shown is dropped, at most MAX_BG_MOVES.
 */
export function repairMoves(s: Breakdown['scenes'][number], cat: DirectorCatalog, L: Lookup): string[] {
  const warnings: string[] = [];
  const moves = s.moves ?? [];
  if (moves.length === 0) {
    if (s.moves) delete s.moves;
    return warnings;
  }
  const scope = (m: BgMove) => ({ title: s.title, reason: `${m.reason} ${s.location.reason}`, mood: s.mood, timeOfDay: s.timeOfDay, isPerformance: s.isPerformance, presentCast: s.presentCast, guestOf: s.location.guestOf ?? null });
  let out: BgMove[] = [];
  for (const m0 of moves) {
    const m: BgMove = { ...m0 };
    const where = `场景「${s.title}」第 ${m.paragraph} 段移动`;
    const clamped = Math.min(s.endParagraph, Math.max(s.startParagraph, m.paragraph));
    if (clamped !== m.paragraph) {
      warnings.push(`${where}的段落号超出场景范围 ${s.startParagraph}–${s.endParagraph}，已改为 ${clamped}`);
      m.paragraph = clamped;
    }
    if (!L.backgrounds.has(m.backgroundId)) {
      const best = rankBackgrounds(cat.backgrounds.filter((b) => autoSelectable(b, 'scene')), `${m.reason} ${m.backgroundId} ${s.title}`, { time: s.timeOfDay })[0];
      if (!best) {
        warnings.push(`${where}到不存在的背景 ${m.backgroundId}，已忽略`);
        continue;
      }
      warnings.push(`${where}到的背景 ${m.backgroundId} 不存在，已换成最相近的 ${best.id}（${best.name}）`);
      m.backgroundId = best.id;
    }
    const r = repairBgChoice(m.backgroundId, scope(m), cat, L, where);
    if (r.warning) warnings.push(r.warning);
    m.backgroundId = r.id;
    out.push(m);
  }
  // several moves at one paragraph = one switch (the last wins); order by paragraph
  const byPara = new Map<number, BgMove>();
  for (const m of out) {
    if (byPara.has(m.paragraph)) warnings.push(`场景「${s.title}」第 ${m.paragraph} 段有多次背景切换，已合并为最后一次`);
    byPara.set(m.paragraph, m);
  }
  out = [...byPara.values()].sort((a, b) => a.paragraph - b.paragraph);
  // a switch to the place that is already shown does nothing
  let cur = s.location.backgroundId;
  out = out.filter((m) => {
    if (m.backgroundId === cur) {
      warnings.push(`场景「${s.title}」第 ${m.paragraph} 段切换到已经在用的背景 ${m.backgroundId}，已删除`);
      return false;
    }
    cur = m.backgroundId;
    return true;
  });
  if (out.length > MAX_BG_MOVES) {
    warnings.push(`场景「${s.title}」的背景移动有 ${out.length} 次，超过上限 ${MAX_BG_MOVES}，只保留前 ${MAX_BG_MOVES} 次`);
    out = out.slice(0, MAX_BG_MOVES);
  }
  if (out.length > 0) s.moves = out;
  else delete s.moves;
  return warnings;
}

// ---- Pass 2 ------------------------------------------------------------------------------------------------------
export interface DirectionContext {
  catalog: DirectorCatalog;
  /** People on stage with their outfit at the start of the scene. */
  cast: Array<{ castId: string; characterKey: string; modelId: string }>;
  paragraphs: Paragraph[];
  /** Inclusive paragraph range of the scene. */
  range: { start: number; end: number };
  isPerformance: boolean;
  /** Ids of existing beats the model was told to keep (locked / hand-made / the beats of a partial regeneration). */
  fixedBeatIds?: Set<string>;
  /** Camera system of the scene: classic drops `shot.flow`, travel checks it. Absent = classic. */
  cameraSystem?: 'classic' | 'travel';
  /** Stage slot of every person at the start of the scene. No longer used by the checks (a travel two-shot is judged by who is on stage, not by seating); kept so callers stay compatible. */
  slots?: Record<string, number>;
  /** People who had already left the stage before the first beat given (the later span of a long scene). */
  awayAtStart?: ReadonlySet<string>;
  /** Backgrounds of this scene (P20): the start background, the ones Pass 1 moved to, and the cut-away candidates. Absent = background switches are not checked. */
  backgrounds?: { start: string; allowed: ReadonlySet<string>; scope: BgScope };
}

/** The partner a travel two-shot should have: the wanted one if he is the speaker's neighbour, else the previous speaker or the listener next to the speaker. Null when there is no neighbour. */
export function pairNeighbours(order: readonly string[], speaker: string, wanted: string, prevSpeaker: string | null): string | null {
  const at = order.indexOf(speaker);
  if (at < 0) return wanted;
  const neighbours = [order[at - 1], order[at + 1]].filter((x): x is string => !!x);
  if (neighbours.length === 0) return null;
  if (neighbours.includes(wanted)) return wanted;
  if (prevSpeaker && neighbours.includes(prevSpeaker)) return prevSpeaker;
  const wantedAt = order.indexOf(wanted);
  const toward = wantedAt < at ? order[at - 1] : order[at + 1];
  return toward ?? neighbours[0]!;
}

export const familyOf = (name: string): string => familyOfName(name);

/**
 * The family to use for a wanted motion: the same family, the same kind with another number, a keyword category, the emotion
 * table, a mild generic gesture - never "nothing" for a model that has any gesture (null only for a model with idles only).
 */
export function repairMotion(m: ModelEntry, wanted: string, emotion: string): string | null {
  // idle is automatic and never a directed gesture: a request for it becomes the emotion's gesture
  return mapMotionFamily(m.motions, isIdleFamily(canon(wanted)) ? '' : wanted, emotion, m.id);
}

/** The expression to use for a wanted one (closest by name, keyword, emotion, else the neutral one); null only for models without expressions. */
export function repairExpression(m: ModelEntry, wanted: string, emotion: string): string | null {
  if (m.mode === 'live') return null;
  return mapExpressionName(m.expressions.map((e) => e.name), wanted, emotion, EMOTION_EXPR);
}

const LEGACY_SHOT: Record<string, DirectedBeat['shot']['type']> = { closeup: 'cu', bust: 'mcu', medium: 'mcu', wide: 'group', establishing: 'group' };

export function validateDirection(input: SceneDirection, ctx: DirectionContext): Validated<SceneDirection> {
  const L: Lookup = lookup(ctx.catalog);
  const warnings: string[] = [];
  const errors: string[] = [];
  const d: SceneDirection = JSON.parse(JSON.stringify(input)) as SceneDirection;
  const castIds = new Set(ctx.cast.map((c) => c.castId));
  const keyOf = new Map(ctx.cast.map((c) => [c.castId, c.characterKey]));
  const present = (id: string | null | undefined): id is string => !!id && castIds.has(id);

  // blocking
  const seen = new Set<string>();
  d.blocking = d.blocking.filter((b) => {
    if (!castIds.has(b.castId)) {
      warnings.push(`站位里的 ${b.castId} 不在场景中，已忽略`);
      return false;
    }
    if (seen.has(b.castId)) return false;
    seen.add(b.castId);
    return true;
  });

  // who is on stage at each beat (enter / exit flags of the actors): a travel two-shot never pairs a person who is not there
  const timeline = stageTimeline(d.beats, ctx.cast.map((c) => c.castId), ctx.awayAtStart);

  if (d.bgm !== null && !L.audio.has(d.bgm)) {
    warnings.push(`BGM ${d.bgm} 不存在，已清除`);
    d.bgm = null;
  }

  // costume changes: real outfit of that character, valid beat
  const lastBeat = Math.max(0, d.beats.length - 1);
  const reject = (msg: string): false => (warnings.push(msg), false);
  d.costumeChanges = d.costumeChanges.filter((c) => {
    const m = L.models.get(c.modelId);
    if (!castIds.has(c.castId)) return reject(`换装的角色 ${c.castId} 不在场景中，已忽略`);
    if (!m || m.characterKey !== keyOf.get(c.castId)) return reject(`换装 ${c.castId} → ${c.modelId} 不是该角色的服装，已忽略`);
    if (!selectable(m, { live: m.mode === 'live' })) return reject(`换装 ${c.modelId} 是低质量/静态版本，已忽略`);
    if ((m.mode === 'live') !== ctx.isPerformance) return reject(`换装 ${c.modelId}：live-mode 与场景类型不符，已忽略`);
    c.beatIndex = Math.min(lastBeat, Math.max(0, c.beatIndex));
    return true;
  });
  const modelAt = (castId: string, beatIndex: number): ModelEntry | undefined => {
    let id = ctx.cast.find((c) => c.castId === castId)?.modelId;
    for (const c of [...d.costumeChanges].sort((a, b) => a.beatIndex - b.beatIndex)) if (c.castId === castId && c.beatIndex <= beatIndex) id = c.modelId;
    return id ? L.models.get(id) : undefined;
  };

  // ---- background switches of the beats (P20): the set of the scene, category rules, no repeats
  let curBg = ctx.backgrounds?.start ?? '';
  const sceneInserts = new Set<number>();
  d.beats.forEach((b, bi) => {
    if (!b.bg) {
      if (b.bg === null) delete b.bg;
      return;
    }
    const where = `第 ${bi + 1} 句的背景切换`;
    const drop = (why: string) => {
      warnings.push(`${where}：${why}，已忽略`);
      delete b.bg;
    };
    if (!ctx.backgrounds) return drop('这个场景不接受背景切换');
    const bg = L.backgrounds.get(b.bg.backgroundId);
    if (!bg) return drop(`背景 ${b.bg.backgroundId} 不存在`);
    const isInsert = bgCategoryOf(bg) === 'insert';
    if (isInsert) {
      if (!(b.shot.type === 'insert' && b.shot.insertTarget === 'scene')) return drop(`插入镜头背景 ${bg.id}（${bg.name}）只能用在没有人物焦点的插入镜头（shot.type=insert 且 insertTarget=scene）`);
      if (!ctx.backgrounds.allowed.has(bg.id)) return drop(`背景 ${bg.id}（${bg.name}）不在本场景的背景集合里`);
      sceneInserts.add(bi);
      return;
    }
    const r = repairBgChoice(bg.id, ctx.backgrounds.scope, ctx.catalog, L, where);
    if (r.warning) warnings.push(r.warning);
    b.bg.backgroundId = r.id;
    if (!ctx.backgrounds.allowed.has(r.id)) return drop(`背景 ${r.id} 不在本场景的背景集合里（不得新增地点）`);
    if (r.id === curBg) return drop(`已经是背景 ${r.id}`);
    curBg = r.id;
  });
  const paraOf = (i: number) => ctx.paragraphs[i];
  const inRange = (i: number) => i >= ctx.range.start && i <= ctx.range.end;
  let dialogue = 0;
  let untraceable = 0;
  const usedKeep = new Set<string>();

  d.beats.forEach((b, bi) => {
    const where = `第 ${bi + 1} 句`;
    if (!inRange(b.paragraph)) {
      const c = Math.min(ctx.range.end, Math.max(ctx.range.start, b.paragraph));
      warnings.push(`${where}的段落号 ${b.paragraph} 超出场景范围 ${ctx.range.start}–${ctx.range.end}，已改为 ${c}`);
      b.paragraph = c;
    }
    if (b.keepId !== null) {
      if (!ctx.fixedBeatIds?.has(b.keepId) || usedKeep.has(b.keepId)) {
        warnings.push(`${where}的 keepId ${b.keepId} 无效，已忽略`);
        b.keepId = null;
      } else usedKeep.add(b.keepId);
    }
    // speaker
    if (b.kind === 'dialogue') {
      if (!present(b.speaker)) {
        warnings.push(`${where}的说话人 ${b.speaker ?? '(空)'} 不在场，已改为旁白`);
        b.kind = 'narration';
        b.speaker = null;
      }
    } else if (b.speaker !== null) b.speaker = null;
    if (b.kind === 'dialogue' && b.keepId === null) {
      // spoken lines are shown without their quotation marks (the name plate already says who speaks)
      const t = b.text.trim().replace(/^[“"「『]+/, '').replace(/[”"」』]+$/, '');
      if (t !== b.text && t.length > 0) b.text = t;
    }
    if (b.kind === 'silent') b.text = '';
    // text must come from the source paragraph (beats the model only reproduces from the project - locked or hand-written - are exempt)
    if (b.kind !== 'silent' && b.keepId === null) {
      const para = paraOf(b.paragraph);
      let t = para ? traceability(b.text, para.text) : 0;
      const need = b.kind === 'dialogue' ? 0.6 : 0.3;
      if (t < need) {
        const alt = ctx.paragraphs.filter((p) => inRange(p.index)).map((p) => ({ p, t: traceability(b.text, p.text) })).sort((x, y) => y.t - x.t)[0];
        if (alt && alt.t >= need) {
          warnings.push(`${where}的文本在第 ${alt.p.index} 段（不是 ${b.paragraph}），已更正段落号`);
          b.paragraph = alt.p.index;
          t = alt.t;
        }
      }
      if (b.kind === 'dialogue') dialogue++;
      if (t < need) {
        if (b.kind === 'dialogue') untraceable++;
        warnings.push(`${where}的文本无法回溯到原文段落 ${b.paragraph}`);
      }
    }
    // shot
    const legacy = LEGACY_SHOT[b.shot.type as string];
    if (legacy) {
      warnings.push(`${where}的景别 ${b.shot.type} 已改为 ${legacy}`);
      b.shot.type = legacy;
    }
    // the medium shot belongs to the travel camera system; the classic one uses mcu for it
    if (b.shot.type === 'ms' && ctx.cameraSystem !== 'travel') {
      warnings.push(`${where}的景别 ms 只用于运镜系统，已改为 mcu`);
      b.shot.type = 'mcu';
    }
    b.shot.focus = [...new Set(b.shot.focus.filter(present))];
    if (b.shot.focus.length === 0 && b.shot.type !== 'group') b.shot.focus = b.speaker ? [b.speaker] : ctx.cast.slice(0, 1).map((c) => c.castId);
    if (b.shot.type === 'two_shot' && b.shot.focus.length < 2) {
      const other = ctx.cast.find((c) => !b.shot.focus.includes(c.castId))?.castId;
      if (other) b.shot.focus.push(other);
      else b.shot.type = 'mcu';
    }
    // travel: a two-shot is the two people who are talking (the model's pair is kept, also when somebody stands between them - the camera keeps
    // the middle person in frame). Only a partner who is not on stage at this beat (not yet entered / already gone) is replaced: by the previous or
    // next speaker, else by who the speaker looks at, else the shot becomes a medium shot of the speaker. A user's / locked beat is never touched.
    if (ctx.cameraSystem === 'travel' && b.shot.type === 'two_shot' && b.shot.focus.length >= 2 && !(b.keepId && ctx.fixedBeatIds?.has(b.keepId))) {
      const on = timeline[bi]!;
      const spk = b.speaker && b.shot.focus.includes(b.speaker) ? b.speaker : b.shot.focus[0]!;
      const partner = b.shot.focus.find((x) => x !== spk)!;
      if (!on.has(partner)) {
        const ok = (x: string | null | undefined): x is string => !!x && x !== spk && present(x) && on.has(x);
        const prevSpeaker = [...d.beats.slice(0, bi)].reverse().find((x) => x.kind === 'dialogue' && ok(x.speaker))?.speaker;
        const nextSpeaker = d.beats.slice(bi + 1, bi + 4).find((x) => x.kind === 'dialogue' && ok(x.speaker))?.speaker;
        const looksAt = b.actors.find((a) => a.castId === spk && ok(a.attention))?.attention;
        const fix = [prevSpeaker, nextSpeaker, looksAt].find(ok);
        if (fix) {
          warnings.push(`${where}的双人镜头里的 ${partner} 此刻不在台上，已改为与 ${fix} 同框`);
          b.shot.focus = [spk, fix];
        } else {
          warnings.push(`${where}的双人镜头里的 ${partner} 此刻不在台上，找不到合适的搭档，已改为 ${spk} 的单人中景`);
          b.shot.type = 'ms';
          b.shot.focus = [spk];
        }
      }
    }
    if (b.shot.dof !== null && (b.shot.dof < 0 || b.shot.dof > 6)) b.shot.dof = Math.min(6, Math.max(0, b.shot.dof));
    // camera flow intent (travel system): `move` is only kept where the program could really travel
    if (ctx.cameraSystem !== 'travel') { delete b.shot.flow; delete b.shot.intent; }
    else if (b.shot.intent === null) delete b.shot.intent;
    if (ctx.cameraSystem === 'travel' && b.shot.flow === null) b.shot.flow = 'auto';
    else if (ctx.cameraSystem === 'travel' && b.shot.flow === 'move') {
      const prev = bi > 0 ? d.beats[bi - 1] : undefined;
      // only what the intent level can judge; whether the move is geometrically possible (distance, zoom ratio, length) is compile's call
      const why = !prev ? '这是第一拍' : b.cutIn !== 'cut' ? '此拍经过黑场' : b.bg ? '此拍切换了背景'
        : prev.shot.type === 'insert' || b.shot.type === 'insert' ? '插入镜头不运镜'
          : b.shot.focus.length === 0 && !b.speaker ? '此拍没有焦点' : '';
      if (why) {
        warnings.push(`${where}的运镜意图已改为自动：${why}`);
        b.shot.flow = 'auto';
      }
    }
    if (ctx.cameraSystem === 'travel' && b.shot.move !== 'static') {
      warnings.push(`${where}的单镜运动已改为 static：由叙事意图和真实机位统一决定运镜，避免重复推拉`);
      b.shot.move = 'static';
    }
    // actors
    const used = new Set<string>();
    b.actors = b.actors.filter((a) => {
      if (!castIds.has(a.castId) || used.has(a.castId)) {
        if (!castIds.has(a.castId)) warnings.push(`${where}的演员 ${a.castId} 不在场景中，已忽略`);
        return false;
      }
      used.add(a.castId);
      return true;
    });
    for (const a of b.actors) {
      const m = modelAt(a.castId, bi);
      if (a.motion !== null) {
        const fix = m ? repairMotion(m, a.motion, b.emotion) : null;
        if (fix !== a.motion) warnings.push(`${where} ${a.castId} 的动作 ${a.motion} 在 ${m?.id ?? '?'} 中不存在，${fix ? `已改为 ${fix}` : '已去掉'}`);
        a.motion = fix;
      }
      if (a.expression !== null) {
        const fix = m ? repairExpression(m, a.expression, b.emotion) : null;
        if (fix !== a.expression) warnings.push(`${where} ${a.castId} 的表情 ${a.expression} 在 ${m?.id ?? '?'} 中不存在，${fix ? `已改为 ${fix}` : '已去掉'}`);
        a.expression = fix;
      }
      if (a.attention !== null && !present(a.attention) && !(SPECIAL_ATTENTION as readonly string[]).includes(a.attention)) {
        warnings.push(`${where} ${a.castId} 的视线对象 ${a.attention} 无效，已忽略`);
        a.attention = null;
      }
      if (a.attention === a.castId) a.attention = null;
    }
    // an insert only makes sense when there is something to show: a gesture, an instrument being played, a prop named in the text
    if (b.shot.type === 'insert' && b.shot.insertTarget === 'scene') {
      // a cut-away to a sky / signal / crossing: no person in it
      if (sceneInserts.has(bi)) {
        b.shot.type = 'group';
        b.shot.focus = [];
        b.shot.insertTarget = null;
        b.shot.move = 'static';
      } else {
        const fallback = ctx.cameraSystem === 'travel' ? 'ms' : 'cu';
        warnings.push(`${where}的插入镜头没有合规的插入背景，已改为 ${fallback}`);
        b.shot.type = fallback;
        b.shot.insertTarget = null;
        if (b.shot.focus.length === 0) b.shot.focus = b.speaker ? [b.speaker] : ctx.cast.slice(0, 1).map((c) => c.castId);
      }
    } else if (b.shot.type === 'insert') {
      const who = b.shot.focus[0] ?? b.speaker ?? '';
      const playing = b.actors.some((a) => a.motion !== null && /^(play|action|finish)/.test(a.motion) && modelAt(a.castId, bi)?.mode === 'live');
      // travel: a silent / narration beat has no text of its own, so the paragraph it belongs to and the model's reason say what there is to show
      const hinted = ctx.cameraSystem === 'travel' ? TRAVEL_INSERT_HINT.test([b.text, b.reason, b.kind === 'dialogue' ? '' : paraOf(b.paragraph)?.text ?? ''].join(' ')) : INSERT_HINT.test(b.text);
      if (!playing && !hinted) {
        const fallback = ctx.cameraSystem === 'travel' ? 'ms' : 'cu';
        warnings.push(`${where}的插入镜头没有可拍的手/物件/乐器，已改为 ${fallback}`);
        b.shot.type = fallback;
        b.shot.insertTarget = null;
        if (!b.shot.focus.includes(who) && who) b.shot.focus = [who];
      } else if (!b.shot.insertTarget) {
        b.shot.insertTarget = playing ? 'instrument' : 'hands';
      }
    } else if (b.shot.insertTarget) b.shot.insertTarget = null;
  });
  // screen effects (v0.4): the old `memory_glow` is read as `memory`; a memory needs a cue in the text; dim is for inner voice and never runs long;
  // a flash / shake is not repeated on neighbouring beats
  {
    d.beats.forEach((b) => {
      if (b.fx === 'memory_glow') b.fx = 'memory';
      if (b.memoryTone === null || b.fx !== 'memory') delete b.memoryTone;
      if (b.fxStrength === null || b.fx !== 'shake') delete b.fxStrength;
    });
    for (let i = 0; i < d.beats.length; i++) {
      if (d.beats[i]!.fx !== 'memory') continue;
      let j = i;
      while (j + 1 < d.beats.length && d.beats[j + 1]!.fx === 'memory') j++;
      const lo = Math.max(ctx.range.start, d.beats[i]!.paragraph - 1);
      const hi = d.beats[j]!.paragraph;
      const text = [...ctx.paragraphs.filter((p) => p.index >= lo && p.index <= hi).map((p) => p.text), ...d.beats.slice(i, j + 1).map((x) => x.text)].join(String.fromCharCode(10));
      if (!MEMORY_CUE.test(text)) {
        warnings.push(`第 ${i + 1}${j > i ? `–${j + 1}` : ''} 句标了回忆特效，但原文里没有回忆线索（回忆 / 以前 / 小时候 / 那时 / 数年前 / 当初……），已取消`);
        for (let k = i; k <= j; k++) {
          d.beats[k]!.fx = 'none';
          delete d.beats[k]!.memoryTone;
        }
      }
      i = j;
    }
    let dimRun = 0;
    d.beats.forEach((b, bi) => {
      if (b.fx === 'dim' && !(b.kind === 'narration' || MONOLOGUE_TEXT.test(b.text))) {
        warnings.push(`第 ${bi + 1} 句标了心声压暗，但它不是独白或旁白，已取消`);
        b.fx = 'none';
      }
      dimRun = b.fx === 'dim' ? dimRun + 1 : 0;
      if (b.fx === 'dim' && dimRun > MAX_DIM_BEATS) {
        warnings.push(`第 ${bi + 1} 句：压暗已连续 ${MAX_DIM_BEATS} 句，已收回（原作的压暗只在一两句心声上）`);
        b.fx = 'none';
        dimRun = 0;
      }
      const prev = d.beats[bi - 1];
      if ((b.fx === 'flash' || b.fx === 'shake') && prev && prev.fx === b.fx) {
        warnings.push(`第 ${bi + 1} 句的 ${b.fx} 紧跟着上一句的同一特效，已取消`);
        b.fx = 'none';
      }
    });
  }
  // travel: intent labels that contradict the picture are relabelled (a locked / user beat is never touched)
  if (ctx.cameraSystem === 'travel') {
    warnings.push(...normalizeIntents(d.beats, {
      castIds: ctx.cast.map((c) => c.castId), events: stageEvents(d.beats), ...(ctx.awayAtStart ? { awayAtStart: ctx.awayAtStart } : {}),
      skip: (b) => !!b.keepId && !!ctx.fixedBeatIds?.has(b.keepId), where: (i) => `第 ${i + 1} 句`,
    }));
  }
  if (d.beats.length === 0) errors.push('没有任何节拍');
  if (dialogue >= 2 && untraceable / dialogue > 0.4) errors.push(`${untraceable}/${dialogue} 句对白无法回溯到原文，文本疑似编造`);
  return { value: d, warnings, errors };
}
