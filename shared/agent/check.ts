/**
 * checkOp: the validation every op passes before it reaches a sandbox or a project. The same rules as the director (vocabulary, catalog,
 * camera system, stage presence, effect limits) plus the lock rules:
 *   zod -> existence / vocabulary / catalog -> simulate on a copy -> locks (`findLockViolations`, the editor's own gate) and hand-made units.
 * `catalog` is optional so that the browser can replay ops without the full model list (the server already normalised them).
 */
import { motionFamilies } from '../director/catalogDigest';
import { autoSelectable, bgCategoryOf } from '../director/bgCategory';
import { lookup, selectable, type DirectorCatalog, type Lookup } from '../director/resources';
import { categoryProblem } from '../director/validate';
import { expressionLabel, motionLabel } from '../catalog/labels';
import { AI_FX, AI_SHOT_TYPES, AI_TRAVEL_SHOT_TYPES, EMOTIONS, INSERT_BOX, MAX_DIM_BEATS, MEMORY_CUE, ONE_SHOT_FX, SPECIAL_ATTENTION } from '../director/vocab';
import { checkPieces } from '../director/splitLines';
import { repairPieces } from '../director/splitPieces';
import { findLockViolations, type LockViolation } from '../project/locks';
import { clone } from '../project/mutate';
import { TrackSchema, cameraSystemOf, type Project, type Scene } from '../schema/project';
import { SHOT_INTENTS } from '../staging/shotIntent';
import { EXPAND_MAX_VISIBLE } from '../style/dialogLayout';
import { styleField } from '../style/ournotes';
import { TEXT_KINDS } from '../timeline/time';
import { applyOp, fxStates, type Change } from './apply';
import { beatLineInfo, dialogMetricsOf } from './lines';
import { AgentOpSchema, type AgentOp, type SplitPieceInput } from './ops';

export type CheckStatus = 'ok' | 'needs_unlock' | 'needs_confirm' | 'invalid';
export interface CheckCtx {
  catalog?: DirectorCatalog | undefined;
  /**
   * The user's own words ask for a line to be shown in full beyond the dialogue area's maxLines (computed on the server from the instruction
   * by the agent loop: `asksForDialogExpand`). Without it no op may leave a beat with `overflow: 'expand'` that was not expanded before.
   */
  allowDialogExpand?: boolean | undefined;
  /** The user's own words ask for a line to be cut into several beats (`asksForLineSplit`). Without it `beat_split` and `beat_split_pieces` are refused. */
  allowLineSplit?: boolean | undefined;
}

export const LINE_SPLIT_NOT_ASKED = '用户没有要求拆分台词；如果这句超长，请在回复里告诉用户，并询问要不要拆（用户同意后再拆）';
export const DIALOG_EXPAND_NOT_ASKED = '只有用户明确要求时才能让对话框超过两行；请改用拆分，或在回复里告诉用户这句放不下并询问';

/** Beats that are expanded (`overflow: 'expand'`) in `project`, by id. */
const expandedBeatIds = (project: Project): Set<string> => new Set(project.scenes.flatMap((s) => s.beats.filter((b) => b.overflow === 'expand').map((b) => b.id)));
export interface CheckResult {
  status: CheckStatus;
  /** Repairs that were made, or rules that were bent: live mode does not auto-apply an op that has any. */
  warnings: string[];
  /** Informational: nothing was changed to satisfy a rule (e.g. a memory the text does not mention, as the user asked). */
  notes: string[];
  problems: string[];
  /** The op after normalisation (an unknown motion became the closest one ...). Equals the input when nothing was repaired. */
  op: AgentOp;
  changes: Change[];
  violations: LockViolation[];
  overwrote: string[];
  skipped: string[];
}

const RHYTHM_PATHS = ['rhythm.readingCps', 'rhythm.tail', 'rhythm.lineGap', 'rhythm.minLine', 'rhythm.textSpeedCps'];
export const BEAT_LOCK_FIELDS = ['text', 'speakerId', 'kind', 'duration', 'emotion', 'cutIn'];
export const SHOT_LOCK_FIELDS = ['type', 'focus', 'move', 'dof', 'transition', 'intent', 'offsets'];

export const INSERT_NEEDS_INSTRUMENT = '插入镜头只用于正在演奏的乐器特写；这里没有乐器，建议用 cu / ecu';
/** Is `castId` playing an instrument at beat `i`: a live-mode costume whose latest motion key (at or before the beat) is a play* / action* / finish* motion. Without a catalog the costume mode cannot be read, so only the motion counts. */
export function playingAt(scene: Scene, castId: string, i: number, L: Lookup | null): boolean {
  const idx = (id: string) => scene.beats.findIndex((b) => b.id === id);
  const latest = <T,>(channel: string, pick: (v: never) => T): T | undefined => {
    let best = -1, out: T | undefined;
    for (const t of scene.tracks) {
      if (t.channel !== channel || t.target.kind !== 'actor' || t.target.castId !== castId) continue;
      for (const k of t.keys) { const bi = idx(k.at.beatId); if (bi >= 0 && bi <= i && bi >= best) { best = bi; out = pick(k.value as never); } }
    }
    return out;
  };
  const motion = latest('motion', (v: { name: string }) => v.name);
  if (!motion || !/^(play|action|finish)/.test(motion)) return false;
  if (!L) return true;
  const modelId = latest('costume', (v: { modelId: string }) => v.modelId) ?? scene.wardrobe[castId]?.modelId;
  return (modelId ? L.models.get(modelId)?.mode : undefined) === 'live';
}

/** Who is on stage while beat `i` plays (enter / exit of the blocking), as the compiler reads it. */
export function onStageIds(scene: Scene, i: number): Set<string> {
  const idx = (id: string | undefined) => (id === undefined ? undefined : scene.beats.findIndex((b) => b.id === id));
  const out = new Set<string>();
  for (const [c, bl] of Object.entries(scene.blocking)) {
    const e = idx(bl.enter?.beatId);
    const x = idx(bl.exit?.beatId);
    if (e !== undefined && e >= 0 && i < e) continue;
    if (x !== undefined && x >= 0 && i >= x) continue;
    out.add(c);
  }
  for (const c of Object.keys(scene.wardrobe)) if (!scene.blocking[c]) out.add(c);
  return out;
}

/** Speakers / shot focus that are not on stage when they should be. */
export function stageIssues(project: Project, scene: Scene): string[] {
  const name = (id: string) => project.cast.find((c) => c.id === id)?.displayName || id;
  const out: string[] = [];
  scene.beats.forEach((b, i) => {
    const on = onStageIds(scene, i);
    if (b.kind === 'dialogue' && b.speakerId && scene.wardrobe[b.speakerId] && !on.has(b.speakerId)) out.push(`第${i + 1}句：${name(b.speakerId)}说话时不在台上`);
    for (const f of b.shot.focus) if (scene.wardrobe[f] && !on.has(f)) out.push(`第${i + 1}句：镜头焦点${name(f)}此时不在台上`);
  });
  return out;
}

const castMember = (p: Project, id: string) => p.cast.find((c) => c.id === id);

interface Sem {
  problems: string[];
  warnings: string[];
  notes: string[];
  op: AgentOp;
}

function semantic(project: Project, input: AgentOp, ctx: CheckCtx): Sem {
  const s: Sem = { problems: [], warnings: [], notes: [], op: input };
  const scene = project.scenes.find((x) => x.id === input.sceneId);
  if (!scene) {
    s.problems.push(`场景 ${input.sceneId} 不存在（可用：${project.scenes.map((x) => x.id).join(', ')}）`);
    return s;
  }
  const L: Lookup | null = ctx.catalog ? lookup(ctx.catalog) : null;
  const cam = cameraSystemOf(project, scene);
  const beatIdx = (id: string) => scene.beats.findIndex((b) => b.id === id);
  const beatOk = (id: string | undefined, what = '台词') => {
    if (id !== undefined && beatIdx(id) < 0) s.problems.push(`${what} ${id} 不在场景 ${scene.id} 里（可用：${scene.beats.slice(0, 6).map((b) => b.id).join(', ')} …）`);
  };
  const castOk = (id: string, needInScene = true) => {
    if (!castMember(project, id)) s.problems.push(`角色 ${id} 不存在（可用：${project.cast.map((c) => `${c.id}=${c.displayName}`).join('，')}）`);
    else if (needInScene && !scene.wardrobe[id]) s.problems.push(`${castMember(project, id)!.displayName}（${id}）不在场景 ${scene.id} 里，先用 actor_presence 让他入场景`);
  };

  switch (input.op) {
    case 'beat_set': {
      beatOk(input.beatId);
      const b = scene.beats.find((x) => x.id === input.beatId);
      const set = input.set;
      if (Object.keys(set).length === 0) s.problems.push('set 是空的');
      if (set.emotion && !(EMOTIONS as readonly string[]).includes(set.emotion)) s.problems.push(`情绪只能取：${EMOTIONS.join(' / ')}`);
      if (set.speakerId) castOk(set.speakerId, false);
      if (set.splitFrom && (set.splitFrom === input.beatId || !scene.beats.some((x) => x.id === set.splitFrom))) s.problems.push(`续句的首句 ${set.splitFrom} 不在这个场景里`);
      if (set.speakerId && !scene.wardrobe[set.speakerId]) s.notes.push(`${castMember(project, set.speakerId)?.displayName ?? set.speakerId} 不在这个场景里，这句会没有人物画面`);
      for (const c of set.coSpeakers ?? []) castOk(c, false);
      if (set.text !== undefined && set.text.trim() === '' && (set.kind ?? b?.kind) !== 'silent' && (set.kind ?? b?.kind) !== 'empty' && (set.kind ?? b?.kind) !== 'pause') s.problems.push('台词文字不能为空（要清空请把类型改成 silent）');
      if (b && (set.kind ?? b.kind) === 'dialogue' && set.speakerId === null) s.problems.push('对白必须有说话人');
      if (b && (set.kind ?? b.kind) === 'dialogue' && !(set.speakerId ?? b.speakerId)) s.problems.push('把类型改成对白需要同时给出 speakerId');
      // a text edit that leaves the line too long: a hint only, never split on the side (cutting a line is its own request)
      if (b && set.text !== undefined && set.text !== b.text) {
        const info = beatLineInfo(project, scene, { ...b, text: set.text, kind: set.kind ?? b.kind, variant: set.variant ?? b.variant });
        if (info?.over) s.notes.push(`这句现在是 ${info.lines} 行，超过对话框的 ${info.max} 行（只是提示：没有自动拆分；用户要求时可以用 split_line 拆开）`);
      }
      break;
    }
    case 'beat_insert': {
      if (input.afterBeatId !== null) beatOk(input.afterBeatId);
      if (beatIdx(input.newId) >= 0 || project.scenes.some((x) => x.beats.some((b) => b.id === input.newId))) s.problems.push(`id ${input.newId} 已存在（beat id 在整个项目里必须唯一）`);
      if (input.beat.speakerId) castOk(input.beat.speakerId, false);
      if (input.beat.emotion && !(EMOTIONS as readonly string[]).includes(input.beat.emotion)) s.problems.push(`情绪只能取：${EMOTIONS.join(' / ')}`);
      if (input.beat.kind === 'dialogue' && !input.beat.speakerId) s.problems.push('对白需要 speakerId');
      if (['dialogue', 'narration', 'action'].includes(input.beat.kind) && !input.beat.text.trim()) s.problems.push('台词文字不能为空');
      break;
    }
    case 'beat_delete': beatOk(input.beatId); if (scene.beats.length <= 1) s.problems.push('场景至少要保留一句台词'); break;
    case 'beat_move': beatOk(input.beatId); if (input.afterBeatId !== null) beatOk(input.afterBeatId); if (input.afterBeatId === input.beatId) s.problems.push('不能移到自己后面'); break;
    case 'beat_split': {
      if (!ctx.allowLineSplit) { s.problems.push(LINE_SPLIT_NOT_ASKED); break; }
      beatOk(input.beatId);
      const b = scene.beats.find((x) => x.id === input.beatId);
      if (b && input.at >= [...b.text].length) s.problems.push(`拆分位置 ${input.at} 超出文字长度 ${[...b.text].length}`);
      if (beatIdx(input.newId) >= 0 || project.scenes.some((x) => x.beats.some((b) => b.id === input.newId))) s.problems.push(`id ${input.newId} 已存在（beat id 在整个项目里必须唯一）`);
      break;
    }
    case 'beat_split_pieces': {
      if (!ctx.allowLineSplit) { s.problems.push(LINE_SPLIT_NOT_ASKED); break; }
      beatOk(input.beatId);
      const b = scene.beats.find((x) => x.id === input.beatId);
      if (input.newIds.length !== input.pieces.length - 1) s.problems.push(`newIds 需要 ${input.pieces.length - 1} 个（每个后续段一个新 id），现在是 ${input.newIds.length} 个`);
      const seen = new Set<string>();
      for (const id of input.newIds) {
        if (seen.has(id)) s.problems.push(`newIds 里 ${id} 重复`);
        seen.add(id);
        if (project.scenes.some((x) => x.beats.some((y) => y.id === id))) s.problems.push(`id ${id} 已存在（beat id 在整个项目里必须唯一）`);
      }
      for (const p of input.pieces) if (p.emotion && !(EMOTIONS as readonly string[]).includes(p.emotion)) s.problems.push(`情绪只能取：${EMOTIONS.join(' / ')}`);
      if (!b) break;
      if (!TEXT_KINDS.includes(b.kind) || b.text.trim() === '') { s.problems.push('只能拆有台词文字的句子（对白 / 旁白 / 动作）'); break; }
      const c = checkPieces(b.text, input.pieces.map((p) => p.text), dialogMetricsOf(project, scene, b), b.variant, { maxPieces: 4, maxExtra: 2 });
      if (!c.ok) { s.problems.push(...c.problems.map((p) => `拆分不合格：${p}`)); break; }
      if (c.repairs.length) s.warnings.push(...c.repairs);
      // the performance and camera intent of the later pieces get the same soft repair as the generation's split step; the names of the
      // motions / expressions were resolved where they were decided (the server), so they pass through here
      const bi = beatIdx(input.beatId);
      const rep = repairPieces(
        input.pieces.map((p, i) => ({
          text: c.pieces[i]!, why: p.why ?? '', emotion: (p.emotion || b.emotion || 'neutral') as 'neutral', camera: p.camera ?? 'hold', reactionOf: p.reactionOf ?? null,
          actor: p.motion || p.expression || p.attention ? { motion: p.motion ?? null, expression: p.expression ?? null, attention: p.attention ?? null } : null,
        })),
        c.pieces,
        { speaker: b.kind === 'dialogue' && b.speakerId ? b.speakerId : null, onStage: onStageIds(scene, bi), emotion: b.emotion ?? 'neutral', resolveMotion: (w) => w, resolveExpression: (w) => w, where: `第${bi + 1}句` },
      );
      s.warnings.push(...rep.warnings);
      s.op = {
        ...input,
        pieces: input.pieces.map((p, i): SplitPieceInput => {
          const r = rep.pieces[i]!;
          return {
            text: c.pieces[i]!, ...(p.emotion ? { emotion: p.emotion } : {}), ...(i > 0 && r.why ? { why: r.why } : {}),
            ...(i > 0 && r.camera !== 'hold' ? { camera: r.camera } : {}), ...(i > 0 && r.reactionOf ? { reactionOf: r.reactionOf } : {}),
            ...(i > 0 && r.actor?.motion ? { motion: r.actor.motion } : {}), ...(i > 0 && r.actor?.expression ? { expression: r.actor.expression } : {}),
            ...(i > 0 && r.actor?.attention ? { attention: r.actor.attention } : {}),
          };
        }),
      };
      break;
    }
    case 'dialog_expand': {
      beatOk(input.beatId);
      if (input.on && !ctx.allowDialogExpand) { s.problems.push(DIALOG_EXPAND_NOT_ASKED); break; }
      const b = scene.beats.find((x) => x.id === input.beatId);
      if (b && input.on) {
        const info = beatLineInfo(project, scene, b);
        if (!info) s.problems.push('这句没有台词文字，不需要展开');
        else if (info.lines <= info.max) s.problems.push(`这句只有 ${info.lines} 行，对话框放得下（${info.max} 行），不需要展开`);
        else if (info.lines > EXPAND_MAX_VISIBLE) s.notes.push(`这句有 ${info.lines} 行，展开后最多同时显示 ${EXPAND_MAX_VISIBLE} 行，其余随打字滚动`);
      }
      break;
    }
    case 'beat_merge': beatOk(input.beatId); if (beatIdx(input.beatId) >= 0 && beatIdx(input.beatId) === scene.beats.length - 1) s.problems.push('这是最后一句，没有可以合并的下一句'); break;
    case 'shot_set': {
      beatOk(input.beatId);
      const b = scene.beats.find((x) => x.id === input.beatId);
      const set = { ...input.set };
      const allowed = (cam === 'travel' ? AI_TRAVEL_SHOT_TYPES : AI_SHOT_TYPES) as readonly string[];
      if (set.type !== undefined && !allowed.includes(set.type)) s.problems.push(`景别只能取：${allowed.join(' / ')}（${cam === 'travel' ? '运镜' : '经典'}镜头系统）`);
      if (cam !== 'travel') {
        if (set.intent !== undefined && set.intent !== null) { s.warnings.push('经典镜头系统没有叙事意图，intent 已丢弃'); delete set.intent; }
        if (set.transition === 'travel') { s.warnings.push('经典镜头系统没有「运镜」换镜方式，已丢弃'); delete set.transition; }
      }
      if (set.intent && !(SHOT_INTENTS as readonly string[]).includes(set.intent)) s.problems.push(`intent 只能取：${SHOT_INTENTS.join(' / ')}`);
      const i = b ? beatIdx(b.id) : -1;
      for (const f of set.focus ?? []) {
        castOk(f);
        if (i >= 0 && scene.wardrobe[f] && !onStageIds(scene, i).has(f)) s.problems.push(`${castMember(project, f)?.displayName ?? f} 在第${i + 1}句时不在台上，不能做焦点（先调整进场）`);
      }
      const type = set.type ?? b?.shot.type;
      const focus = set.focus ?? b?.shot.focus ?? [];
      if (type === 'insert' && i >= 0 && (set.type === 'insert' || set.insertBox !== undefined)) {
        const box = set.insertBox ?? b?.shot.insertBox;
        const sc = INSERT_BOX.scene;
        const isScene = !!box && box.x === sc.x && box.y === sc.y && box.w === sc.w && box.h === sc.h;
        if (!isScene) {
          const ib = INSERT_BOX.instrument;
          const isInstrument = !box || (box.x === ib.x && box.y === ib.y && box.w === ib.w && box.h === ib.h);
          const who = focus.length > 0 ? focus : [...onStageIds(scene, i)];
          if (!isInstrument || !who.some((c) => playingAt(scene, c, i, L))) s.problems.push(INSERT_NEEDS_INSTRUMENT);
        }
      }
      if (type === 'two_shot' && focus.length !== 2) s.problems.push('two_shot 的 focus 必须正好是 2 个人');
      if (type && ['ms', 'mcu', 'cu', 'ecu'].includes(type) && focus.length > 1) s.warnings.push('单人景别只会对准第一个焦点');
      if (Object.keys(set).length === 0 && Object.keys(input.set).length === 0) s.problems.push('set 是空的');
      s.op = { ...input, set };
      break;
    }
    case 'shot_offset': beatOk(input.beatId); castOk(input.castId); break;
    case 'key_set': checkKeySet(project, scene, input, s, L, cam); break;
    case 'key_shift': {
      const exists = scene.tracks.some((t) => t.keys.some((k) => k.id === input.keyId));
      if (!exists) s.problems.push(`关键帧 ${input.keyId} 不存在`);
      break;
    }
    case 'fx_range': {
      beatOk(input.fromBeatId, '起始台词'); beatOk(input.toBeatId, '结束台词');
      const a = beatIdx(input.fromBeatId);
      const z = beatIdx(input.toBeatId);
      if (a >= 0 && z >= 0) {
        if (z < a) s.problems.push('特效范围的结束早于开始');
        const one = (ONE_SHOT_FX as readonly string[]).includes(input.fx);
        if (one && z !== a) s.problems.push(`${input.fx} 是一次性特效，范围只能是一句`);
        if (input.fx === 'dim' && z - a + 1 > MAX_DIM_BEATS) s.problems.push(`压暗最多连续 ${MAX_DIM_BEATS} 句（原作只压暗一两句内心独白）`);
        if (input.fx === 'memory') {
          const span = scene.beats.slice(a, z + 1).map((b) => b.text).join('') + scene.title;
          // re-toning a memory that is already there is not "adding" one
          const already = fxStates(scene).slice(a, z + 1).every((f) => f.startsWith('memory'));
          if (!already && !MEMORY_CUE.test(span)) s.notes.push('原文没有回忆线索，按你的要求直接添加');
        }
        if (one) {
          const nb = [scene.beats[a - 1], scene.beats[a + 1]].filter(Boolean).map((b) => b!.id);
          const clash = scene.tracks.some((t) => t.channel === 'fx' && t.keys.some((k) => nb.includes(k.at.beatId) && (k.value as { fx: string }).fx === input.fx));
          if (clash) s.notes.push(`相邻的句子也有 ${input.fx}，连着出现会显得重复`);
        }
      }
      if (input.tone && input.fx !== 'memory') s.problems.push('tone 只用于 memory');
      if (input.edge && input.fx !== 'memory') s.problems.push('edge 只用于 memory');
      if (input.variant && input.fx !== 'daze') s.problems.push('variant 只用于 daze');
      if (!(AI_FX as readonly string[]).includes(input.fx)) s.problems.push(`fx 只能取：${AI_FX.join(' / ')}`);
      break;
    }
    case 'actor_presence': {
      castOk(input.castId, false);
      if (input.present) {
        if (!input.modelId) s.problems.push('入场景需要 modelId（服装）');
        else checkModelOfCast(project, input.castId, input.modelId, L, s);
      } else if (scene.beats.some((b) => b.speakerId === input.castId)) s.notes.push('这个角色在本场景里有台词，离开场景后这些台词会没有人物画面');
      break;
    }
    case 'stage_set': {
      castOk(input.castId);
      if (input.enter) beatOk(input.enter.beatId);
      if (input.exit) beatOk(input.exit.beatId);
      const bl = scene.blocking[input.castId];
      const e = input.enter !== undefined ? input.enter?.beatId : bl?.enter?.beatId;
      const x = input.exit !== undefined ? input.exit?.beatId : bl?.exit?.beatId;
      if (e && x && beatIdx(e) >= 0 && beatIdx(x) >= 0 && beatIdx(e) >= beatIdx(x)) s.problems.push('进场必须早于离场');
      break;
    }
    case 'wardrobe_set': castOk(input.castId); checkModelOfCast(project, input.castId, input.modelId, L, s, true); break;
    case 'timing': {
      for (const id of input.beatIds) beatOk(id);
      for (const [path, v] of Object.entries(input.set)) {
        const f = styleField(path);
        if (!path.startsWith('rhythm.') || !f) s.problems.push(`节奏字段只能取：${RHYTHM_PATHS.join(' / ')}`);
        else if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) s.problems.push(`${path} 的范围是 ${f.min}–${f.max}`);
      }
      if (!input.clear && Object.keys(input.set).length === 0) s.problems.push('set 是空的');
      break;
    }
    case 'bg_set': {
      const perf = !!scene.brief?.isPerformance;
      if (input.at !== 'start') beatOk(input.at);
      if (perf) s.problems.push('正式演出场景不换背景');
      if (input.assetId) {
        if (L) {
          const bg = L.backgrounds.get(input.assetId);
          if (!bg) s.problems.push(`背景 ${input.assetId} 不在素材库里，请用 list_options 查询`);
          else {
            const cat = bgCategoryOf(bg);
            if (cat === 'insert' && input.at !== 'start') {
              if ((input.purpose ?? 'move') !== 'insert') { s.warnings.push('这是插入镜头（特写物件）背景，已按空镜处理：这一段所有人物隐藏'); s.op = { ...input, purpose: 'insert' }; }
            } else {
              const why = categoryProblem(bg, `${scene.title}${scene.brief?.mood ?? ''}`, perf) ?? (autoSelectable(bg, 'scene') ? null : '不可自动选用的背景');
              if (why) s.problems.push(`背景「${bg.name}」不能用：${why}`);
            }
          }
        }
        if (input.at !== 'start' && (s.op as typeof input).purpose === 'insert') s.notes.push('空镜：从这一句到下一次换背景，画面里没有任何人物；要人物留在画面里请用 purpose=move（换地点）或 time（换时段）');
      } else if (input.at === 'start') s.problems.push('开场背景不能清空');
      break;
    }
    case 'scene_set': break;
    case 'lock_set': {
      if (['beat', 'shot', 'rhythm'].includes(input.unit)) { if (!input.beatId) s.problems.push('需要 beatId'); else beatOk(input.beatId); }
      if (['wardrobe', 'blocking'].includes(input.unit) && !input.castId) s.problems.push('需要 castId');
      if (input.unit === 'track' && !scene.tracks.some((t) => t.id === input.trackId)) s.problems.push('找不到轨道');
      if (input.unit === 'key' && !scene.tracks.some((t) => t.keys.some((k) => k.id === input.keyId))) s.problems.push('找不到关键帧');
      const known = input.unit === 'beat' ? BEAT_LOCK_FIELDS : input.unit === 'shot' ? SHOT_LOCK_FIELDS : null;
      if (known && input.lockedFields) for (const f of input.lockedFields) if (!known.includes(f)) s.problems.push(`${input.unit} 可锁定的字段：${known.join(' / ')}`);
      break;
    }
  }
  return s;
}

function checkModelOfCast(project: Project, castId: string, modelId: string, L: Lookup | null, s: Sem, strictSelectable = false): void {
  if (!L) return;
  const m = L.models.get(modelId);
  const cm = castMember(project, castId);
  if (!m) s.problems.push(`服装 ${modelId} 不在素材库里`);
  else if (cm && m.characterKey !== cm.characterKey) s.problems.push(`服装 ${modelId} 不属于 ${cm.displayName}`);
  else if (strictSelectable && !selectable(m, { live: m.mode === 'live' })) s.problems.push(`服装 ${modelId} 不可选用（低画质或静态图）`);
}

/** The value shape of each timeline channel, for set_keyframe's description and its error messages. */
export const KEY_VALUE_SHAPE: Record<string, string> = {
  motion: '{"name":"动作族名"}', expression: '{"name":"表情名"|null}', gaze: '{"target":"castId|camera|away|down"}', head: '{"mode":"target","target":"castId|camera|away|auto","pitch":-1(低头)..1(抬头，可省略)}', body: '{"mode":"target","target":"castId|camera|away"}',
  position: '{"slot":-1..1,"depth":0..1}', opacity: '0..1 的数字', costume: '{"modelId":"…"}', camera: '{"shot":"景别","focus":["castId"]}', fx: '{"fx":"…","strength":0..1}', fade: '{"color":"black|white","alpha":0..1}', background: '{"assetId":"…","purpose":"move|time|insert（insert=空镜，人物全部隐藏）"}',
};

const ACTOR_CHANNELS = ['motion', 'expression', 'head', 'body', 'gaze', 'position', 'opacity', 'costume'];
function checkKeySet(project: Project, scene: Scene, op: Extract<AgentOp, { op: 'key_set' }>, s: Sem, L: Lookup | null, cam: string): void {
  const needTarget = ACTOR_CHANNELS.includes(op.channel) ? 'actor' : op.channel === 'camera' ? 'camera' : op.channel === 'background' ? 'stage' : 'screen';
  if (op.target.kind !== needTarget) {
    s.problems.push(`${op.channel} 轨道的 target 必须是 ${needTarget}`);
    return;
  }
  const castId = op.target.kind === 'actor' ? op.target.castId : null;
  if (castId && !scene.wardrobe[castId]) s.problems.push(`${castMember(project, castId)?.displayName ?? castId} 不在场景 ${scene.id} 里`);
  if (op.at && !scene.beats.some((b) => b.id === op.at!.beatId)) s.problems.push(`台词 ${op.at.beatId} 不在场景里`);
  if (op.remove) {
    if (!op.keyId && !op.at) s.problems.push('删除关键帧需要 keyId 或 at');
    return;
  }
  const editing = op.keyId !== undefined;
  if (!editing && (op.value === undefined || !op.at)) {
    s.problems.push('新建关键帧需要 at 和 value');
    return;
  }
  if (op.value === undefined) return;
  const parsed = TrackSchema.safeParse({ id: 't', target: op.target, channel: op.channel, meta: undefined, keys: [{ id: 'k', at: op.at ?? { beatId: 'b', offset: 0 }, value: op.value, duration: op.duration ?? 0, ease: op.ease ?? 'inOutQuad', meta: undefined }] });
  if (!parsed.success) {
    s.problems.push(`${op.channel} 的 value 不合法：${parsed.error.issues.slice(0, 2).map((i) => `${i.path.slice(2).join('.')} ${i.message}`).join('；')}；应为 ${KEY_VALUE_SHAPE[op.channel] ?? '对象'}`);
    return;
  }
  const v = op.value as Record<string, unknown>;
  if (op.channel === 'camera') {
    if ('manual' in v) s.problems.push('AI 不能写手动镜头坐标；请用景别（shot）和焦点（focus），坐标由程序计算');
    else {
      const allowed = (cam === 'travel' ? AI_TRAVEL_SHOT_TYPES : AI_SHOT_TYPES) as readonly string[];
      if (!allowed.includes(String(v.shot))) s.problems.push(`镜头关键帧的景别只能取：${allowed.join(' / ')}`);
      for (const f of (v.focus as string[] | undefined) ?? []) if (!scene.wardrobe[f]) s.problems.push(`焦点 ${f} 不在场景里`);
    }
  }
  if (op.channel === 'gaze' || op.channel === 'head' || op.channel === 'body') {
    const t = v.target;
    if (typeof t === 'string') {
      const special = op.channel === 'gaze' ? [...SPECIAL_ATTENTION] : op.channel === 'head' ? ['camera', 'away', 'auto'] : ['camera', 'away'];
      if (!special.includes(t) && !scene.wardrobe[t]) s.problems.push(`${t} 不是在场角色（也不是 ${special.join(' / ')}）`);
      if (t === castId) s.problems.push('不能看向自己');
    }
  }
  if (op.channel === 'costume' && castId && typeof v.modelId === 'string') checkModelOfCast(project, castId, v.modelId, L, s, true);
  if (op.channel === 'background' && L) {
    const bg = L.backgrounds.get(String(v.assetId));
    if (!bg) s.problems.push(`背景 ${String(v.assetId)} 不在素材库里`);
  }
  if (op.channel === 'background' && v.purpose === 'insert') s.notes.push('purpose=insert 是空镜：到下一次换背景前所有人物隐藏；要人物留在画面里用 move 或 time');
  if ((op.channel === 'motion' || op.channel === 'expression') && castId && L) {
    const { model } = (() => { const modelId = scene.wardrobe[castId]?.modelId; return { model: modelId ? L.models.get(modelId) : undefined }; })();
    if (!model) { s.problems.push(`${castId} 的服装不在素材库里`); return; }
    if (op.channel === 'motion') {
      const name = String(v.name);
      const fams = motionFamilies(model);
      if (!fams.includes(name)) {
        // the model may write the label it was shown (「挥手」), a full motion file name or a family without the prefix; never a different motion
        const fixed = resolveName(name, fams, (f) => [motionLabel(f), `mtn_${f}`, f.replace(/01$/, '')]);
        if (fixed === null) s.problems.push(`动作「${name}」这套服装没有；可用：${fams.slice(0, 20).map((f) => `${f}（${motionLabel(f)}）`).join(' / ')}`);
        else s.op = { ...op, value: { ...v, name: fixed } };
      }
    } else if (v.name !== null) {
      if (model.mode === 'live') s.problems.push('演出（live）服装没有表情');
      else if (!model.expressions.some((e) => e.name === v.name)) {
        const names = model.expressions.map((e) => e.name);
        const fixed = resolveName(String(v.name), names, (n) => [expressionLabel(n), n.replace(/^exp_/, '')]);
        if (fixed === null) s.problems.push(`表情「${String(v.name)}」这套服装没有；可用：${names.slice(0, 24).map((n) => `${n}（${expressionLabel(n)}）`).join(' / ')}`);
        else s.op = { ...op, value: { ...v, name: fixed } };
      }
    }
  }
}

export function checkOp(project: Project, raw: unknown, ctx: CheckCtx = {}): CheckResult {
  const base = (over: Partial<CheckResult> & Pick<CheckResult, 'status' | 'problems'>): CheckResult => ({ warnings: [], notes: [], op: raw as AgentOp, changes: [], violations: [], overwrote: [], skipped: [], ...over });
  const parsed = AgentOpSchema.safeParse(raw);
  if (!parsed.success) {
    return base({ status: 'invalid', problems: parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(op)'}: ${i.message}`) });
  }
  const sem = semantic(project, parsed.data, ctx);
  if (sem.problems.length > 0) return base({ status: 'invalid', problems: sem.problems, op: sem.op, warnings: sem.warnings, notes: sem.notes });
  const op = sem.op;
  const sim = clone(project);
  const before = stageIssues(project, project.scenes.find((x) => x.id === op.sceneId)!);
  const applied = applyOp(sim, op, { genId: 'check', now: 0 });
  if (!applied.ok) return base({ status: 'invalid', problems: [applied.error ?? '无法应用'], op, warnings: sem.warnings, notes: sem.notes });
  // `overflow: 'expand'` is a person's decision: whatever the op, it may only appear when the user asked for it
  if (!ctx.allowDialogExpand) {
    const was = expandedBeatIds(project);
    const fresh = [...expandedBeatIds(sim)].filter((id) => !was.has(id));
    if (fresh.length > 0) return base({ status: 'invalid', problems: [`${DIALOG_EXPAND_NOT_ASKED}（${fresh.slice(0, 3).join('、')}）`], op, warnings: sem.warnings, notes: sem.notes });
  }
  const after = stageIssues(sim, sim.scenes.find((x) => x.id === op.sceneId)!);
  const fresh = after.filter((x) => !before.includes(x));
  const warnings = [...sem.warnings, ...fresh.map((x) => `${x}（可以把进场提前到他第一次出现的那一句）`)];
  const violations = findLockViolations(project, sim);
  const common = { op, warnings, notes: sem.notes, changes: applied.changes, violations, overwrote: applied.overwrote, skipped: applied.skipped, problems: [] as string[] };
  if (violations.length > 0) return base({ ...common, status: 'needs_unlock' });
  if (applied.overwrote.length > 0 && !op.overrideUser) return base({ ...common, status: 'needs_confirm' });
  return base({ ...common, status: 'ok' });
}

/**
 * A motion / expression the model named by its label (「微笑 3」), without the prefix (smile03) or with a different case: the one real name it
 * stands for, or null. Only exact aliases count: a name that means something else is an error for the model to fix, never a substitute.
 */
export function resolveName(raw: string, names: string[], aliases: (n: string) => string[]): string | null {
  const norm = (x: string) => x.trim().toLowerCase().replace(/[\s（）()]/g, '');
  const want = norm(raw);
  const hits = names.filter((n) => norm(n) === want || aliases(n).some((a) => norm(a) === want));
  return hits.length === 1 ? hits[0]! : null;
}
