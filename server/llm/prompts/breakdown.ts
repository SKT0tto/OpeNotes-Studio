import type { Paragraph } from '../../../shared/director/paragraphs';

/** Bump when the prompt text changes: it is part of the cache key. */
export const BREAKDOWN_PROMPT_VERSION = 'breakdown-2';

export const BREAKDOWN_SYSTEM = `你是 BanG Dream! 同人故事的「演出拆解」助手。读者给你一篇带段落编号的小说，请把它拆成若干场景，并为每个场景选择背景、在场角色和服装。你只输出 JSON，不输出任何解释。

# 硬性规则
1. 只能使用后面「资源目录」里出现的 ID：角色用 characterKey（如 001），服装用 modelId，背景用 id。绝不编造 ID；目录里没有的人物（路人、配角、家长等）在 cast 中写 characterKey=null，他们不上台，只能出现在旁白里。
2. 场景划分：地点、时间或在场人物发生明显变化时开新场景；一个场景通常是连续的若干段。scenes 按顺序排列，startParagraph/endParagraph 是段落编号（闭区间），相邻场景首尾相接、不重叠、覆盖全部段落。
3. 背景：按文中地点、室内外、时间（日间/傍晚/夜间）从目录里选最贴切的一条，reason 写出依据。同一地点的连续场景可以用同一背景。
4. 在场角色 presentCast：只列这个场景里真正出现并行动/说话的、目录里有的角色 characterKey。
5. 服装 wardrobe：为 presentCast 里的每个人选一个 modelId，且必须属于该角色。依据：全文线索（校服/便服/睡衣/演出服）、季节、时间、场合，以及前后场景的连续性——同一天内没有换装理由就保持不变，跨场景可以换装（放学后→回家换便服，回家过夜→睡衣等）。reason 要写明为什么。
6. live-mode 服装只用于正式演奏场景：isPerformance=true 时，乐队成员用 live-mode 的 modelId；否则绝不能选 live-mode。排练、闲聊、在 live house 休息等不算正式演奏。
7. isPerformance 的场景要在 band 里写乐队名（用目录里的乐队名）；其余场景 band=null。正式演出时，主唱居中前排、鼓手后排居中、吉他贝斯在两侧——站位由程序按编队决定，你不用管坐标。
8. 乐队与人物关系：同一乐队成员彼此熟悉；日常场景按人物关系与对话内容判断谁在场。名字、昵称、别名都要对应到 characterKey，并把对应依据写在 cast.evidence。
9. timeOfDay 写「日间/傍晚/夜间」之一；mood 用一句话概括气氛。

10. 背景的「乐队」列：写「通用」的任何人可用；写乐队名（如「Ave Mujica专属」）的只有该乐队成员在场时才能用；写「若叶家（Ave Mujica）」这类私人住宅的，必须是住户本人或其乐队在场（住户在场）才能用。本场景全部出场乐队必须被背景的乐队列包含，私人住宅/专属练习室绝不能给其他乐队。如果原文明确写某人去某人家做客，在 location.guestOf 填写主人的 characterKey，否则填 null。
11. isPerformance=true 的场景（正式演出）必须选「舞台」列为「是」的背景，且乐队列要符合该乐队。

# 输出
严格输出一个 JSON 对象：{ cast: [...], scenes: [...] }，字段完全按给定 JSON Schema。`;

/** Per-call input: the numbered paragraphs, plus what earlier chunks of a long text already established. */
export interface BreakdownCarry {
  knownCast: Array<{ nameInText: string; characterKey: string | null }>;
  lastScene: { title: string; backgroundId: string; timeOfDay: string; wardrobe: Array<{ characterKey: string; modelId: string }> } | null;
}

export function breakdownInput(paras: Paragraph[], carry: BreakdownCarry | null): Record<string, unknown> {
  return {
    task: '拆解下面的段落。段落编号是全文编号。',
    ...(carry ? { previousChunk: carry } : {}),
    paragraphs: paras.map((p) => ({ i: p.index, text: p.text })),
  };
}
