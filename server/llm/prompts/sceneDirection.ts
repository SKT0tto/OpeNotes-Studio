import type { ActorResources } from '../../../shared/director/catalogDigest';
import type { Paragraph } from '../../../shared/director/paragraphs';
import type { ZodType } from 'zod';
import { SceneDirectionSchema, SceneDirectionTravelSchema, type SceneDirection } from '../../../shared/schema/ai';
import type { CameraSystem } from '../../../shared/schema/project';
import { AI_FX, AI_MOVES, AI_SHOT_TYPES, AI_TRAVEL_SHOT_TYPES, DEPTH_NAMES, EMOTIONS, INSERT_TARGETS, SLOT_NAMES } from '../../../shared/director/vocab';

export const SCENE_PROMPT_VERSION = 'scene-4';

export const SCENE_SYSTEM = `你是 BanG Dream! 同人动画的「演出指导」。你会拿到一个场景的原文段落、在场角色（含该服装真实可用的动作与表情清单）和上一场景的结束状态，请把这个场景一次性导成一组节拍（beats），只输出 JSON。

# 你只决定「意图」，不写坐标、不写文件名
程序会把你的意图变成坐标、时间、镜头和关键帧。所以不要输出数字坐标，也不要发明任何 ID。

# 节拍 beats
- 把原文拆成一连串节拍，按原文顺序。一个段落可以拆成多个节拍：每句对白一个 dialogue 节拍（speaker 是说话人的 castId，text 尽量原样取自原文引号内的话）；叙述用 narration（text 可以精简，但必须来自该段原文）；需要让观众只看角色反应、不显示文字时用 silent（text 为空，speaker=null）。
- 节奏要像游戏里的剧情演出，不是朗读小说：对白是主体，旁白（narration）整个场景里只占约 20%，最多 25%。凡是「某某低下头 / 笑了 / 握紧拳头 / 站起来」这类动作、表情、神态描写，不要写成旁白，而是并入前后对白的 actors（motion / expression / attention），或单独做一个 silent 节拍表现反应。只有交代时间地点、必须靠文字才能理解的心理活动或转折，才保留 narration，且尽量精简到一两句。相邻的几句叙述请合并成一个 narration。
- paragraph 是该节拍所在的段落编号（必须在给定范围内，且文本能在该段原文里找到）。不要编造原文没有的台词。
- 每个 beat 都要有 emotion，只能取：${EMOTIONS.join(' / ')}。reason 用不超过 20 个字写理由（情绪、关系、节奏）。输出要紧凑，不要多余的文字。
- 一个场景只调用一次，不要逐句等待；也不要每句都换镜头。

# 镜头 shot（只表达意图，节奏由程序兜底）
- type 只能是：${AI_SHOT_TYPES.join(' / ')}。group=多人同框交代全体；two_shot=两人对话（focus 填两人）；mcu=单人中景（默认的对白镜头）；cu=情绪升高时的近景；ecu=情绪高点/强烈反应的大特写；insert=手部/乐器/物件特写（很少用，整个场景最多 1 个）。
- 普通对白多用 mcu / two_shot；情绪高点用 cu 或 ecu；交代环境或多人同时在场用 group；沉默/反应用 silent + cu。focus 是镜头对准的 castId（对白里通常是说话人，two_shot 填两人，group 可留空数组）。
- insert 只在这一节拍确实有可拍的东西时才用：角色正在做手势/握拿东西、演奏乐器，或原文明确写到手和物件。insert 必须同时填 insertTarget：${INSERT_TARGETS.join(' / ')}（hands=手部动作，instrument=乐器/演奏，face_lower=嘴与下巴）。其他景别 insertTarget 填 null。没有可拍之物就不要用 insert，改用 cu。画面里绝不能是没有头也没有手的躯干或裙摆。
- move 默认 static，需要强调时才用 ${AI_MOVES.slice(1).join(' / ')}。dof 填 null（交给程序）或 0–6。
- cutIn：默认 cut（硬切）；时间或情绪发生跳转时才用 dip_black；强光、白场式的转场用 dip_white（回忆的进出已自动加白场，不用再写）。
- fx：${AI_FX.join(' / ')}。memory=回忆或闪回段落（白边+褪色，进出自动加白场），整段回忆的每个节拍都写 memory，回到现在时改回 none，可选 memoryTone=cool(默认)/warm(很久以前)/sepia(旧照片)/mono(定格)；dim=角色心声、括号里的内心独白（画面压暗），只用在独白那一两拍；flash=顿悟、惊觉的一瞬白光；shake=受惊、拍桌、冲击的短促抖动；daze=头晕、刚醒、泪眼模糊；vignette_anxiety=不安/紧张；dutch=失衡/强烈不安的倾斜。绝大多数节拍用 none，持续的氛围用同一个值，之后改回 none。

# 演员 actors（只列这一节拍里有明确表演的人）
- motion：动作族名，必须原样取自该角色「motions」清单里的某一项，没有合适的就填 null。expression：必须原样取自该角色「expressions」清单（live-mode 服装没有表情，填 null）。动作与表情要符合情绪（笑着说→smile 系，难过→sad 系）。
- attention：这个人此刻看向谁：其他在场角色的 castId，或 camera / away / down（低头/移开视线体现情绪），不特别时填 null（程序会让说话人看听者、听者看说话人）。
- enter=true 表示这个角色从这一节拍才登场；exit=true 表示从这一节拍起离场。move 是走到的新站位（${SLOT_NAMES.join(' / ')}），多数时候填 null。

# 站位 blocking（场景开头）与转场
- blocking：给每个在场角色一个 slot（${SLOT_NAMES.join(' / ')}）和 depth（${DEPTH_NAMES.join(' / ')}）。日常场景按人物关系站位（亲近的挨着、说话对象面对面）；正式演出（isPerformance）的站位由程序按乐队编队决定，你照填即可。
- transitionIn：与上一场景的衔接：cut / dip_black / scene_black（场景之间默认 scene_black）。bgm 填 null。

# 服装
- 服装在拆解阶段已定。只有场景中途确实换衣服（原文写到）时才写 costumeChanges（beatIndex 是 beats 数组下标；modelId 只能取该角色 outfits 里的）。否则 costumeChanges 为空数组。
- 正式演出场景：演奏用 live-mode 服装，动作用 play*/action*/finish* 系，不要有表情。

# 场景内换背景 bg
- 输入 scene.backgrounds 给出本场景的背景集合：start（开场背景）、moves（拆解阶段已判定的场景内地点移动，每项有 paragraph 和背景）、inserts（可用于插入镜头的背景）。**只能**用这个集合里的 id，不得新增地点，也不得使用其他背景。
- 某个 beat 开始时地点换了，在该 beat 填 bg: { backgroundId, transition }（transition：cut / dip_black / crossfade）；多数 beat 的 bg 填 null。moves 里的移动要落在对应 paragraph 的第一个 beat 上，原文没有写到的移动不要自己加。同一个 beat 只能切一次；不要连续两次切到同一个背景。
- 插入镜头（空镜头）：想给天空、信号灯、斑马线之类的画面时，用 inserts 里的背景，同时该 beat 的 shot 必须是 type=insert、insertTarget=scene、focus=[]（画面里没有人物，人物会暂时隐藏）；下一个 beat 程序会自动切回原来的背景。整个场景最多 1–2 个。
- 正式演出（isPerformance）的场景不要换背景。

# 固定节拍
输入里的 fixedBeats 是已被人锁定/人工编写的节拍：必须在对应位置原样重现（keepId 填它的 id，paragraph/kind/speaker/text 原样复制）。局部重新生成（mode.focusBeatIds 存在）时，fixedBeats 就是要重做的那几个节拍：beats 只输出这些节拍，与 fixedBeats 一一对应、顺序和 text 完全一致，你只改变 mode.scopes 要求的那一方面。paragraphs 里的其他段落只是上下文，不要为它们输出任何节拍。输出要尽量紧凑（reason 不超过 10 个字）。

# 输出
严格输出符合 JSON Schema 的一个 JSON 对象。`;

export interface SceneDirectionInput {
  scene: {
    title: string; mood: string; timeOfDay: string; location: string; isPerformance: boolean; band: string | null; paragraphRange: [number, number];
    /** Backgrounds this scene may use: where it starts, the place changes Pass 1 found, and cut-away candidates. */
    backgrounds: { start: { id: string; title: string }; moves: Array<{ paragraph: number; id: string; title: string }>; inserts: Array<{ id: string; title: string }> };
  };
  cast: ActorResources[];
  paragraphs: Array<{ i: number; text: string }>;
  previousScene: { title: string; endSummary: string } | null;
  /** Only on the 2nd and later span of a long scene: what the spans before it established (read-only context). */
  continuation?: {
    note: string;
    contextParagraphs: Array<{ i: number; text: string }>;
    previousBeats: Array<{ kind: string; speaker: string | null; text: string }>;
    onStage: string[];
    notYetSeen: string[];
    exited: string[];
  };
  /** Only on a span that is NOT the last of its scene: the scene goes on after it, so its last beat must not close the scene. */
  sceneContinues?: { note: string; nextParagraph: number };
  /** Only on a camera regeneration asked for by the agent / the user: a preference for the shots (absent otherwise, so the request bytes and the cache key of every other run stay as they were). */
  guidance?: { note: string; text: string };
  fixedBeats: Array<{ keepId: string; paragraph: number; kind: string; speaker: string | null; text: string; lockedFields?: string[] }>;
  mode: { scopes: string[]; focusBeatIds?: string[] };
}

/** Extra instructions and the version tag of the travel camera system. The classic prompt (SCENE_SYSTEM, SCENE_PROMPT_VERSION) is never touched, so classic requests and cache keys stay as they were. */
/**
 * A short original scene that shows the travel rules at work (only the fields that matter for the camera; the real answer has them all).
 * Exported so the tests can run it through the same validation as a real answer.
 */
export const TRAVEL_EXAMPLE_PARAGRAPHS = [
  '夕阳把天台的栏杆染成橘色。小夏把一枚生锈的钥匙放在栏杆上。',
  '“这是你上次丢的吧。”小夏说。',
  '阿秋愣了一下，没有接。',
  '“……不是我的。”',
  '“那它为什么会在你的书包里？”',
  '水箱后面传来一声轻响，小冬探出头来。',
  '“对不起，我只是想……”',
  '风停了。三个人谁也没有再说话。',
];
export const TRAVEL_EXAMPLE_BEATS = [
  { paragraph: 0, kind: 'narration', speaker: null, text: '夕阳把天台的栏杆染成橘色。', shot: { type: 'group', focus: [], intent: 'continue', flow: 'auto' }, reason: '交代地点和在场的两个人（小冬还藏着，不在台上）' },
  { paragraph: 0, kind: 'silent', speaker: null, text: '', shot: { type: 'insert', focus: ['cA'], insertTarget: 'hands', intent: 'reveal', flow: 'cut' }, reason: '小夏放下生锈的钥匙，第一次露出的物件' },
  { paragraph: 1, kind: 'dialogue', speaker: 'cA', text: '这是你上次丢的吧。', shot: { type: 'two_shot', focus: ['cA', 'cB'], intent: 'exchange', flow: 'cut' }, reason: '小夏对阿秋说话，两人正在对话' },
  { paragraph: 2, kind: 'silent', speaker: null, text: '', shot: { type: 'cu', focus: ['cB'], intent: 'reaction', flow: 'cut' }, reason: '阿秋愣住，只拍反应' },
  { paragraph: 3, kind: 'dialogue', speaker: 'cB', text: '……不是我的。', shot: { type: 'cu', focus: ['cB'], intent: 'continue', flow: 'auto' }, reason: '同一个人接着说，镜头留在她身上' },
  { paragraph: 4, kind: 'dialogue', speaker: 'cA', text: '那它为什么会在你的书包里？', shot: { type: 'two_shot', focus: ['cA', 'cB'], intent: 'exchange', flow: 'cut' }, reason: '注意交回小夏，回到两人对话' },
  { paragraph: 5, kind: 'silent', speaker: null, text: '', shot: { type: 'mcu', focus: ['cC'], intent: 'reveal', flow: 'cut' }, actors: [{ castId: 'cC', enter: true }], reason: '躲着的小冬第一次出现，所以在这一拍 enter=true' },
  { paragraph: 6, kind: 'dialogue', speaker: 'cC', text: '对不起，我只是想……', shot: { type: 'mcu', focus: ['cC'], intent: 'continue', flow: 'auto' }, reason: '小冬接着说' },
  { paragraph: 7, kind: 'narration', speaker: null, text: '风停了。三个人谁也没有再说话。', shot: { type: 'group', focus: [], intent: 'release', flow: 'auto' }, reason: '场尾拉开，交代三个人的距离' },
];

export const SCENE_TRAVEL_VERSION = 'scene-4+travel-7';
export const SCENE_TRAVEL_SECTION = `# 叙事镜头与运镜（本场景使用「运镜」系统，以下镜头规则优先）
先想清楚：此刻观众该看谁、为什么。程序会按真实机位和叙事规则核对你的意图，写错的标签会被程序改标，所以要写「这一拍实际是什么」，不要写你希望它是什么。

## 镜头怎么选
- 一段连续对话可以一直保持同一个 two_shot 或稳定 ms；换说话人不等于必须换镜。ms 是单人中景，不保证旁人可见。mcu/cu/ecu 只给具体信息、情绪变化或反应；没有可拍的物体时回到稳定中景，不要自动改成特写。不要按比例配额，也不要每隔几句换镜。
- two_shot 的 focus 填「此刻正在对话的两个人」：说话人，加上他正在对着说话、或刚刚回应他的那个人。两个人不必坐在一起，中间站着的人程序会留在画面里。绝不要把还没有入场（还没有 enter）或已经离场（已经 exit）的人放进 focus。找不到对话对象就用 ms。
- type 可用 ${AI_TRAVEL_SHOT_TYPES.join(' / ')}；move 默认 static。不要通过额外 push_in/pull_out 叠加无理由的运动。
- 多人斗嘴时，不要让五个人连续各来一个特写硬切：每隔几拍回到 group 或 ms 重新交代一次谁在跟谁说话；一场戏结束时用 release 拉开成 group 或 two_shot，不要用 cu 推近收场。

## 每个 intent 先问自己一句话
- continue：观众的注意还停在原来的人和构图上吗？✓ 同一个人接着说下去；✗ 换了说话人还标 continue（那是 exchange）。
- exchange：注意从一个人交给另一个人。✓ 甲说完，镜头交给回答的乙；✗ 同一个人情绪升高也标 exchange（那是 emphasis）。
- emphasis：同一个人，此刻有新的情绪或信息，所以更近。✓ 同一个人从平静到说出真话，mcu 推到 cu；✗ 换了说话人就标 emphasis。
- reaction：听者的反应。✓ 听到坦白之后，对方不说话的 cu；✗ 说话人自己在讲话。
- reveal：观众此前没看到的人或物：入场的人、藏着的人、第一次露出的物件。✓ 躲在后面的人第一次探出头；✗ 对一直在场的人标 reveal。
- release：舒缓、拉开交代关系，景别只能更远。✓ 场尾拉成群像；✗ 景别比上一镜更近还标 release。
- rupture：时间或情绪的断裂（回忆切入、爆发、场尾黑场前）。
reason 写这一拍的具体原因，不能只写“需要运镜”。

## 容易出错的地方
- 没有署名的连续对白：先看前一段写了谁在做什么。前一段写某人在笑、在做动作，紧跟着的问句多半是另一个人在问，回答再换回来；不要把一连串对白都算给同一个人。speaker 填真正说话的人，focus 对准他。
- 藏着的人、稍后出现的人：在「观众第一次看到他」的那一拍，给这个人的 actors 项写 enter=true，并用 reveal；在这之前不要把他放进 focus。
- 离场的人：离开的那一拍写 exit=true，之后不再拍他。
- 无声的物件拍（拿起、摊开、放下东西）：用 silent + insert（insertTarget=hands），并且在 reason 里写出物件名，例如「摊开手掌，露出石头」；原文没有可拍的东西就不要用 insert。

## 流向 shot.flow
- flow 只能是 auto / cut / move 三个词之一，不要把 intent 的词写到这里。多数用 auto。move 表示希望从上一镜移到本拍焦点，但仍须符合 intent 的叙事理由、同一背景和安全条件；AI 的 move 不是用户手动指定。cut 只是建议：反应、断裂、或换人进入特写时程序才照单硬切，其他情况由程序按机位和叙事规则决定。
- exchange：同背景相邻焦点可以移到下一位，远距离用切；emphasis：只有实际靠近才推近；release：只有实际拉远才退；reveal：必须有新的可见焦点；reaction/rupture 通常切；continue 稳住。运镜后给观众稳定观看时间，不要连续机械推拉。距离、真实方向、停留时长和手动关键帧由程序检查；不合适时会降级，不能要求无条件连续移到。

## 示范（原创的小片段，只示范镜头写法，不要照抄它的节奏；这里只列出和镜头有关的字段，真正的输出要写全 schema 规定的所有字段）
人物：cA 小夏、cB 阿秋、cC 小冬（开场躲在水箱后，不在台上）。
原文段落：
${TRAVEL_EXAMPLE_PARAGRAPHS.map((t, i) => `${i}. ${t}`).join('\n')}
输出的 beats：
${TRAVEL_EXAMPLE_BEATS.map((b) => JSON.stringify(b)).join('\n')}`;

export interface ScenePrompt {
  system: string;
  schema: ZodType<SceneDirection>;
  schemaName: string;
  promptVersion: string;
}

export function scenePromptFor(system: CameraSystem): ScenePrompt {
  if (system === 'travel') {
    return { system: `${SCENE_SYSTEM}

${SCENE_TRAVEL_SECTION}`, schema: SceneDirectionTravelSchema, schemaName: 'SceneDirectionTravel', promptVersion: SCENE_TRAVEL_VERSION };
  }
  return { system: SCENE_SYSTEM, schema: SceneDirectionSchema, schemaName: 'SceneDirection', promptVersion: SCENE_PROMPT_VERSION };
}

export function sceneInput(i: SceneDirectionInput): Record<string, unknown> {
  return { task: '为这个场景写演出指导。', ...i };
}

export const paragraphsOf = (ps: Paragraph[]) => ps.map((p) => ({ i: p.index, text: p.text }));
