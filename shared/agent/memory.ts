/**
 * The assistant's long-term memory: durable staging preferences of the user ("特写别用这么多", "回忆一律用雾边", "灯说话时镜头别晃").
 * Stored on the server (`data/memories.json`, see server/agent/memoryStore.ts), injected into the assistant's system prompt on every turn
 * and (style kinds only, switchable per generation) into the AI director's scene input. Pure helpers only (schemas, the prompt block, what applies where).
 *
 * Scopes: `global` = every project; `project` = one project (optionally narrowed to one character of it with `castId`).
 * Precedence: the current instruction > project memory > global memory.
 */
import { z } from 'zod';

export const MEMORY_SCOPES = ['global', 'project'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MEMORY_TEXT_MAX = 300;
/**
 * What a memory is about. The style kinds (camera / fx / blocking / pacing) also steer the AI director's scene generation; `other`
 * (habits about the assistant itself, edit-specific requests such as 「别改第3场」) only goes to the assistant. Deterministic filter.
 */
export const MEMORY_KINDS = ['camera', 'fx', 'blocking', 'pacing', 'other'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const DIRECTOR_KINDS: readonly MemoryKind[] = ['camera', 'fx', 'blocking', 'pacing'];
export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = { camera: '镜头', fx: '特效', blocking: '站位表演', pacing: '节奏', other: '其他' };
/** Safety ceiling of the whole store (a memory is one short sentence; this is far beyond any real use). */
export const MEMORY_MAX = 500;

export const MemorySchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().trim().min(1).max(MEMORY_TEXT_MAX),
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS).default('other'),
  /** Required for `project` scope. */
  projectId: z.string().min(1).optional(),
  /** Only with `project` scope: the preference is about this character. */
  castId: z.string().min(1).optional(),
  /** The character's name when it was saved (display only). */
  castName: z.string().max(40).optional(),
  enabled: z.boolean().default(true),
  /** stated = the user said it and the assistant saved it; confirmed = the assistant proposed it and the user accepted; manual = typed in the manager. */
  origin: z.enum(['stated', 'confirmed', 'manual']).default('manual'),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).refine((m) => m.scope === 'global' ? !m.projectId && !m.castId : !!m.projectId, { message: 'project 范围的记忆需要 projectId；global 范围不能带 projectId / castId' });
export type Memory = z.infer<typeof MemorySchema>;

export const MemoryFileSchema = z.object({
  version: z.literal(1),
  /** The global switch of the (experimental) memory system: off = no memory tools, no prompt block, no director preferences. */
  enabled: z.boolean().default(true),
  memories: z.array(MemorySchema).max(MEMORY_MAX),
});
export type MemoryFile = z.infer<typeof MemoryFileSchema>;
export const emptyMemoryFile = (): MemoryFile => ({ version: 1, enabled: true, memories: [] });

/** What the manager / the chat card sends to create one. */
export const MemoryInputSchema = z.object({
  text: z.string().trim().min(1).max(MEMORY_TEXT_MAX),
  scope: z.enum(MEMORY_SCOPES),
  kind: z.enum(MEMORY_KINDS).optional(),
  projectId: z.string().min(1).optional(),
  castId: z.string().min(1).optional(),
  castName: z.string().max(40).optional(),
  enabled: z.boolean().optional(),
  origin: z.enum(['stated', 'confirmed', 'manual']).optional(),
});
export type MemoryInput = z.infer<typeof MemoryInputSchema>;
export const MemoryPatchSchema = z.object({
  text: z.string().trim().min(1).max(MEMORY_TEXT_MAX).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  projectId: z.string().min(1).optional(),
  castId: z.string().min(1).nullable().optional(),
  castName: z.string().max(40).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;

/** What the assistant did with memory in one turn (shown as memory cards in the chat). */
export type MemoryEvent =
  | { action: 'saved' | 'updated' | 'forgotten'; memory: Memory }
  | { action: 'proposed'; proposal: MemoryProposal };
export interface MemoryProposal {
  text: string;
  scope: MemoryScope;
  kind: MemoryKind;
  castId?: string | undefined;
  castName?: string | undefined;
  /** Why the assistant thinks this is a lasting preference (the correction it saw). */
  why?: string | undefined;
  /** An existing memory this one would replace. */
  replaces?: string | undefined;
}

/** The memories that apply in a project (enabled ones: global + this project's), project memories first. */
export function activeMemories(all: readonly Memory[], projectId: string | null | undefined): Memory[] {
  const on = all.filter((m) => m.enabled && (m.scope === 'global' || (projectId && m.projectId === projectId)));
  return [...on.filter((m) => m.scope === 'project'), ...on.filter((m) => m.scope === 'global')];
}

/** Every memory visible from a project (also the switched-off ones), for the manager and `list_memories`. */
export function visibleMemories(all: readonly Memory[], projectId: string | null | undefined): Memory[] {
  return all.filter((m) => m.scope === 'global' || (projectId && m.projectId === projectId));
}

const castLabel = (m: Pick<Memory, 'castId' | 'castName'>) => (m.castId ? `只针对 ${m.castName ?? m.castId}（${m.castId}）` : '');
export const memoryLine = (m: Memory): string => `- [${m.id}]（${MEMORY_KIND_LABEL[m.kind]}）${m.text}${m.castId ? `（${castLabel(m)}）` : ''}`;

/**
 * The block appended to the assistant's system prompt (after the stable rules, so their cache prefix stays). Complete: every active memory
 * goes in, with its id (for `forget` / `remember.replaces`). Empty string when there are none.
 */
export function memoryPromptBlock(active: readonly Memory[]): string {
  if (active.length === 0) return '';
  const proj = active.filter((m) => m.scope === 'project');
  const glob = active.filter((m) => m.scope === 'global');
  return [
    '# 用户的长期偏好（记忆，跨对话保存）',
    '下面是用户以前让你记住的偏好。做任何相关的编辑时都要遵守（例如偏好说「回忆一律用雾边」，加回忆特效就带 edge=fog；偏好说「少用特写」，推近时优先 mcu 而不是 cu/ecu），并在总结里用半句话说明「按你的偏好…」。',
    '优先级：用户这一轮的明确指令 > 本项目记忆 > 全局记忆。这一轮指令和记忆冲突时照指令做，不要因为记忆拒绝或反问；只有当用户说「以后都这样 / 记住」时才更新记忆。',
    '和当前指令无关的记忆不要拿来改项目（记忆不是待办事项，不要主动按记忆去改用户没提的内容）。',
    ...(proj.length ? ['## 本项目', ...proj.map(memoryLine)] : []),
    ...(glob.length ? ['## 全局（所有项目）', ...glob.map(memoryLine)] : []),
  ].join('\n');
}

/** The memories the AI director may read: active ones of a style kind (camera / fx / blocking / pacing), project ones first. */
export function directorMemories(all: readonly Memory[], projectId: string | null | undefined): Memory[] {
  return activeMemories(all, projectId).filter((m) => DIRECTOR_KINDS.includes(m.kind));
}

export const DIRECTOR_PREFERENCE_NOTE = '这是用户长期保存的演出风格倾向（【本项目】优先于【全局】）。它们只是倾向：永远不能违反上面的导演规则，也不能让演出变得不合理；和故事、规则冲突时，以合理性为准（例如偏好「少用特写」，但这一句是全场情绪顶点，仍然可以用特写）。只在合适的地方体现，不要为了满足偏好硬改每一句。';

/** Preference lines for the AI director's scene input (null = none, so the request and its cache key stay exactly as without memory). */
export function directorPreferences(memories: readonly Memory[]): { note: string; items: string[] } | null {
  const use = memories.filter((m) => m.enabled && DIRECTOR_KINDS.includes(m.kind));
  if (use.length === 0) return null;
  return {
    note: DIRECTOR_PREFERENCE_NOTE,
    items: use.map((m) => `${m.scope === 'project' ? '【本项目】' : '【全局】'}（${MEMORY_KIND_LABEL[m.kind]}）${m.text}${m.castId ? `（${castLabel(m)}）` : ''}`),
  };
}

/** The instruction behind 「按偏好检查本场」 (experimental): an ordinary assistant turn, so every fix is a normal change card. */
export const memoryReviewInstruction = (sceneNo: number): string =>
  `按我保存的长期偏好（记忆）检查第${sceneNo}场：逐句对照每一条和镜头、特效、站位表演、节奏有关的偏好。每一句都按「这条偏好想要什么」加「改了之后故事上是否合理」来判断，不要因为这句是情绪顶点或别的类型就默认跳过：偏好要的东西，有时恰恰就适用在情绪顶点上。只修正违反偏好、而且改了之后合理的地方，每处在理由里写违反了哪条偏好；已经符合偏好、或者改了会明显损害这一句表达的，保持原样；也不要为了满足偏好把所有句子都改掉。不要新增或修改记忆。最后说明查了哪几条偏好、改了几处。`;


// ---- deterministic detection of a stated long-term preference (safety net for the assistant loop) -------------------------

/** Names a line / scene / selection: an edit of something specific, never a general preference. */
const TARGETED = /这[一]?(句|场|段|里|幕|个镜头|条)|本场|当前|选中|刚才|上一句|下一句|上面|下面|第\s*[0-9一二三四五六七八九十百]+\s*(句|场|段|幕)|[a-z]+_\d+b_\d+/;
/** Wording of a general style statement ("don't always…", "use fewer…", "follow the original"). */
const GENERAL_STYLE = /不要一直|别一直|不要总|别总|不要老|别老|不要连续|别连续|不要太多|别太多|不要这么多|别这么多|少用|多用|适当|参考原作|参考原著|一般(不|要|用|情况|来说)|通常|尽量|不要过多|别过多|避免(一直|总是|连续)/;
/** Withdrawing / cancelling an existing preference (forget, not remember). */
const WITHDRAW = /别管|不用管|不管了|算了|取消|忘掉|忘记|不用了|不要再|不用再|删掉|删除|去掉那条/;

/**
 * Conservative check: does the user's message state a general, long-term style preference (no specific target, general wording, not a
 * withdrawal)? Used to nudge the assistant to call `remember` when it forgot. False for ordinary edits like 「这句用特写」.
 */
export function looksLikeGeneralPreference(message: string): boolean {
  const m = message.replace(/^[\s\S]*用户的指令：/, '').trim();
  if (!m || m.length > 120 || /[?？]/.test(m)) return false;
  if (TARGETED.test(m) || WITHDRAW.test(m)) return false;
  return GENERAL_STYLE.test(m);
}

/** A memory text that only says "don't care / go with the flow": that is a withdrawal, which must be `forget`, not a memory. */
export function isDontCareMemory(text: string): boolean {
  const t = text.replace(/[\s，。,.；;！!]/g, '');
  if (!/(别管|不用管|不必管|不用考虑|不必考虑|不要管|随意|随便|顺其自然|不做要求|没有要求|无所谓|不限制|不强求|自由发挥|交给(导演|AI|你)|由.{0,6}(自行|自己)决定)/.test(t)) return false;
  // a real rule also carries a direction (use / avoid / at most …): then it is not a pure "don't care"
  return !/(用|使用|少|多|最多|最少|避免|禁止|必须|一律|不要|别(用|总|一直))/.test(t.replace(/不要管|别管|不用管|不必管/g, ''));
}
