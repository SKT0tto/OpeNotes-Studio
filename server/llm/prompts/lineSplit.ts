/** The second, small call of a scene: cut the lines that do not fit the dialogue area into consecutive lines of the same speaker. */
import { LineSplitSchema } from '../../../shared/schema/ai';
import { EMOTIONS } from '../../../shared/director/vocab';

export const SPLIT_PROMPT_VERSION = 'split-1';
export const SPLIT_SCHEMA_NAME = 'LineSplit';
export { LineSplitSchema };

export const SPLIT_SYSTEM = `你是 BanG Dream! 同人动画的「台词分镜」助手。游戏的对话框最多显示 box.maxLines 行，下面这些台词放不下，需要拆成同一个人连续说的几句。只输出 JSON。

# 你决定的是：在哪里断、为什么断
- 断在意思和情绪自然停顿的地方：一口气说完的一层意思结束时；情绪转折处（逞强→泄气、生气→心软、兴奋→担心）；停顿和犹豫（「……」「——」之后）；话题转换（「不过」「可是」「所以」「对了」「总之」开头的那一句通常另起）；揭示之前（说出真话、坦白、关键信息之前停一下）。
- 不要断在一个短语、一个词组或一对引号「」『』的中间；不要把一句问话和它的问号拆开；不要拆出只有两三个字、单独读起来没有意思的碎片（「……」这样的停顿除外）。
- 没有转折的长说明（交代、列举），就在句号处拆成差不多长的几段。
- 段数在 minPieces 到 maxPieces 之间。能少拆就少拆；只有在真的有一次情绪转折时，才用到 maxPieces。

# 文字必须一字不差
- 把每一段的 text 按顺序拼起来，必须与原文 text 完全相同：不增字、不删字、不改标点、不重复。只有切点处的空格可以去掉。
- 原文整句被括号或引号包住（wrapped 给出那一对符号）时，每一段都要各自用同一对符号包住，例如 （先说的这半句……）（后面这半句。）。
- 每段不能超过 box.maxLines 行（一行约 box.charsPerLine 个汉字，字数只是参考）；程序会逐段测量，超出的会退回给你重做。

# 每一段的表演（第一段沿用原来的表演，只写 text、why、emotion）
- emotion：这一段的情绪，只能取 ${EMOTIONS.join(' / ')}。情绪变了就写新的，没变就照抄。
- actor：说话人在这一段的表演。motion、expression 只能原样取自 cast 里该角色的 motions、expressions 清单，没有合适的就填 null；attention 填此刻看向谁（在场角色的 castId 或 camera / away / down，不特别时填 null）。情绪真的变了才换表情或动作（例：说到「……不过」时低下头、换成苦笑）；没有变化时 actor 填 null。
- camera：
  - hold（默认）：镜头留在原来的人和构图上。同一个人接着说时几乎都用它。
  - closer：同一个人情绪升高、说出真话或快哭出来的那一段，收近一档。
  - reaction：这一段的话让听者受到冲击（揭示、坦白），观众需要看到听者的反应；reactionOf 填听者的 castId（必须在 onStage 里）。很少用：大多数长句一次都不用。
  - 每句台词最多一段不是 hold。不是 hold 时，why 必须写出具体的故事理由。
- why：不超过 20 字，写这个切点为什么在这里（例如「逞强说完，转为泄气」「停顿后说出真心话」）。

# 示范（原创的小片段，只示范写法）
cast：cA 小夏（表情 exp_smile01 / exp_bsmile01 / exp_sad01 / exp_serious01；动作 smile01 / nod01 / sad01 / serious01），cB 阿秋。
lines：
{"id":"L1","kind":"dialogue","speaker":"cA","emotion":"happy","text":"我跟你说，这次的合宿我已经全部安排好了！民宿、电车票、练习的时间表，连每天晚上吃什么都写好了！……不过，钱的事我还没跟大家商量。","measuredLines":3,"minPieces":2,"maxPieces":3,"wrapped":null,"shot":{"type":"mcu","focus":["cA"]},"onStage":["cA","cB"]}
{"id":"L2","kind":"dialogue","speaker":"cA","emotion":"sad","text":"（她说「没事的」的时候，声音一直在抖。我明明听出来了，却什么都没有问……要是那时候我再多说一句就好了。明明我们是最好的朋友，我真没用。）","measuredLines":3,"minPieces":2,"maxPieces":3,"wrapped":"（）","shot":{"type":"cu","focus":["cA"]},"onStage":["cA","cB"]}
输出：
{"lines":[
 {"id":"L1","pieces":[
  {"text":"我跟你说，这次的合宿我已经全部安排好了！民宿、电车票、练习的时间表，连每天晚上吃什么都写好了！","why":"得意地宣布安排","emotion":"happy","camera":"hold","reactionOf":null,"actor":null},
  {"text":"……不过，钱的事我还没跟大家商量。","why":"得意说完，心虚地坦白","emotion":"shy","camera":"hold","reactionOf":null,"actor":{"motion":"sad01","expression":"exp_bsmile01","attention":"down"}}]},
 {"id":"L2","pieces":[
  {"text":"（她说「没事的」的时候，声音一直在抖。我明明听出来了，却什么都没有问……）","why":"回想细节，停顿","emotion":"sad","camera":"hold","reactionOf":null,"actor":null},
  {"text":"（要是那时候我再多说一句就好了。明明我们是最好的朋友，我真没用。）","why":"停顿后转为自责","emotion":"sad","camera":"closer","reactionOf":null,"actor":{"motion":null,"expression":"exp_sad01","attention":"down"}}]}
]}

# 输出
严格输出符合 JSON Schema 的一个 JSON 对象；lines 里每个 id 回答一次。`;

/** One line to cut, with what the model needs to choose the cuts (everything else about the scene stays out of it). */
export interface SplitLineInput {
  id: string;
  kind: string;
  speaker: string | null;
  emotion: string;
  text: string;
  measuredLines: number;
  minPieces: number;
  maxPieces: number;
  /** The pair that encloses the whole line (`（）` `「」`), or null. */
  wrapped: string | null;
  shot: { type: string; focus: string[] };
  onStage: string[];
  before: Array<{ speaker: string | null; text: string }>;
  after: Array<{ speaker: string | null; text: string }>;
}

export interface SplitInput {
  box: { maxLines: number; charsPerLine: number; note: string };
  scene: { title: string; mood: string; cameraSystem: 'classic' | 'travel' };
  /** Only the people these lines involve: the speakers and those on stage. */
  cast: Array<{ castId: string; name: string; expressions: string[]; motions: string[] }>;
  lines: SplitLineInput[];
}

export function splitRequestInput(i: SplitInput): Record<string, unknown> {
  return { task: '把这些放不下的台词按语义和情绪拆成同一个人的连续几句。', ...i };
}

/** The follow-up input for the one retry: only the lines that failed, what the model said about them and exactly what is wrong. */
export function splitRepairInput(original: SplitInput, failing: string[], previous: unknown, problems: string[]): Record<string, unknown> {
  const ids = new Set(failing);
  return {
    task: '你上一次的拆分有问题，请只重做下面这些台词，修正后重新输出完整 JSON（lines 里只含这些 id）。',
    originalInput: splitRequestInput({ ...original, lines: original.lines.filter((l) => ids.has(l.id)) }),
    previousOutput: JSON.stringify(previous).slice(0, 14000),
    problems: problems.slice(0, 30),
  };
}
