/**
 * The tools the model may call. Every write tool resolves intent-level arguments ("tighter", "a little to the left", "slower") to concrete
 * AgentOps with absolute values (fixed step sizes, `NUDGE`), runs each through `checkOp` and applies it to the sandbox. The model never
 * writes a coordinate for the automatic framing: shot offsets and slots are nudged by a fixed step from their current value, everything
 * else is a vocabulary word, an id or a number the editor itself exposes (seconds).
 */
import { z } from 'zod';
import { motionFamilies } from '../director/catalogDigest';
import { autoSelectable } from '../director/bgCategory';
import { lookup, modelLabel, rankBackgrounds, selectable, defaultModel, type DirectorCatalog } from '../director/resources';
import { pairNeighbours } from '../director/validate';
import { AI_FX, AI_TRAVEL_SHOT_TYPES, AI_SHOT_TYPES, DEPTH_Y, EMOTIONS, INSERT_BOX, SLOT_X, SLOT_NAMES, DEPTH_NAMES, SPECIAL_ATTENTION, ONE_SHOT_FX } from '../director/vocab';
import { nextId } from '../project/mutate';
import { HEAD_DOWN, HEAD_UP } from '../staging/facing';
import { cameraSystemOf, type Beat, type Project, type Scene } from '../schema/project';
import { SHOT_INTENTS } from '../staging/shotIntent';
import { MEMORY_EDGES, MEMORY_TONES } from '../schema/project';
import { expressionLabel, motionLabel } from '../catalog/labels';
import { resolveStyle } from '../style/ournotes';
import { HIDDEN_REASON_LABEL, scenePresence } from '../timeline/presence';
import { applyOp, type Change } from './apply';
import { KEY_VALUE_SHAPE, checkOp, type CheckCtx } from './check';
import { beatDetail, findBeats, sceneTable, type AgentSelection } from './compact';
import { scopeOf, type AgentOp } from './ops';
import { BatchModelSchema, BatchSchema, batchEdit } from './batch';
import { BeatFilterSchema, ModelFilterSchema, buildIndex, queryTable, refOf, runQuery, type BeatFilter, type BeatRef } from './query';
import { ScriptSchema, runScriptTool, type ScriptRunner } from './script';

/** Fixed step sizes of the relative adjustments ("a little", "a bit more" = 1, 2 steps). */
export const NUDGE = {
  /** Per-person shot offset, in stage heights. */
  offset: 0.04,
  /** Start / key position slot (-1..1). */
  slot: 0.1,
  /** Pause between lines (lineGap), tail hold: seconds. */
  gap: 0.3,
  /** Effect strength. */
  strength: 0.2,
  /** Key time shift, seconds. */
  time: 0.1,
  /** Reading speed factor per step (slower = 1 / this). */
  pace: 0.85,
} as const;

/** Records produced together by one batch_edit / run_script call: the card shows them as ONE collapsible line (expand = per-beat rows). */
export interface OpGroup {
  id: string;
  kind: 'batch' | 'script';
  /** 「把 12 句的景别改成 mcu」 / the script's one-line description. */
  label: string;
  /** The script text (run_script); carried by the first record of the group only. */
  script?: string;
}
export interface OpRecord {
  id: number;
  tool: string;
  op: AgentOp;
  group?: OpGroup | undefined;
  status: 'ok' | 'needs_unlock' | 'needs_confirm';
  changes: Change[];
  warnings: string[];
  notes: string[];
  violations: string[];
  overwrote: string[];
  skipped: string[];
}
export interface ToolStats {
  toolCalls: number;
  badArgs: number;
  opsChecked: number;
  opsInvalid: number;
  /** Write tool calls whose every op was valid the first time. */
  writeCalls: number;
  writeFirstTryOk: number;
  /** Pictures capture_frames took this turn. */
  framesCaptured?: number;
}
export interface ToolEnv {
  /** The sandbox: a deep copy of the project; ok ops are applied to it as they come. */
  sandbox: Project;
  catalog?: DirectorCatalog | undefined;
  selection: AgentSelection;
  genId: string;
  now: () => number;
  /** The user's instruction (for the manual-overwrite wording and the memory cue). */
  applied: OpRecord[];
  pending: OpRecord[];
  stats: ToolStats;
  seq: { n: number };
  /** Earlier applied turns that can be undone exactly (most recent first): see history.ts / revert.ts. */
  reverts?: Array<{ turnsAgo: number; instruction: string; ops: AgentOp[] }> | undefined;
  /** Beat ids the question of the user names explicitly as hand-made (not used by the pure code, kept for the loop). */
  askedUser?: { question: string; options: string[] } | undefined;
  /** Full results of query_beats calls of this turn (batch_edit can use them even when the table shown to the model was cut). */
  queries?: Map<string, BeatRef[]> | undefined;
  groupSeq?: number | undefined;
  /** The script sandbox (server side); absent = run_script is not available. */
  scriptRunner?: ScriptRunner | undefined;
  scriptFailures?: number | undefined;
  /** What the user's own words ask for (`asks.ts`, decided on the server from the instruction): without it no op may split a line or expand a dialogue. */
  asks?: { lineSplit: boolean; dialogExpand: boolean } | undefined;
}
/** The check context of every op the tools produce: the catalog plus what the user asked for. `restore` (revert_turn) brings back an earlier state the user already agreed to. */
export const checkCtx = (env: ToolEnv, restore = false): CheckCtx => ({ catalog: env.catalog, allowLineSplit: restore || env.asks?.lineSplit === true, allowDialogExpand: restore || env.asks?.dialogExpand === true });
export const newStats = (): ToolStats => ({ toolCalls: 0, badArgs: 0, opsChecked: 0, opsInvalid: 0, writeCalls: 0, writeFirstTryOk: 0 });

const Id = z.string().min(1);
const sceneArg = z.string().optional().describe('场景 id；省略 = 当前选中的场景');
const reason = z.string().max(400).optional().describe('一句话理由（给用户看）');
const manual = z.boolean().optional().describe('用户在指令里明确点名要改他手动改过的这一处时才填 true');
const attention = z.string().describe('castId，或 camera / away / down');

const KEY_VALUE_SHAPES = Object.entries(KEY_VALUE_SHAPE).map(([k, v]) => `${k}=${v}`).join('；');

export interface ToolDef {
  name: string;
  kind: 'read' | 'write' | 'control' | 'memory';
  description: string;
  schema: z.ZodType;
  /** What the model is shown when it differs from the validating schema (a compact form of a recursive one). */
  modelSchema?: z.ZodType;
}

const slotEnum = z.enum(SLOT_NAMES as unknown as [string, ...string[]]);
const depthEnum = z.enum(DEPTH_NAMES as unknown as [string, ...string[]]);

export const TOOLS: ToolDef[] = [
  { name: 'get_scene', kind: 'read', description: '读取一个场景的压缩表格（每句一行：说话人、台词、景别、焦点、运镜、特效、情绪、节奏、锁定/手改标记）和人物进出场。from/to 是第几句（从 1 起）。', schema: z.object({ sceneId: sceneArg, from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }) },
  { name: 'get_beat', kind: 'read', description: '读取一句的全部细节（文字、镜头、节奏、此时在台上的人、这一句上所有关键帧及其 id、锁和来源）。改完之后用它回读确认。', schema: z.object({ sceneId: sceneArg, beatId: Id }) },
  { name: 'find_beats', kind: 'read', description: '在整个项目里按说话人（名字或 castId）和/或台词片段搜索，返回场景号、句号、beatId。用来解析「灯说“……”那句」「第三场第二个爱音的台词」。引文不必一字不差：没有完全一致的会返回近似匹配。', schema: z.object({ speaker: z.string().optional(), text: z.string().optional(), sceneId: z.string().optional() }) },
  { name: 'query_beats', kind: 'read', description: '按结构化条件在整个项目里查句子（只读）：场景 / 句号范围、说话人 / 涉及的人、类型、台词包含 / 正则 / 模糊、字数、台词在对话框里占几行（linesMin / linesMax）、是否超长放不下（overflow）、是否展开（expanded）、情绪、景别 / 意图 / 换镜方式 / 运镜 / 焦点、特效及参数、背景、画面上看得见谁（编译后的在场）、句后停顿 / 时长阈值、是否锁定 / 手改；and / or / not 可以嵌套。返回 queryId + 命中数 + 紧凑表格（太多会截断，但 queryId 保存完整结果）。「所有 / 每个 / 整部 / 凡是」这类指令：先 query_beats，再用 batch_edit 的 target.queryId 批量改。', schema: z.object({ filter: BeatFilterSchema.optional().describe('省略 = 所有句子'), limit: z.number().int().min(1).max(200).optional().describe('表格最多列几行，默认 60') }), modelSchema: z.object({ filter: ModelFilterSchema.optional().describe('省略 = 所有句子'), limit: z.number().int().min(1).max(200).optional().describe('表格最多列几行，默认 60') }) },
  { name: 'list_options', kind: 'read', description: '查询可用的选项：motion/expression=某角色当前服装可用的动作族/表情；background=按关键词搜背景（最多 12 个）；cast=角色表和他们能换的服装；effects=特效词表。', schema: z.object({ kind: z.enum(['motion', 'expression', 'background', 'cast', 'effects']), castId: z.string().optional(), sceneId: sceneArg, query: z.string().optional() }) },
  { name: 'capture_frames', kind: 'read', description: '看渲染出来的画面（舞台截图，不含对白框）。用在：用户说的是画面本身（怼脸、被挡住、出画、画面太空/太挤、背景太糊、人太小）；或者你改了画面（景别/构图/站位/偏移/运镜/背景/特效等）之后必须核对。beatIds=要看的句子（每句取中间一帧）；samples=2–4 时每句沿时间取多帧（看运镜、进场、动作过程）；times=绝对秒数。一次最多 8 帧，width 默认 480（要看细节再用 640/960）。纯文字/节奏/情绪的改动不用截图；画面改动做完后只截涉及的句子。', schema: z.object({ sceneId: sceneArg, beatIds: z.array(Id).max(8).optional(), times: z.array(z.number().min(0)).max(8).optional(), samples: z.number().int().min(1).max(4).optional(), width: z.union([z.literal(320), z.literal(480), z.literal(640), z.literal(960)]).optional(), question: z.string().max(300).optional().describe('想从画面里确认什么（给视觉模型看的问题）') }) },
  { name: 'ask_user', kind: 'control', description: '目标不明确（多个候选、指代不清、数值缺失）时，向用户问一个简短的澄清问题，然后结束本轮。不要猜。', schema: z.object({ question: z.string().min(1).max(200), options: z.array(z.string().max(60)).max(5).optional() }) },

  { name: 'edit_beat', kind: 'write', description: '修改一句的文字/说话人/类型/情绪/切入/时长。speaker 填 castId（null=无）；kind: dialogue|narration|action|pause|silent|empty；emotion 取词表；cutIn: cut|dip_black|dip_white；durationSeconds 填数字=固定时长，null=自动。', schema: z.object({ sceneId: sceneArg, beatId: Id, text: z.string().optional(), speaker: z.string().nullable().optional(), kind: z.string().optional(), variant: z.enum(['normal', 'monologue', 'offscreen']).optional(), emotion: z.string().nullable().optional(), cutIn: z.enum(['cut', 'dip_black', 'dip_white']).optional(), cutInKeepDialog: z.boolean().optional(), durationSeconds: z.number().min(0).max(120).nullable().optional(), trimTo: z.number().int().min(1).optional().describe('把文字截短到前 N 个字'), reason, overwriteManual: manual }) },
  { name: 'edit_structure', kind: 'write', description: '结构编辑：insert=在 afterBeatId 后（null=最前）插入一句（text/speaker/kind/emotion）；delete=删除；move=移到 afterBeatId 之后；split=在第 at 个字后拆成两句（只有用户要求拆分时才用；按语义拆长句请用 split_line）；merge=和下一句合并。', schema: z.object({ sceneId: sceneArg, action: z.enum(['insert', 'delete', 'move', 'split', 'merge']), beatId: Id.optional(), afterBeatId: z.string().nullable().optional(), text: z.string().optional(), speaker: z.string().optional(), kind: z.string().optional(), emotion: z.string().optional(), at: z.number().int().min(1).optional(), reason, overwriteManual: manual }) },
  { name: 'split_line', kind: 'write', description: '把一句放不下的台词按语义和情绪拆成【同一个人】连续说的几句（对话框最多两行）。只有用户明确要求拆分 / 断开 / 修复过长台词时才调用；用户没要求时绝不调用（做别的编辑时发现超长句，只在回复里提一句并问要不要拆）。pieces 必须把原文逐字切开：拼起来与原文一字不差（只有切点处的空格可以去掉），每段不超过两行，2–4 段；断在情绪转折、停顿（……、——之后）、话题转折（不过 / 可是 / 所以 …）或揭示真话之前，不要断在词组或引号中间，不要拆出两三个字的碎片，不要删字、改写或补标点。整句被括号或引号包住时每段各自带上同一对符号。emotions（可选）按段给情绪，没变就省略。后续段沿用第一段的镜头；需要给后段换表情或动作时，在同一轮里接着用 set_actor（beatId 用返回的新 id）。放得下的句子、已经展开的句子不要拆。', schema: z.object({ sceneId: sceneArg, beatId: Id, pieces: z.array(z.string().min(1)).min(2).max(4), emotions: z.array(z.string()).max(4).optional(), reason, overwriteManual: manual }) },
  { name: 'dialog_expand', kind: 'write', description: '让一句台词在对话框里完整显示（超过两行也不截断：先向下长到 3 行，再向上，超过 6 行随打字滚动）。只有用户明确说要完整显示 / 展开 / 超出屏幕也行 / 不想拆开时才调用；用户没说时绝不调用，超长句优先建议拆分。on=false 取消展开。', schema: z.object({ sceneId: sceneArg, beatId: Id, on: z.boolean().optional().describe('默认 true；false = 取消展开'), reason, overwriteManual: manual }) },
  { name: 'set_shot', kind: 'write', description: '改镜头。type 取景别词表；adjust=tighter/wider 按景别阶梯移一档（steps 档，默认 1）；focus=castId 数组（two_shot 必须 2 人且都在台上）；move: static|push_in|pull_out|pan|track|shake；dof 0–6 或 null；intent/flow 仅「运镜」系统（flow: auto|cut|move）；insertTarget: instrument|scene（instrument=正在演奏的乐器特写，人物必须在演奏；scene=空镜插入背景；没有乐器的手/物件/表情不要用插入镜头，用 cu / ecu）。可一次改多句。绝不写坐标。', schema: z.object({ sceneId: sceneArg, beatIds: z.array(Id).min(1).max(80), type: z.string().optional(), adjust: z.enum(['tighter', 'wider']).optional(), steps: z.number().int().min(1).max(3).optional(), focus: z.array(Id).optional(), move: z.enum(['static', 'push_in', 'pull_out', 'pan', 'track', 'shake']).optional(), dof: z.number().int().min(0).max(6).nullable().optional(), intent: z.string().nullable().optional(), flow: z.enum(['auto', 'cut', 'move', 'glide']).optional(), insertTarget: z.enum(['instrument', 'scene']).optional(), reason, overwriteManual: manual }) },
  { name: 'nudge_shot', kind: 'write', description: '微调这一镜里某人的画面位置：dxSteps（负=往左，正=往右）、dySteps（负=往上，正=往下），每步固定 0.04 个舞台高度；resetOffset=true 清除偏移。「往左一点」=-1…-2 步。', schema: z.object({ sceneId: sceneArg, beatId: Id, castId: Id, dxSteps: z.number().int().min(-10).max(10).optional(), dySteps: z.number().int().min(-10).max(10).optional(), resetOffset: z.boolean().optional(), reason, overwriteManual: manual }) },
  { name: 'set_actor', kind: 'write', description: '设置某人在某句的表演：motion=动作族名（list_options 查）；expression=表情名，null=默认表情；head/body/gaze=看向谁（castId 或 camera/away/down；head/body 无 down）；headTilt=头部俯仰：down=低头（ParamAngleY，pitch -0.6）、up=抬头、level=回正，可单独用（保留原来的朝向），也可和 head 一起；moveTo=走到的站位名（far_left…far_right）+depth（front|mid|back）或 slotSteps（每步 0.1，负=往左）；atOffset 秒；remove=要清除的轨道（motion|expression|head|body|gaze|position）。', schema: z.object({ sceneId: sceneArg, beatId: Id, castId: Id, motion: z.string().optional(), expression: z.string().nullable().optional(), head: attention.optional(), headTilt: z.enum(['down', 'up', 'level']).optional(), body: attention.optional(), gaze: attention.optional(), moveTo: slotEnum.optional(), depth: depthEnum.optional(), slotSteps: z.number().int().min(-10).max(10).optional(), atOffset: z.number().min(0).max(30).optional(), remove: z.array(z.enum(['motion', 'expression', 'head', 'body', 'gaze', 'position'])).optional(), reason, overwriteManual: manual }) },
  { name: 'set_fx', kind: 'write', description: '特效。fx: none|vignette_anxiety|memory|dim|flash|shake|daze|dutch。作用于 fromBeatId 到 toBeatId（含，默认同一句）；none=清除这一范围的特效；memory 可带 tone(cool|warm|sepia|mono)、edge(fog|bands|both|none)；daze 可带 variant=blink（眼睑）；strength 0–1；strengthSteps 在原强度上加减（每步 0.2）。flash/shake 只能一句；dim 最多 4 句。用户明确要求就直接加，不必等原文有线索。', schema: z.object({ sceneId: sceneArg, fromBeatId: Id, toBeatId: Id.optional(), fx: z.enum(AI_FX), tone: z.enum(MEMORY_TONES).optional(), edge: z.enum(MEMORY_EDGES).optional(), variant: z.enum(['blink']).optional(), strength: z.number().min(0).max(1).optional(), strengthSteps: z.number().int().min(-5).max(5).optional(), reason, overwriteManual: manual }) },
  { name: 'set_entrance', kind: 'write', description: '人物进出：inScene=false 把他移出本场景 / true 加入（服装用默认服装，可指定 modelId）；enterAt=在哪一句进场（null=从开场就在）；exitAt=在哪一句离场（null=不离场）；side: left|right|none；startMoveTo/startDepth 改开场站位。台词 id 用 get_scene 里的 id。', schema: z.object({ sceneId: sceneArg, castId: Id, inScene: z.boolean().optional(), modelId: z.string().optional(), enterAt: z.string().nullable().optional(), exitAt: z.string().nullable().optional(), side: z.enum(['left', 'right', 'none']).optional(), startMoveTo: slotEnum.optional(), startDepth: depthEnum.optional(), startSlotSteps: z.number().int().min(-10).max(10).optional(), reason, overwriteManual: manual }) },
  { name: 'set_timing', kind: 'write', description: '节奏（只影响节奏，不碰镜头）。pace=slower|faster|normal 一次整体调整；gapSteps 句后停顿加减（每步 0.3 秒，负=缩短）；tailSteps 句尾停留加减（每步 0.3 秒）；readingCps/lineGap/tail/minLine/textSpeedCps 给绝对数值（用户给了数字时）；reset=恢复默认。「某句之前停顿」=改上一句的 gapSteps；「X 晚 N 秒进场」=给进场前一句加 N 秒句后停顿。', schema: z.object({ sceneId: sceneArg, beatIds: z.array(Id).min(1).max(120), pace: z.enum(['slower', 'faster', 'normal']).optional(), gapSteps: z.number().int().min(-10).max(10).optional(), tailSteps: z.number().int().min(-10).max(10).optional(), gapSeconds: z.number().min(0).max(3).optional(), readingCps: z.number().optional(), lineGap: z.number().optional(), tail: z.number().optional(), minLine: z.number().optional(), textSpeedCps: z.number().optional(), reset: z.boolean().optional(), reason, overwriteManual: manual }) },
  { name: 'set_background', kind: 'write', description: '换背景。at=start（场景开场背景，同时同步地点标题条）或某句的 beatId（从这一句起换到下一次换背景为止，写入背景轨；只换一句就在下一句再换回原背景）；assetId 必须来自 list_options(background)；assetId=null 且 at=beatId 表示去掉这一句的背景切换。transition: cut|dip_black|dip_white|crossfade。purpose（默认 move）：move=换地点，人物留在画面里（回忆、闪回、走到别处都用它）；time=同一地点换时段，人物留在画面里；empty_shot=空镜：从这一句到下一次换背景，【所有人物都隐藏】，画面里只有背景——只有用户明确要空镜/景物镜头/不要人时才用。改完用 get_scene 的「画面上的人」列确认谁真的在画面上。', schema: z.object({ sceneId: sceneArg, at: z.string(), assetId: z.string().nullable(), transition: z.enum(['cut', 'dip_black', 'dip_white', 'crossfade']).optional(), seconds: z.number().min(0).max(3).optional(), purpose: z.enum(['move', 'time', 'empty_shot']).optional().describe('move=换地点（人物在）；time=换时段（人物在）；empty_shot=空镜（所有人隐藏）'), reason, overwriteManual: manual }) },
  { name: 'set_scene', kind: 'write', description: '场景设置：标题、镜头系统（inherit|classic|travel）、氛围、时间段、转场（transitionKind + transitionSeconds）、地点标题条文字和显示。', schema: z.object({ sceneId: sceneArg, title: z.string().optional(), cameraSystem: z.enum(['inherit', 'classic', 'travel']).optional(), mood: z.string().optional(), timeOfDay: z.string().optional(), transitionKind: z.enum(['cut', 'fade_black', 'fade_white', 'crossfade', 'wipe', 'dip_black', 'scene_black']).optional(), transitionSeconds: z.number().min(0).max(10).optional(), locationText: z.string().optional(), locationShow: z.boolean().optional(), reason, overwriteManual: manual }) },
  { name: 'set_costume', kind: 'write', description: '换服装：不填 atBeatId = 整个场景的服装；填了 = 从这一句起换装（换装关键帧）。modelId 必须是该角色的服装（list_options cast 查）。', schema: z.object({ sceneId: sceneArg, castId: Id, modelId: Id, atBeatId: z.string().optional(), reason, overwriteManual: manual }) },
  { name: 'set_keyframe', kind: 'write', description: '通用时间线关键帧（编辑器能手动改的都能改）：增/改/删/移动。channel: motion|expression|head|body|gaze|position|opacity|costume|camera|fx|fade|background；actor 通道必须给 castId；camera 通道的 value 只能是 {shot, focus}（不允许手动坐标）。keyId 存在=修改它；shiftSeconds 或 shiftSteps（每步 0.1 秒）=平移时间；remove=删除。表情/动作/看向优先用 set_actor。value 的形状：' + KEY_VALUE_SHAPES, schema: z.object({ sceneId: sceneArg, channel: z.enum(['motion', 'expression', 'head', 'body', 'gaze', 'position', 'opacity', 'costume', 'camera', 'fx', 'fade', 'background']), castId: z.string().optional(), keyId: z.string().optional(), beatId: z.string().optional(), offset: z.number().min(-10).max(60).optional(), value: z.unknown().optional(), duration: z.number().min(0).max(30).optional(), ease: z.string().optional(), remove: z.boolean().optional(), shiftSeconds: z.number().min(-30).max(30).optional(), shiftSteps: z.number().int().min(-50).max(50).optional(), reason, overwriteManual: manual }) },
  { name: 'set_lock', kind: 'write', description: '锁定/解锁。unit: scene|beat|shot|rhythm|wardrobe|blocking|track|key；beat/shot/rhythm 需 beatId；wardrobe/blocking 需 castId；locked=true/false；fields=只锁这些字段（beat: text,speakerId,kind,duration,emotion,cutIn；shot: type,focus,move,dof,transition,intent,offsets），空数组=清除字段锁。', schema: z.object({ sceneId: sceneArg, unit: z.enum(['scene', 'beat', 'shot', 'rhythm', 'wardrobe', 'blocking', 'track', 'key']), beatId: z.string().optional(), castId: z.string().optional(), trackId: z.string().optional(), keyId: z.string().optional(), locked: z.boolean().optional(), fields: z.array(z.string()).optional(), reason }) },
  { name: 'batch_edit', kind: 'write', description: '把【同一个】编辑模板批量用到一批句子上（query_beats 的 queryId / 一个 filter / 明确的 beatId 列表），整批只在卡片上显示成一组（可折叠，展开逐句看），一次应用、一步撤销。用法 A：tool + args = 对每一句调用那个写工具（args 不含 sceneId / beatId / beatIds / fromBeatId / toBeatId，由命中的句子自动填；例如 tool=set_shot args={type:"mcu"}，tool=edit_beat args={emotion:"sad"}，tool=set_timing args={gapSteps:2}，tool=set_fx args={fx:"dim"}（连续句子自动合成一段），tool=nudge_shot / set_actor 需要 args.castId）。用法 B：op = 一个 AgentOp 模板（beat_set / shot_set / shot_offset / timing / fx_range / key_set / beat_delete / lock_set，不含句子 id）。每一项都走和单个工具一样的检查：锁定 / 手改的句子不会被悄悄跳过，会作为「需要你确认」放进卡片。一次最多 400 句。', schema: BatchSchema, modelSchema: BatchModelSchema },
  { name: 'run_script', kind: 'write', description: '沙箱脚本（最后手段）：工具、query_beats + batch_edit 都表达不了的批量/规则化修改，才写一小段 JavaScript。脚本在隔离沙箱里只读运行（无文件、网络、定时器、import；CPU 约 2 秒、内存 64MB），只能 return 一个 op 数组，不能直接改任何东西；每个 op 照样走检查 / 锁定处理，成为一组变更（卡片上显示「AI 写的脚本」，可展开看源码）。沙箱里有：project（只读 JSON：scenes[].beats[]、cast、tracks…）、scenes()（场景列表）、beats(sceneId 或第几场)（句子行：beatId、beatNo、sceneId、speakerId、speaker、kind、text、chars、emotion、shotType、focus、move、intent、flow、fx、background、visible[]、hidden[]、lineGap、tail、seconds、lines（对话框行数）、overflow（超长）、expanded、locked、userEdited）、beat(id)、query(filter)（同 query_beats 的 filter，返回行数组）、visible(beatId)（画面上看得见的 castId 数组）、console.log(...)。op 构造器（sceneId 自动查）：op.setShot(beatId,{type,focus,move,dof,intent,flow:auto|cut|move|glide})、op.setBeat(beatId,{emotion,text,kind,...})、op.setEmotion(beatId,emotion)、op.setTiming(beatIds,{lineGap,tail,readingCps,minLine,textSpeedCps})、op.nudge(beatId,castId,dxSteps,dySteps)、op.setFx(fromBeatId,toBeatId,fx,{tone,edge,strength})、op.insertBeat(afterBeatId|null,{kind,text,speakerId,emotion},sceneId?)（返回的 op.newId 可立刻用于后面的 op）、op.deleteBeat(beatId)、op.moveBeat(beatId,afterBeatId)、op.raw({op:"...",...})。出错（语法、超时、op 不合法）会作为结果返回，修正后可重试（最多约 3 次，失败的脚本不会部分生效）；只 console.log 看数据、return [] 的一次不计入失败。简单需求请用普通工具。', schema: ScriptSchema },
  { name: 'revert_turn', kind: 'write', description: '「改回去 / 撤销 / 不要了 / 算了 / 还是原来的好」：把之前某一轮已应用的改动精确恢复成那一轮之前的值（对话历史里标着「可用 revert_turn」的轮次）。turnsAgo=1 是上一轮（默认），2 是上上轮；scopes 只撤其中某类（camera|performance|fx|rhythm|structure|staging|background|costume|lock，例如「节奏改回去」=[rhythm]）；beatIds 只撤这些句子上的。不要自己反推旧值。', schema: z.object({ turnsAgo: z.number().int().min(1).max(4).optional(), scopes: z.array(z.enum(['camera', 'performance', 'costume', 'staging', 'fx', 'background', 'structure', 'rhythm', 'lock'])).optional(), beatIds: z.array(Id).optional(), reason }) },
  { name: 'regenerate_scene_camera', kind: 'write', description: '让导演按你的倾向重新给整个场景（或一段句子）设计镜头，只重做镜头，不动节奏、表演、台词。适合「多用双人、少点特写」这类整场倾向；每轮最多 1 次，比较贵。guidance 写明倾向（≤200 字）。手改/锁定的镜头不会被覆盖。', schema: z.object({ sceneId: sceneArg, guidance: z.string().min(1).max(200), beatIds: z.array(Id).max(80).optional() }) },
  // long-term memory (server/agent/memoryStore.ts): not project edits; offered only when the server has a memory store
  { name: 'remember', kind: 'memory', description: '把用户的【长期偏好】存进跨对话的记忆（不是改项目）。how=stated：用户明确说了要长期遵守（「记住…」「以后…」「一律 / 总是 / 每次 / 都别…」「我不喜欢…」「我习惯…」），直接保存。how=inferred：用户没这么说，是你从他的反复纠正里推测出来的倾向，只会变成一张「要记住吗？」的建议卡片由用户确认，不会保存。只针对一句/一处的编辑（「把第3句改成特写」「这里停顿长一点」）绝不是偏好，不要调用。text 用一句简短、可执行的中文写成规则（「回忆特效一律用雾边 edge=fog」）。scope：用户说「这个项目 / 这部 / 本作」或规则涉及本项目的角色 → project；说「所有项目 / 不管哪个项目」或只是普遍的审美习惯 → global。kind 选这条偏好管的方面。castId：只针对某个角色时填（自动成为 project 范围）。replaces：要修改已有的一条记忆时填它的 id（不要再新建一条重复的）。', schema: z.object({ text: z.string().min(1).max(300), how: z.enum(['stated', 'inferred']), kind: z.enum(['camera', 'fx', 'blocking', 'pacing', 'other']).describe('camera=镜头/景别/运镜；fx=特效；blocking=站位、进出场、表情动作；pacing=节奏停顿；other=对你（助手）的工作习惯、只关于某几处内容的要求（例如「别动第3场」）。前四类也会给 AI 导演生成整场时参考'), scope: z.enum(['global', 'project']).optional().describe('默认 global；带 castId 时自动为 project'), castId: z.string().optional(), replaces: z.string().optional().describe('被替换的记忆 id'), why: z.string().max(200).optional().describe('inferred 时写：你从哪些纠正推测出来的') }) },
  { name: 'forget', kind: 'memory', description: '删除一条长期记忆（用户说「忘掉… / 别再记着… / 那条偏好不要了」）。id 来自系统提示里的记忆列表或 list_memories。只是这一次想不按记忆做时不要删（这一轮照指令做即可）。', schema: z.object({ id: z.string().min(1), reason }) },
  { name: 'list_memories', kind: 'memory', description: '列出所有长期记忆（全局 + 本项目，含被用户关掉的），带 id、范围、是否启用。用户问「你记得我哪些偏好」时用。', schema: z.object({}) },
];

export const toolByName = (name: string): ToolDef | undefined => TOOLS.find((t) => t.name === name);

// ---- helpers -----------------------------------------------------------------------------------------------
const sceneOf = (env: ToolEnv, id?: string): Scene | null => env.sandbox.scenes.find((s) => s.id === (id ?? env.selection.sceneId)) ?? null;
export function freeBeatId(scene: Scene): string {
  return nextId(`${scene.id}b`, scene.beats.map((b) => b.id), { idSeq: { ...(scene.idSeq ?? {}) } });
}
/** `n` distinct fresh beat ids (one per later piece of a split line). */
export function freeBeatIds(scene: Scene, n: number): string[] {
  const used = scene.beats.map((b) => b.id);
  const holder = { idSeq: { ...(scene.idSeq ?? {}) } };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = nextId(`${scene.id}b`, used, holder);
    used.push(id);
    out.push(id);
  }
  return out;
}
export function freeKeyId(scene: Scene): string {
  const used = scene.tracks.flatMap((t) => t.keys.map((k) => k.id));
  return nextId('k', used, { idSeq: { ...(scene.idSeq ?? {}) } });
}
const LADDER = { classic: ['group', 'two_shot', 'mcu', 'cu', 'ecu'], travel: ['group', 'two_shot', 'ms', 'mcu', 'cu', 'ecu'] } as const;
const j = (o: unknown) => JSON.stringify(o);

/**
 * A bulk edit (an effect range / "clear all effects") leaves locked and hand-made keys alone. That must not be silent: the same edit that
 * also takes those keys goes onto the card under "needs you" as an "unlock and apply" item (the sandbox is left as it is).
 */
function followUpProtected(env: ToolEnv, tool: string, op: AgentOp, skipped: string[], asks: unknown[]): void {
  if (skipped.length === 0 || op.op !== 'fx_range' || op.includeProtected) return;
  const follow = { ...op, includeProtected: true, reason: `${op.reason ?? '特效'}（含锁定 / 手改内容）` } as AgentOp;
  const r = checkOp(env.sandbox, follow, checkCtx(env));
  if (r.status !== 'needs_unlock' && r.status !== 'needs_confirm') return;
  env.pending.push({ id: ++env.seq.n, tool, op: r.op, status: r.status, changes: r.changes, warnings: r.warnings, notes: r.notes, violations: r.violations.map((v) => v.label), overwrote: r.overwrote, skipped: r.skipped });
  asks.push({ status: r.status === 'needs_unlock' ? '需要用户确认（有锁定）' : '需要用户确认（会覆盖手改）', 涉及: r.status === 'needs_unlock' ? r.violations.map((v) => v.label) : r.overwrote, 将改: r.changes.map((c) => `${c.where} ${c.field}：${c.before} → ${c.after}`) });
}

/** Run the ops of a tool call through check -> apply (sandbox) in order; stops at the first op that is not ok. */
export function commitOps(env: ToolEnv, tool: string, ops: AgentOp[], extra: { manual?: boolean | undefined; continueOnIssue?: boolean | undefined; restore?: boolean | undefined } = {}): string {
  const done: unknown[] = [];
  const asks: unknown[] = [];
  const bad: string[] = [];
  const warn: string[] = [];
  for (const raw of ops) {
    const op = extra.manual ? ({ ...raw, overrideUser: true } as AgentOp) : raw;
    env.stats.opsChecked++;
    const r = checkOp(env.sandbox, op, checkCtx(env, extra.restore === true));
    if (r.status === 'invalid') {
      env.stats.opsInvalid++;
      bad.push(...r.problems);
      if (extra.continueOnIssue) continue;
      break;
    }
    const rec: OpRecord = { id: ++env.seq.n, tool, op: r.op, status: r.status, changes: r.changes, warnings: r.warnings, notes: r.notes, violations: r.violations.map((v) => v.label), overwrote: r.overwrote, skipped: r.skipped };
    warn.push(...r.warnings, ...r.notes);
    if (r.status === 'ok') {
      const ap = applyOp(env.sandbox, r.op, { genId: env.genId, now: env.now() });
      if (!ap.ok) { bad.push(ap.error ?? '无法应用'); break; }
      if (ap.changes.length === 0) {
        // nothing changed (already so, or every target was locked / hand-made and skipped): not an item for the card
        done.push({ 没有变化: true, ...(ap.skipped.length ? { 跳过: [...new Set(ap.skipped)], 说明: '这些是锁定或手改的内容，没有动；它们已作为「待用户确认」的解锁项放进卡片' } : {}) });
        followUpProtected(env, tool, r.op, ap.skipped, asks);
        continue;
      }
      rec.changes = ap.changes;
      rec.skipped = ap.skipped;
      env.applied.push(rec);
      done.push({ 改了: ap.changes.map((c) => `${c.where} ${c.field}：${c.before} → ${c.after}`), ...(ap.skipped.length ? { 跳过: [...new Set(ap.skipped)] } : {}) });
      followUpProtected(env, tool, r.op, ap.skipped, asks);
    } else {
      env.pending.push(rec);
      asks.push({ status: r.status === 'needs_unlock' ? '需要用户确认（有锁定）' : '需要用户确认（会覆盖手改）', 涉及: r.status === 'needs_unlock' ? r.violations.map((v) => v.label) : r.overwrote, 将改: r.changes.map((c) => `${c.where} ${c.field}：${c.before} → ${c.after}`) });
      if (extra.continueOnIssue) continue;
      break;
    }
  }
  const out: Record<string, unknown> = {};
  if (done.length) out.已放入变更集 = done;
  if (asks.length) out.待用户确认 = asks;
  if (bad.length) out.错误 = bad;
  if (warn.length) out.提示 = [...new Set(warn)];
  if (asks.length) out.说明 = '待确认的改动没有应用到当前状态；请在最后的总结里告诉用户需要他确认，不要再重复提交同一改动。';
  if (!done.length && !asks.length && !bad.length) out.结果 = '没有任何变化（已经是这个状态）';
  return j(out);
}

// ---- tool implementations -----------------------------------------------------------------------------------
type Args = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function runTool(env: ToolEnv, name: string, rawArgs: unknown): string {
  env.stats.toolCalls++;
  const def = toolByName(name);
  if (!def) return j({ 错误: [`没有这个工具：${name}`, `可用：${TOOLS.map((t) => t.name).join(', ')}`] });
  if (def.kind === 'write') return countWrite(env, () => runToolInner(env, def, name, rawArgs));
  return runToolInner(env, def, name, rawArgs);
}

/** A write call counts as valid on the first try when nothing in its answer is an error (a pending "needs the user" is a valid call). */
export function countWrite(env: ToolEnv, f: () => string): string {
  env.stats.writeCalls++;
  const out = f();
  if (!out.includes('"错误"')) env.stats.writeFirstTryOk++;
  return out;
}

/** The scene a beat id lives in (beat ids are unique across the project), or null. */
const homeScene = (env: ToolEnv, beatId: string): Scene | null => env.sandbox.scenes.find((s) => s.beats.some((b) => b.id === beatId)) ?? null;

/**
 * A beat id names its scene: when the model left `sceneId` out and every beat the call names lives in one scene other than the selected
 * one, the call is about that scene (models often query the whole project and then edit a hit of another scene without the id).
 */
function withInferredScene(env: ToolEnv, def: ToolDef, a: Args): Args {
  if (a.sceneId !== undefined || !(def.schema instanceof z.ZodObject) || !('sceneId' in def.schema.shape)) return a;
  const ids = [a.beatId, a.fromBeatId, a.toBeatId, a.atBeatId, ...(Array.isArray(a.beatIds) ? a.beatIds : [])].filter((x): x is string => typeof x === 'string');
  if (ids.length === 0) return a;
  const cur = sceneOf(env);
  if (cur && ids.every((id) => cur.beats.some((b) => b.id === id))) return a;
  const homes = new Set(ids.map((id) => homeScene(env, id)?.id ?? null));
  if (homes.size !== 1 || homes.has(null)) return a;
  return { ...a, sceneId: [...homes][0] };
}

function runToolInner(env: ToolEnv, def: ToolDef, name: string, rawArgs: unknown): string {
  const parsed = def.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    env.stats.badArgs++;
    return j({ 错误: parsed.error.issues.slice(0, 4).map((i) => `参数 ${i.path.join('.') || '(根)'}：${i.message}`) });
  }
  const a = withInferredScene(env, def, parsed.data as Args);
  const sceneIdOrErr = (): Scene | string => sceneOf(env, a.sceneId) ?? j({ 错误: [`场景 ${a.sceneId ?? '(未选中)'} 不存在；当前可用：${env.sandbox.scenes.map((s) => s.id).join(', ')}`] });
  try {
    switch (name) {
      case 'get_scene': {
        const s = sceneIdOrErr();
        if (typeof s === 'string') return s;
        return sceneTable(env.sandbox, s.id, { ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}) });
      }
      case 'get_beat': {
        const s = sceneIdOrErr();
        if (typeof s === 'string') return s;
        return beatDetail(env.sandbox, s.id, a.beatId);
      }
      case 'find_beats': {
        const r = findBeats(env.sandbox, { sceneId: a.sceneId, speaker: a.speaker, text: a.text });
        return r.length === 0 ? '没有找到匹配的台词（可以换个更短的片段，或只按说话人查）' : `${r.some((x) => x.approx) ? '没有完全一致的，下面是近似匹配（引文可能记得不准）：\n' : ''}${r.map((x) => `第${x.sceneNo}场(${x.sceneId}) 第${x.beatNo}句 ${x.beatId} ${x.speaker}:「${x.text}」${x.approx ? `（近似 ${Math.round(x.approx * 100)}%）` : ''}`).join('\n')}`;
      }
      case 'list_options': return listOptions(env, a);
      case 'query_beats': return queryBeatsTool(env, a);
      case 'batch_edit': return batchEdit(env, parsed.data as never, batchDeps);
      case 'run_script': return runScriptTool(env, parsed.data as never, scriptDeps);
      default: return writeTool(env, name, a);
    }
  } catch (e) {
    return j({ 错误: [`工具内部错误：${(e as Error).message}`] });
  }
}

function queryBeatsTool(env: ToolEnv, a: Args): string {
  const idx = buildIndex(env.sandbox);
  const res = runQuery(idx, a.filter as BeatFilter | undefined);
  if (res.problems.length) return j({ 错误: res.problems, 说明: '过滤条件里有无法理解的部分，结果不可信；改正后重新查询' });
  const queries = (env.queries ??= new Map());
  const id = `q${queries.size + 1}`;
  queries.set(id, res.rows.map(refOf));
  const limit = (a.limit as number | undefined) ?? 60;
  const ids = res.rows.slice(0, 200).map((r) => r.beatId).join(',');
  return [`queryId=${id} 命中 ${res.rows.length} 句${res.rows.length > limit ? `（表格只列前 ${limit} 句；batch_edit 用 queryId 会改全部 ${res.rows.length} 句）` : ''}`, res.rows.length ? `beatIds（按剧本顺序${res.rows.length > 200 ? '，前 200' : ''}）：${ids}` : '', queryTable(env.sandbox, res.rows, limit)].filter(Boolean).join('\n');
}

const batchDeps = {
  writeTool: (env: ToolEnv, name: string, args: Args) => writeTool(env, name, args),
  toolSchema: (name: string) => toolByName(name)?.schema,
  commitOps: (env: ToolEnv, tool: string, ops: AgentOp[], extra?: { continueOnIssue?: boolean }) => commitOps(env, tool, ops, extra),
};
const scriptDeps = {
  commitOps: batchDeps.commitOps,
  freeBeatId,
  newStats,
  queryFn: (project: Project) => {
    const idx = buildIndex(project);
    return (filterJson: string): string => {
      let raw: unknown;
      try { raw = JSON.parse(filterJson); } catch { return j({ error: ['query(filter) 需要一个条件对象'] }); }
      const parsed = BeatFilterSchema.safeParse(raw);
      if (!parsed.success) return j({ error: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(filter)'}: ${i.message}`) });
      const res = runQuery(idx, parsed.data as BeatFilter);
      return j(res.problems.length ? { error: res.problems } : { rows: res.rows });
    };
  },
};

function listOptions(env: ToolEnv, a: Args): string {
  const p = env.sandbox;
  const scene = sceneOf(env, a.sceneId);
  if (a.kind === 'effects') return j({ fx: AI_FX, 一次性: ONE_SHOT_FX, memoryTone: MEMORY_TONES, memoryEdge: MEMORY_EDGES, 说明: 'dim 最多连续 4 句；flash/shake 只能一句' });
  if (a.kind === 'cast') {
    const L = env.catalog ? lookup(env.catalog) : null;
    return j({
      角色: p.cast.map((c) => ({ id: c.id, 名: c.displayName, 在本场景: scene ? !!scene.wardrobe[c.id] : undefined, 服装: scene?.wardrobe[c.id]?.modelId, ...(a.castId === c.id && L ? { 可换服装: (L.modelsOf.get(c.characterKey) ?? []).filter((m) => selectable(m)).slice(0, 24).map((m) => ({ modelId: m.id, 名: modelLabel(m) })) } : {}) })),
    });
  }
  if (a.kind === 'background') {
    if (!env.catalog) return j({ 错误: ['没有素材目录'] });
    const perf = !!scene?.brief?.isPerformance;
    const pool = env.catalog.backgrounds.filter((b) => autoSelectable(b, 'scene') && !perf);
    const ranked = rankBackgrounds(pool, String(a.query ?? ''), {}).slice(0, 12);
    return j(ranked.map((b) => ({ id: b.id, 名: b.name, 地点: b.location, 时间: b.time, 室内外: b.setting })));
  }
  if (!a.castId) return j({ 错误: ['需要 castId'] });
  if (!scene) return j({ 错误: ['场景不存在'] });
  const modelId = scene.wardrobe[a.castId]?.modelId;
  const m = modelId && env.catalog ? lookup(env.catalog).models.get(modelId) : undefined;
  if (!m) return j({ 错误: [`${a.castId} 不在本场景，或服装不在素材库里`] });
  if (a.kind === 'motion') return j({ 动作族: motionFamilies(m).map((f) => `${f}（${motionLabel(f)}）`) });
  return j({ 表情: m.mode === 'live' ? '演出服装没有表情' : m.expressions.map((e) => `${e.name}（${expressionLabel(e.name)}）`) });
}

function resolveBeat(scene: Scene, id: string): Beat | undefined {
  return scene.beats.find((b) => b.id === id);
}

function writeTool(env: ToolEnv, name: string, a: Args): string {
  if (name === 'revert_turn') return revertTurn(env, a);
  const scene = sceneOf(env, a.sceneId);
  if (!scene) return j({ 错误: [`场景 ${a.sceneId ?? '(未选中)'} 不存在；当前可用：${env.sandbox.scenes.map((s) => s.id).join(', ')}`] });
  const sid = scene.id;
  const p = env.sandbox;
  const cam = cameraSystemOf(p, scene);
  const rs = (a.reason as string | undefined)?.slice(0, 200);
  const base = { sceneId: sid, ...(rs ? { reason: rs } : {}) };
  const beatMissing = (id: string) => {
    if (resolveBeat(scene, id)) return null;
    const home = homeScene(env, id);
    return j({ 错误: [home ? `台词 ${id} 在场景 ${home.id}，不在 ${sid}：不同场景的句子请分开调用（每次写对应的 sceneId），或用 batch_edit` : `台词 ${id} 不存在（用 get_scene / query_beats 查 id）`] });
  };
  const done = (ops: AgentOp[]) => commitOps(env, name, ops, { manual: a.overwriteManual });
  // several beats in one call are independent edits: a locked / hand-made one goes to the user and the others still happen
  const doneEach = (ops: AgentOp[]) => commitOps(env, name, ops, { manual: a.overwriteManual, continueOnIssue: true });

  switch (name) {
    case 'edit_beat': {
      const miss = beatMissing(a.beatId);
      if (miss) return miss;
      const b = resolveBeat(scene, a.beatId)!;
      const set: Record<string, unknown> = {};
      if (a.text !== undefined) set.text = a.text;
      if (a.trimTo !== undefined) set.text = [...b.text].slice(0, a.trimTo).join('');
      if (a.speaker !== undefined) set.speakerId = a.speaker;
      if (a.kind !== undefined) set.kind = a.kind;
      for (const k of ['variant', 'emotion', 'cutIn', 'cutInKeepDialog'] as const) if (a[k] !== undefined) set[k] = a[k];
      if (a.durationSeconds !== undefined) set.duration = a.durationSeconds === null ? { mode: 'auto', seconds: 0 } : { mode: 'fixed', seconds: a.durationSeconds };
      return done([{ op: 'beat_set', ...base, beatId: a.beatId, set } as AgentOp]);
    }
    case 'edit_structure': {
      const act = a.action as string;
      if (act === 'insert') {
        const kind = a.kind ?? (a.speaker ? 'dialogue' : 'narration');
        return done([{ op: 'beat_insert', ...base, afterBeatId: a.afterBeatId ?? null, newId: freeBeatId(scene), beat: { kind, text: a.text ?? '', ...(a.speaker ? { speakerId: a.speaker } : {}), ...(a.emotion ? { emotion: a.emotion } : {}) } } as AgentOp]);
      }
      if (!a.beatId) return j({ 错误: ['需要 beatId'] });
      const miss = beatMissing(a.beatId);
      if (miss) return miss;
      if (act === 'delete') return done([{ op: 'beat_delete', ...base, beatId: a.beatId }]);
      if (act === 'move') return done([{ op: 'beat_move', ...base, beatId: a.beatId, afterBeatId: a.afterBeatId ?? null }]);
      if (act === 'split') return a.at ? done([{ op: 'beat_split', ...base, beatId: a.beatId, at: a.at, newId: freeBeatId(scene) }]) : j({ 错误: ['split 需要 at（第几个字之后拆开）'] });
      return done([{ op: 'beat_merge', ...base, beatId: a.beatId }]);
    }
    case 'split_line': {
      const miss = beatMissing(a.beatId);
      if (miss) return miss;
      const pieces = (a.pieces as string[]).map((text, i) => ({ text, ...(a.emotions?.[i] ? { emotion: a.emotions[i] as string } : {}) }));
      if (a.emotions && (a.emotions as string[]).length !== pieces.length) return j({ 错误: [`emotions 要和 pieces 一样多（${pieces.length} 个），没变的那段也要写，或者整个省略`] });
      return done([{ op: 'beat_split_pieces', ...base, beatId: a.beatId, pieces, newIds: freeBeatIds(scene, pieces.length - 1) } as AgentOp]);
    }
    case 'dialog_expand': {
      const miss = beatMissing(a.beatId);
      if (miss) return miss;
      return done([{ op: 'dialog_expand', ...base, beatId: a.beatId, on: a.on !== false } as AgentOp]);
    }
    case 'set_shot': {
      const ops: AgentOp[] = [];
      for (const id of a.beatIds as string[]) {
        const miss = beatMissing(id);
        if (miss) return miss;
        const b = resolveBeat(scene, id)!;
        const set: Record<string, unknown> = {};
        let type: string | undefined = a.type;
        let focus: string[] | undefined = a.focus;
        if (a.adjust && !type) {
          const ladder = LADDER[cam] as readonly string[];
          const cur = ladder.indexOf(b.shot.type);
          if (cur < 0) return j({ 错误: [`第${scene.beats.indexOf(b) + 1}句是 ${b.shot.type}，不在景别阶梯里，请直接指定 type`] });
          const next = Math.max(0, Math.min(ladder.length - 1, cur + (a.adjust === 'tighter' ? 1 : -1) * (a.steps ?? 1)));
          type = ladder[next]!;
          if (type === b.shot.type) continue;
          if (cam === 'travel' && a.adjust === 'tighter' && !a.intent && !a.flow) { set.intent = 'emphasis'; set.transition = 'travel'; }
        }
        if (type !== undefined) set.type = type;
        const finalType = type ?? b.shot.type;
        const i = scene.beats.indexOf(b);
        const on = [...(onStage(scene, i))];
        if (!focus && type !== undefined) {
          if (finalType === 'two_shot') {
            const sp = b.speakerId && on.includes(b.speakerId) ? b.speakerId : b.shot.focus[0];
            const wanted = b.shot.focus.find((f) => f !== sp) ?? on.find((c) => c !== sp);
            const partner = sp && wanted ? pairNeighbours(orderBySlot(scene, on), sp, wanted, null) ?? wanted : undefined;
            if (sp && partner && partner !== sp) focus = [sp, partner];
            else return j({ 错误: [`第${i + 1}句凑不出两个在台上的人，不能用 two_shot`] });
          } else if (['ms', 'mcu', 'cu', 'ecu'].includes(finalType) && b.shot.focus.length !== 1) {
            const sp = b.speakerId && on.includes(b.speakerId) ? b.speakerId : on[0];
            if (sp) focus = [sp];
          } else if (finalType === 'group') focus = [];
        }
        if (focus !== undefined) set.focus = focus;
        if (a.move !== undefined) set.move = a.move;
        if (a.dof !== undefined) set.dof = a.dof;
        if (a.intent !== undefined) set.intent = a.intent;
        if (a.flow !== undefined) set.transition = a.flow === 'auto' ? null : a.flow === 'cut' ? 'cut' : a.flow === 'move' ? 'travel' : 'glide';
        if (a.insertTarget !== undefined) { set.insertBox = INSERT_BOX[a.insertTarget as keyof typeof INSERT_BOX]; if (!type && b.shot.type !== 'insert') set.type = 'insert'; }
        if (Object.keys(set).length === 0) continue;
        ops.push({ op: 'shot_set', ...base, beatId: id, set } as AgentOp);
      }
      return ops.length ? doneEach(ops) : j({ 结果: '没有变化（已经到头了，或没有给出要改的字段）' });
    }
    case 'nudge_shot': {
      const miss = beatMissing(a.beatId);
      if (miss) return miss;
      const b = resolveBeat(scene, a.beatId)!;
      if (a.resetOffset) return done([{ op: 'shot_offset', ...base, beatId: a.beatId, castId: a.castId, offset: null }]);
      const cur = b.shot.offsets?.[a.castId] ?? { x: 0, y: 0 };
      const r = (v: number) => Math.round(v * 1000) / 1000;
      const clamp = (v: number) => Math.max(-2, Math.min(2, v));
      return done([{ op: 'shot_offset', ...base, beatId: a.beatId, castId: a.castId, offset: { x: clamp(r(cur.x + (a.dxSteps ?? 0) * NUDGE.offset)), y: clamp(r(cur.y + (a.dySteps ?? 0) * NUDGE.offset)) } }]);
    }
    case 'set_actor': {
      const miss = beatMissing(a.beatId);
      if (miss) return miss;
      const ops: AgentOp[] = [];
      const target = { kind: 'actor' as const, castId: a.castId };
      const at = { beatId: a.beatId, offset: a.atOffset ?? 0 };
      const key = (channel: string, value: unknown, off?: number, duration?: number) => ops.push({ op: 'key_set', ...base, target, channel, at: { beatId: a.beatId, offset: off ?? at.offset }, value, ...(duration !== undefined ? { duration } : {}), newKeyId: undefined } as unknown as AgentOp);
      if (a.motion !== undefined) key('motion', { name: a.motion }, a.atOffset ?? 0.05);
      if (a.expression !== undefined) key('expression', { name: a.expression });
      const look = (ch: 'head' | 'body' | 'gaze', t: string) => {
        if (ch === 'gaze') key('gaze', { target: t }, a.atOffset ?? 0.1);
        else key(ch, { mode: 'target', target: t }, a.atOffset ?? 0.1, 0.3);
      };
      for (const ch of ['head', 'body', 'gaze'] as const) if (a[ch] !== undefined && !(ch === 'head' && a.headTilt !== undefined)) look(ch, a[ch]);
      if (a.headTilt !== undefined) {
        // the pitch rides on the head key: keep the facing that is already there (the last head key at or before this line), else the default facing
        const order = new Map(scene.beats.map((bb, bi) => [bb.id, bi]));
        const here = order.get(a.beatId) ?? 0;
        const prevKey = scene.tracks.filter((tr) => tr.channel === 'head' && tr.target.kind === 'actor' && (tr.target as { castId: string }).castId === a.castId).flatMap((tr) => tr.keys as ReadonlyArray<{ at: { beatId: string; offset: number }; value: unknown }>)
          .filter((k) => (order.get(k.at.beatId) ?? 1e9) < here || ((order.get(k.at.beatId) ?? 1e9) === here && k.at.offset <= (a.atOffset ?? 0.1)))
          .sort((x, y) => ((order.get(x.at.beatId) ?? 0) - (order.get(y.at.beatId) ?? 0)) || x.at.offset - y.at.offset).at(-1);
        const prev = prevKey?.value as { mode: string; target?: string; yaw?: number } | undefined;
        const facing = a.head !== undefined ? { mode: 'target', target: a.head } : prev?.mode === 'angle' ? { mode: 'angle', yaw: prev.yaw } : { mode: 'target', target: prev?.target ?? 'auto' };
        const pitch = a.headTilt === 'down' ? HEAD_DOWN : a.headTilt === 'up' ? HEAD_UP : 0;
        key('head', { ...facing, ...(pitch !== 0 ? { pitch } : {}) }, a.atOffset ?? 0.1, 0.3);
      }
      if (a.moveTo || a.slotSteps !== undefined || a.depth) {
        const b = resolveBeat(scene, a.beatId)!;
        void b;
        const cur = currentSlot(scene, a.castId, a.beatId);
        const slot = a.moveTo ? SLOT_X[a.moveTo as keyof typeof SLOT_X] : Math.max(-1, Math.min(1, Math.round((cur.slot + (a.slotSteps ?? 0) * NUDGE.slot) * 1000) / 1000));
        const depth = a.depth ? DEPTH_Y[a.depth as keyof typeof DEPTH_Y] : cur.depth;
        key('position', { slot, depth }, a.atOffset ?? 0, 0.8);
      }
      for (const ch of (a.remove ?? []) as string[]) {
        const tr = scene.tracks.find((t) => t.channel === ch && t.target.kind === 'actor' && (t.target as { castId: string }).castId === a.castId);
        const k = tr?.keys.find((x) => x.at.beatId === a.beatId);
        if (k) ops.push({ op: 'key_set', ...base, target, channel: ch, keyId: k.id, remove: true } as unknown as AgentOp);
      }
      if (!ops.length) return j({ 错误: ['没有要设置的内容（motion/expression/head/body/gaze/moveTo/slotSteps/remove 至少一个）'] });
      return done(ops);
    }
    case 'set_fx': {
      const to = a.toBeatId ?? a.fromBeatId;
      for (const id of [a.fromBeatId, to]) { const miss = beatMissing(id); if (miss) return miss; }
      let strength: number | undefined = a.strength;
      if (a.strengthSteps !== undefined) {
        const tr = scene.tracks.find((t) => t.channel === 'fx');
        const k = tr?.keys.find((x) => x.at.beatId === a.fromBeatId && (x.value as { fx: string }).fx === a.fx && (x.value as { strength: number }).strength > 0);
        const curS = (k?.value as { strength: number } | undefined)?.strength ?? 1;
        strength = Math.max(0, Math.min(1, Math.round((curS + a.strengthSteps * NUDGE.strength) * 100) / 100));
      }
      return done([{ op: 'fx_range', ...base, fromBeatId: a.fromBeatId, toBeatId: to, fx: a.fx, ...(a.tone ? { tone: a.tone } : {}), ...(a.edge ? { edge: a.edge } : {}), ...(a.variant ? { variant: a.variant } : {}), ...(strength !== undefined ? { strength } : {}) } as AgentOp]);
    }
    case 'set_entrance': {
      const ops: AgentOp[] = [];
      const castId = a.castId as string;
      const cm = p.cast.find((c) => c.id === castId);
      if (!cm) return j({ 错误: [`角色 ${castId} 不存在（可用：${p.cast.map((c) => `${c.id}=${c.displayName}`).join('，')}）`] });
      if (a.inScene === false) ops.push({ op: 'actor_presence', ...base, castId, present: false });
      else if (!scene.wardrobe[castId]) {
        const L = env.catalog ? lookup(env.catalog) : null;
        const modelId = a.modelId ?? (L ? defaultModel(L, cm.characterKey)?.id : undefined);
        if (!modelId) return j({ 错误: [`${cm.displayName} 不在本场景，需要指定 modelId（list_options cast 查服装）`] });
        ops.push({ op: 'actor_presence', ...base, castId, present: true, modelId });
      }
      const st: Record<string, unknown> = {};
      if (a.enterAt !== undefined) { if (a.enterAt !== null) { const miss = beatMissing(a.enterAt); if (miss) return miss; } st.enter = a.enterAt === null ? null : { beatId: a.enterAt, side: a.side ?? 'none' }; }
      else if (a.side !== undefined && scene.blocking[castId]?.enter) st.enter = { beatId: scene.blocking[castId]!.enter!.beatId, side: a.side };
      if (a.exitAt !== undefined) { if (a.exitAt !== null) { const miss = beatMissing(a.exitAt); if (miss) return miss; } st.exit = a.exitAt === null ? null : { beatId: a.exitAt }; }
      if (a.startMoveTo) st.slot = SLOT_X[a.startMoveTo as keyof typeof SLOT_X];
      else if (a.startSlotSteps !== undefined) st.slot = Math.max(-1, Math.min(1, Math.round(((scene.blocking[castId]?.slot ?? 0) + a.startSlotSteps * NUDGE.slot) * 1000) / 1000));
      if (a.startDepth) st.depth = DEPTH_Y[a.startDepth as keyof typeof DEPTH_Y];
      if (Object.keys(st).length) ops.push({ op: 'stage_set', ...base, castId, ...st } as AgentOp);
      if (!ops.length) return j({ 错误: ['没有要设置的内容'] });
      return done(ops);
    }
    case 'set_timing': {
      for (const id of a.beatIds as string[]) { const miss = beatMissing(id); if (miss) return miss; }
      if (a.reset) return doneEach(mergeTiming(env, (a.beatIds as string[]).map((id) => ({ op: 'timing', ...base, beatIds: [id], set: {}, clear: true } as AgentOp))));
      // one op per beat: each beat's own current value is the base of a relative step
      const ops: AgentOp[] = [];
      for (const id of a.beatIds as string[]) {
        const b = resolveBeat(scene, id)!;
        const cur = resolveStyle(p.style, scene.style, b.style).values.rhythm;
        const set: Record<string, number> = {};
        const r2 = (v: number) => Math.round(v * 100) / 100;
        const clampTo = (path: string, v: number) => { const f = rhythmRange[path]!; return Math.max(f[0], Math.min(f[1], r2(v))); };
        if (a.pace === 'slower') { set['rhythm.readingCps'] = clampTo('rhythm.readingCps', cur.readingCps * NUDGE.pace); set['rhythm.tail'] = clampTo('rhythm.tail', cur.tail + 0.3); set['rhythm.lineGap'] = clampTo('rhythm.lineGap', cur.lineGap + 0.2); }
        if (a.pace === 'faster') { set['rhythm.readingCps'] = clampTo('rhythm.readingCps', cur.readingCps / NUDGE.pace); set['rhythm.tail'] = clampTo('rhythm.tail', cur.tail - 0.3); set['rhythm.lineGap'] = clampTo('rhythm.lineGap', cur.lineGap - 0.2); }
        if (a.pace === 'normal') { for (const k of ['rhythm.readingCps', 'rhythm.tail', 'rhythm.lineGap']) if (k in b.style.overrides) ops.push({ op: 'timing', ...base, beatIds: [id], set: { [k]: 0 }, clear: true } as AgentOp); }
        if (a.gapSteps !== undefined) set['rhythm.lineGap'] = clampTo('rhythm.lineGap', (set['rhythm.lineGap'] ?? cur.lineGap) + a.gapSteps * NUDGE.gap);
        if (a.tailSteps !== undefined) set['rhythm.tail'] = clampTo('rhythm.tail', (set['rhythm.tail'] ?? cur.tail) + a.tailSteps * NUDGE.gap);
        if (a.gapSeconds !== undefined) set['rhythm.lineGap'] = a.gapSeconds;
        for (const [arg, path] of [['readingCps', 'rhythm.readingCps'], ['lineGap', 'rhythm.lineGap'], ['tail', 'rhythm.tail'], ['minLine', 'rhythm.minLine'], ['textSpeedCps', 'rhythm.textSpeedCps']] as const) if (a[arg] !== undefined) set[path] = a[arg];
        if (Object.keys(set).length) ops.push({ op: 'timing', ...base, beatIds: [id], set } as AgentOp);
      }
      return ops.length ? doneEach(mergeTiming(env, ops)) : j({ 错误: ['没有要设置的内容'] });
    }
    case 'set_background': {
      const bg = a.assetId && env.catalog ? env.catalog.backgrounds.find((x) => x.id === a.assetId) : undefined;
      if (a.at !== 'start') { const miss = beatMissing(a.at); if (miss) return miss; }
      const purpose = a.purpose === 'empty_shot' ? 'insert' : a.purpose;
      const out = done([{ op: 'bg_set', ...base, at: a.at, assetId: a.assetId, ...(a.transition ? { transition: a.transition } : {}), ...(a.seconds !== undefined ? { transitionSeconds: a.seconds } : {}), ...(purpose ? { purpose } : {}), ...(a.at === 'start' && bg ? { location: bg.location ?? bg.name } : {}) } as AgentOp]);
      return withScreen(env, sid, a.at === 'start' ? null : a.at, out);
    }
    case 'set_scene': {
      const set: Record<string, unknown> = {};
      for (const k of ['title', 'cameraSystem', 'mood', 'timeOfDay'] as const) if (a[k] !== undefined) set[k] = a[k];
      if (a.transitionKind) set.transitionIn = { kind: a.transitionKind, duration: a.transitionSeconds ?? scene.transitionIn.duration };
      else if (a.transitionSeconds !== undefined) set.transitionIn = { kind: scene.transitionIn.kind, duration: a.transitionSeconds };
      if (a.locationText !== undefined || a.locationShow !== undefined) set.location = { ...(a.locationText !== undefined ? { text: a.locationText } : {}), ...(a.locationShow !== undefined ? { show: a.locationShow } : {}) };
      return Object.keys(set).length ? done([{ op: 'scene_set', ...base, set } as AgentOp]) : j({ 错误: ['没有要设置的内容'] });
    }
    case 'set_costume': {
      if (!a.atBeatId) return done([{ op: 'wardrobe_set', ...base, castId: a.castId, modelId: a.modelId }]);
      const miss = beatMissing(a.atBeatId);
      if (miss) return miss;
      return done([{ op: 'key_set', ...base, target: { kind: 'actor', castId: a.castId }, channel: 'costume', at: { beatId: a.atBeatId, offset: 0 }, value: { modelId: a.modelId } } as AgentOp]);
    }
    case 'set_keyframe': return setKeyframe(env, scene, a, base, done);
    case 'set_lock': return done([{ op: 'lock_set', ...base, unit: a.unit, ...(a.beatId ? { beatId: a.beatId } : {}), ...(a.castId ? { castId: a.castId } : {}), ...(a.trackId ? { trackId: a.trackId } : {}), ...(a.keyId ? { keyId: a.keyId } : {}), ...(a.locked !== undefined ? { locked: a.locked } : {}), ...(a.fields !== undefined ? { lockedFields: a.fields } : {}) } as AgentOp]);
    default: return j({ 错误: [`工具 ${name} 不在这里处理`] });
  }
}

/** Undo an earlier applied turn (or part of it) with the ops recorded when it was applied. */
function revertTurn(env: ToolEnv, a: Args): string {
  const n = (a.turnsAgo as number | undefined) ?? 1;
  const entry = env.reverts?.find((r) => r.turnsAgo === n);
  if (!entry) return j({ 错误: [env.reverts?.length ? `第 ${n} 轮之前没有可撤销的已应用改动；可撤销的：${env.reverts.map((r) => `turnsAgo=${r.turnsAgo}「${r.instruction.slice(0, 20)}」`).join('，')}` : '对话里没有已应用、可撤销的改动（用户可能还没应用那张卡片）'] });
  const scopes = a.scopes as string[] | undefined;
  const beats = a.beatIds as string[] | undefined;
  const beatsOf = (op: AgentOp): string[] => {
    const o = op as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ids = [o.beatId, ...(o.beatIds ?? []), o.at?.beatId, o.newId, o.fromBeatId].filter((x): x is string => typeof x === 'string');
    if (o.keyId && !o.at) for (const sc of env.sandbox.scenes) for (const t of sc.tracks) for (const k of t.keys) if (k.id === o.keyId) ids.push(k.at.beatId);
    return ids;
  };
  const ops = entry.ops.filter((op) => (!scopes || scopes.includes(scopeOf(op))) && (!beats || beatsOf(op).some((b) => beats.includes(b))));
  if (ops.length === 0) return j({ 结果: '按这个范围没有可撤销的改动', 那一轮可撤销的类别: [...new Set(entry.ops.map(scopeOf))] });
  return commitOps(env, 'revert_turn', ops.map((op) => ({ ...op, reason: `撤销「${entry.instruction.slice(0, 24)}」` }) as AgentOp), { continueOnIssue: true, restore: true });
}

const rhythmRange: Record<string, [number, number]> = { 'rhythm.readingCps': [2, 30], 'rhythm.tail': [0, 5], 'rhythm.lineGap': [0, 3], 'rhythm.minLine': [0.2, 10], 'rhythm.textSpeedCps': [2, 40] };

/**
 * Several single-beat timing ops with the same values become one op (one line in the card) — but only beats with the same verdict
 * (ok / locked / hand-made): one locked beat must not hold back the others.
 */
function mergeTiming(env: ToolEnv, ops: AgentOp[]): AgentOp[] {
  const out: Array<Extract<AgentOp, { op: 'timing' }>> = [];
  const verdict = new Map<AgentOp, string>();
  for (const o of ops) verdict.set(o, checkOp(env.sandbox, o, checkCtx(env)).status);
  const group = new Map<object, string>();
  for (const o of ops) {
    if (o.op !== 'timing') continue;
    const same = out.find((x) => group.get(x) === verdict.get(o) && !!x.clear === !!o.clear && j(x.set) === j(o.set));
    if (same) same.beatIds.push(...o.beatIds);
    else { const c = { ...o, beatIds: [...o.beatIds] }; group.set(c, verdict.get(o)!); out.push(c); }
  }
  return out;
}

/** Adds who the viewer really sees (compiled presence) at a background change and the line after it, so a read-back cannot claim people that are hidden. */
function withScreen(env: ToolEnv, sceneId: string, beatId: string | null, out: string): string {
  const scene = env.sandbox.scenes.find((s) => s.id === sceneId);
  if (!scene || out.includes('"错误"')) return out;
  const pres = scenePresence(env.sandbox, sceneId);
  const i = beatId ? scene.beats.findIndex((b) => b.id === beatId) : 0;
  if (i < 0) return out;
  const name = (c: string) => env.sandbox.cast.find((x) => x.id === c)?.displayName || c;
  const rows = pres.slice(i, i + 2).map((pr) => {
    const n = scene.beats.findIndex((b) => b.id === pr.beatId) + 1;
    const hidden = Object.entries(pr.hidden).filter(([, r]) => r === 'empty_shot_bg' || r === 'empty_beat' || r === 'opacity_0').map(([c, r]) => `${name(c)}（${HIDDEN_REASON_LABEL[r]}）`);
    return `第${n}句：${pr.visible.map(name).join('、') || '无人'}${hidden.length ? `；隐藏：${hidden.join('、')}` : ''}`;
  });
  return j({ ...JSON.parse(out), 画面上的人: rows });
}

function onStage(scene: Scene, i: number): Set<string> {
  const idx = (id: string | undefined) => (id === undefined ? -1 : scene.beats.findIndex((b) => b.id === id));
  const out = new Set<string>();
  for (const [c, bl] of Object.entries(scene.blocking)) {
    const e = bl.enter ? idx(bl.enter.beatId) : -1;
    const x = bl.exit ? idx(bl.exit.beatId) : -1;
    if (e >= 0 && i < e) continue;
    if (x >= 0 && i >= x) continue;
    out.add(c);
  }
  return out;
}
const orderBySlot = (scene: Scene, ids: string[]) => [...ids].sort((x, y) => (scene.blocking[x]?.slot ?? 0) - (scene.blocking[y]?.slot ?? 0));

/** Where the person stands at a beat: the last position key at or before it, else the scene's start position. */
function currentSlot(scene: Scene, castId: string, beatId: string): { slot: number; depth: number } {
  const order = new Map(scene.beats.map((b, i) => [b.id, i]));
  const at = order.get(beatId) ?? 0;
  const keys = (scene.tracks as unknown as Array<{ channel: string; target: { kind: string; castId?: string }; keys: Array<{ at: { beatId: string; offset: number }; value: unknown }> }>).filter((t) => t.channel === 'position' && t.target.castId === castId).flatMap((t) => t.keys)
    .filter((k) => (order.get(k.at.beatId) ?? 1e9) <= at).sort((x, y) => (order.get(x.at.beatId)! - order.get(y.at.beatId)!) || x.at.offset - y.at.offset);
  const v = keys.at(-1)?.value as { slot: number; depth: number } | undefined;
  return v ?? { slot: scene.blocking[castId]?.slot ?? 0, depth: scene.blocking[castId]?.depth ?? 0.3 };
}

function setKeyframe(env: ToolEnv, scene: Scene, a: Args, base: Record<string, unknown>, done: (ops: AgentOp[]) => string): string {
  const channel = a.channel as string;
  const actor = ['motion', 'expression', 'head', 'body', 'gaze', 'position', 'opacity', 'costume'].includes(channel);
  if (actor && !a.castId) return j({ 错误: [`${channel} 轨道需要 castId`] });
  const target = actor ? { kind: 'actor', castId: a.castId } : channel === 'camera' ? { kind: 'camera' } : channel === 'background' ? { kind: 'stage' } : { kind: 'screen' };
  void env;
  if (a.shiftSeconds !== undefined || a.shiftSteps !== undefined) {
    if (!a.keyId) return j({ 错误: ['平移关键帧需要 keyId（用 get_beat 查）'] });
    return done([{ op: 'key_shift', ...base, keyId: a.keyId, seconds: a.shiftSeconds ?? a.shiftSteps * NUDGE.time } as AgentOp]);
  }
  if (a.remove) return done([{ op: 'key_set', ...base, target, channel, remove: true, ...(a.keyId ? { keyId: a.keyId } : {}), ...(a.beatId ? { at: { beatId: a.beatId, offset: a.offset ?? 0 } } : {}) } as AgentOp]);
  return done([{ op: 'key_set', ...base, target, channel, ...(a.keyId ? { keyId: a.keyId } : { newKeyId: freeKeyId(scene) }), ...(a.beatId ? { at: { beatId: a.beatId, offset: a.offset ?? 0 } } : {}), ...(a.value !== undefined ? { value: a.value } : {}), ...(a.duration !== undefined ? { duration: a.duration } : {}), ...(a.ease ? { ease: a.ease } : {}) } as AgentOp]);
}

/** All the words the model may use, for the system prompt (one line per list). */
export function vocabularyLines(cam: 'classic' | 'travel'): string[] {
  return [
    `景别：${(cam === 'travel' ? AI_TRAVEL_SHOT_TYPES : AI_SHOT_TYPES).join(' / ')}`,
    cam === 'travel' ? `意图 intent：${SHOT_INTENTS.join(' / ')}；flow：auto / cut / move / glide` : '经典镜头系统：没有 intent；flow 只有 auto / cut / glide',
    `情绪：${EMOTIONS.join(' / ')}`,
    `站位：${SLOT_NAMES.join(' / ')}；深度：${DEPTH_NAMES.join(' / ')}`,
    `看向：castId 或 ${SPECIAL_ATTENTION.join(' / ')}`,
    `特效：${AI_FX.join(' / ')}`,
  ];
}
