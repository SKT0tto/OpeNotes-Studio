/**
 * Beat query: a STRUCTURED filter (never free code) over the whole project, read-only. It backs the `query_beats` tool, the `batch_edit`
 * target ("every beat the filter matches") and the `query()` helper inside the sandboxed scripts, so all three mean exactly the same thing.
 *
 * A filter node is a set of optional conditions that must ALL hold, plus the combinators `and` / `or` / `not` (nested, three levels deep:
 * the JSON schema the model sees stays non-recursive). Unknown keys are an error, so a mistyped condition cannot silently match everything.
 */
import { z } from 'zod';
import { cameraSystemOf, type Beat, type Project } from '../schema/project';
import { resolveStyle } from '../style/ournotes';
import { scenePresence } from '../timeline/presence';
import { sceneTimes } from '../timeline/time';
import { fxValues, type FxValue } from './apply';
import { PUNCT, clip, lcs, nameOf } from './compact';

const strs = z.union([z.string(), z.array(z.string()).max(40)]);
const num = z.number();

const LeafShape = {
  scenes: z.array(z.union([z.string(), z.number().int()])).max(60).optional().describe('场景 id 或第几场（从 1 起的数字）；省略 = 所有场景'),
  beatFrom: z.number().int().min(1).optional().describe('每个场景里从第几句起（含，从 1 起）'),
  beatTo: z.number().int().min(1).optional().describe('每个场景里到第几句止（含）'),
  ranges: z.array(z.object({ scene: z.union([z.string(), z.number().int()]), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }).strict()).max(40).optional().describe('分场景的句号范围（任一范围命中即可），例如 [{scene:2,from:3,to:9}]'),
  beatIds: z.array(z.string()).max(400).optional(),
  speaker: strs.optional().describe('说话人：名字或 castId；"none" = 没有说话人'),
  cast: strs.optional().describe('涉及的人：说话人 / 同时说话人 / 镜头焦点里有他'),
  kind: strs.optional().describe('类型：dialogue(对白/台词)|narration(旁白)|action|pause|silent(无台词的反应镜头)|empty|establishing'),
  text: z.string().max(200).optional().describe('台词包含这段文字（忽略标点和空白）'),
  textRegex: z.string().max(120).optional().describe('台词匹配这个正则'),
  textFuzzy: z.string().max(200).optional().describe('台词模糊匹配（引文记不准时用：包含其中 ≥70% 的字且顺序一致）'),
  charsMin: num.optional().describe('台词字数 ≥'),
  charsMax: num.optional().describe('台词字数 ≤'),
  emotion: strs.optional().describe('情绪词；"none" = 没有标情绪'),
  shotType: strs.optional().describe('景别：group|two_shot|ms|mcu|cu|ecu|insert|establishing'),
  intent: strs.optional().describe('运镜意图（travel）；"none" = 没有'),
  flow: strs.optional().describe('换镜方式：auto|cut|move|glide'),
  move: strs.optional().describe('运镜：static|push_in|pull_out|pan|track|shake'),
  focusIncludes: strs.optional().describe('镜头焦点里有这个人（名字或 castId）'),
  fx: strs.optional().describe('这一句生效的特效：vignette_anxiety|memory|dim|flash|shake|daze|dutch…；"none" = 没有特效，"any" = 有任何特效'),
  fxTone: strs.optional().describe('memory 的色调 cool|warm|sepia|mono'),
  fxEdge: strs.optional().describe('memory 的白边 fog|bands|both|none'),
  fxVariant: strs.optional().describe('daze 的变体 blink'),
  fxStrengthMin: num.optional(),
  fxStrengthMax: num.optional(),
  background: strs.optional().describe('这一句用的背景 assetId'),
  bgSwitch: z.boolean().optional().describe('这一句上是否发生背景切换'),
  visible: strs.optional().describe('画面上真的看得见这些人（编译后的在场情况，全部都在才算）'),
  hidden: strs.optional().describe('画面上看不见这些人（任何一个看不见即算）'),
  visibleMin: num.optional().describe('画面上的人数 ≥'),
  visibleMax: num.optional().describe('画面上的人数 ≤'),
  lineGapMin: num.optional().describe('句后停顿（秒）≥'),
  lineGapMax: num.optional().describe('句后停顿（秒）≤'),
  tailMin: num.optional().describe('句尾停留（秒）≥'),
  tailMax: num.optional().describe('句尾停留（秒）≤'),
  secondsMin: num.optional().describe('这一句总时长（秒）≥'),
  secondsMax: num.optional().describe('这一句总时长（秒）≤'),
  locked: z.boolean().optional().describe('任何一项（句 / 镜头 / 节奏）被锁'),
  userEdited: z.boolean().optional().describe('任何一项（句 / 镜头 / 节奏）是用户手改过的'),
};

const leaf = z.object(LeafShape).strict();
const level1 = leaf.extend({ and: z.array(leaf).max(12).optional(), or: z.array(leaf).max(12).optional(), not: leaf.optional() }).strict();
const level2 = leaf.extend({ and: z.array(level1).max(12).optional(), or: z.array(level1).max(12).optional(), not: level1.optional() }).strict();
/** The filter the model writes (three combinator levels). */
export const BeatFilterSchema = leaf.extend({ and: z.array(level2).max(12).optional(), or: z.array(level2).max(12).optional(), not: level2.optional() }).strict();

/**
 * What the model is SHOWN (its JSON schema): the conditions once, and `and` / `or` / `not` as plain nested objects written the same way.
 * Spelling the three nesting levels out in the schema would repeat every condition about thirty times (150 KB of tool definition);
 * validation still uses the strict nested `BeatFilterSchema`.
 */
export const ModelFilterSchema = leaf.extend({
  and: z.array(z.record(z.string(), z.unknown())).optional().describe('全部满足：条件对象数组，每个对象的写法和本对象一样'),
  or: z.array(z.record(z.string(), z.unknown())).optional().describe('满足任一：条件对象数组'),
  not: z.record(z.string(), z.unknown()).optional().describe('不满足这个条件对象'),
}).strict();

export type BeatFilter = z.infer<typeof leaf> & { and?: BeatFilter[] | undefined; or?: BeatFilter[] | undefined; not?: BeatFilter | undefined };

export interface BeatRef {
  sceneId: string;
  sceneNo: number;
  beatId: string;
  beatNo: number;
}

/** One beat as the filter (and the scripts) see it: everything the conditions talk about, already resolved. */
export interface BeatRow extends BeatRef {
  kind: Beat['kind'];
  speakerId: string | null;
  speaker: string;
  coSpeakers: string[];
  text: string;
  chars: number;
  emotion: string | null;
  shotType: string;
  focus: string[];
  move: string;
  intent: string | null;
  flow: 'auto' | 'cut' | 'move' | 'glide';
  dof: number | null;
  fx: string;
  fxValue: FxValue | null;
  background: string;
  bgSwitch: boolean;
  /** Cast the viewer really sees (compiled presence), and the scene's cast that is not seen. */
  visible: string[];
  hidden: string[];
  lineGap: number;
  tail: number;
  seconds: number;
  locked: boolean;
  userEdited: boolean;
}

/** Derived data of the project, built once per query batch. */
export interface QueryIndex {
  project: Project;
  rows: BeatRow[];
  byBeat: Map<string, BeatRow>;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function buildIndex(project: Project): QueryIndex {
  const times = sceneTimes(project);
  const rows: BeatRow[] = [];
  project.scenes.forEach((scene, si) => {
    const pres = scenePresence(project, scene.id);
    const fx = fxValues(scene);
    const tmap = new Map(times[si]!.beats.map((b) => [b.beatId, b]));
    const order = new Map(scene.beats.map((b, i) => [b.id, i]));
    const bgKeys = scene.tracks.filter((t) => t.channel === 'background').flatMap((t) => t.keys as Array<{ at: { beatId: string; offset: number }; value: { assetId: string } }>)
      .filter((k) => order.has(k.at.beatId)).sort((a, b) => (order.get(a.at.beatId)! - order.get(b.at.beatId)!) || a.at.offset - b.at.offset);
    const cast = Object.keys(scene.wardrobe);
    const cam = cameraSystemOf(project, scene);
    scene.beats.forEach((b, i) => {
      const style = resolveStyle(project.style, scene.style, b.style).values.rhythm;
      const bt = tmap.get(b.id);
      const visible = pres[i]?.visible ?? [];
      const bg = [...bgKeys].reverse().find((k) => order.get(k.at.beatId)! <= i)?.value.assetId ?? scene.background.assetId;
      const f = fx[i] ?? null;
      rows.push({
        sceneId: scene.id, sceneNo: si + 1, beatId: b.id, beatNo: i + 1,
        kind: b.kind, speakerId: b.speakerId ?? null, speaker: nameOf(project, b.speakerId), coSpeakers: b.coSpeakers,
        text: b.text, chars: [...b.text].length, emotion: b.emotion ?? null,
        shotType: b.shot.type, focus: b.shot.focus, move: b.shot.move, intent: cam === 'travel' ? b.shot.intent ?? null : null,
        flow: b.shot.transition === 'cut' ? 'cut' : b.shot.transition === 'travel' ? 'move' : b.shot.transition === 'glide' ? 'glide' : 'auto',
        dof: b.shot.dof ?? null, fx: f ? f.fx : 'none', fxValue: f,
        background: bg, bgSwitch: bgKeys.some((k) => k.at.beatId === b.id),
        visible, hidden: cast.filter((c) => !visible.includes(c)),
        lineGap: r2(style.lineGap), tail: r2(style.tail), seconds: bt ? r2(bt.end - bt.start) : 0,
        locked: !!(b.meta.locked || b.meta.lockedFields?.length || b.shot.meta.locked || b.shot.meta.lockedFields?.length || b.style.meta.locked),
        userEdited: b.meta.source === 'user' || b.shot.meta.source === 'user' || b.style.meta.source === 'user',
      });
    });
  });
  return { project, rows, byBeat: new Map(rows.map((r) => [r.beatId, r])) };
}

const arr = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/**
 * Why a model-written regex is refused, or null. The regex runs on the host (V8's backtracking engine cannot be interrupted, and one
 * catastrophic pattern would freeze the whole server), so only shapes whose worst case stays polynomial and small are allowed: no repeated
 * group (`(a|aa)+`, `(.|.)*`: exponential), no back-reference, and at most two unbounded repeats (`*` `+` `{n,}` `{n,m}` with m > 12;
 * each one multiplies the worst case by the length of the line).
 */
export function regexProblem(src: string): string | null {
  let unbounded = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') {
      const nx = src[i + 1] ?? '';
      if (/[1-9]/.test(nx) || nx === 'k') return '不支持反向引用';
      i++;
      continue;
    }
    if (ch === '[') { // a character class: nothing inside it repeats
      i++;
      while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; }
      continue;
    }
    let isRepeat = false;
    let isUnbounded = false;
    if (ch === '*' || ch === '+') { isRepeat = true; isUnbounded = true; }
    else if (ch === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (m) { isRepeat = true; isUnbounded = m[2] !== undefined && (m[3] === '' || Number(m[3]) > 12); }
    }
    if (!isRepeat) continue;
    if (src[i - 1] === ')') return '不支持给括号整体加重复（如 (…)+、(…)*、(…){2,}），请拆成几个条件或用 or';
    if (isUnbounded) unbounded++;
  }
  return unbounded > 2 ? '「* + {n,}」这类重复最多两处' : null;
}

interface Ctx {
  idx: QueryIndex;
  problems: Set<string>;
  castCache: Map<string, Set<string>>;
}

/** Cast ids a name (id, display name, part of the name, nickname-ish last two characters) stands for. */
function castIds(c: Ctx, name: string): Set<string> {
  const hit = c.castCache.get(name);
  if (hit) return hit;
  const sp = name.trim();
  const ids = new Set(c.idx.project.cast.filter((x) => x.id === sp || x.displayName === sp || (sp.length >= 1 && x.displayName.includes(sp)) || (sp.length >= 2 && sp.includes(x.displayName.slice(-2)))).map((x) => x.id));
  if (ids.size === 0) c.problems.add(`找不到角色「${name}」（角色表：${c.idx.project.cast.map((x) => `${x.id}=${x.displayName}`).join('，')}）`);
  c.castCache.set(name, ids);
  return ids;
}

function sceneIdsOf(c: Ctx, key: string | number): string[] {
  const ss = c.idx.project.scenes;
  if (typeof key === 'number') {
    if (ss[key - 1]) return [ss[key - 1]!.id];
    c.problems.add(`找不到第 ${key} 场（共 ${ss.length} 场）`);
    return [];
  }
  const byId = ss.find((s) => s.id === key);
  if (byId) return [byId.id];
  const n = /^\D*(\d+)\D*$/.exec(key.trim());
  if (n && ss[Number(n[1]) - 1]) return [ss[Number(n[1]) - 1]!.id];
  c.problems.add(`找不到场景 ${key}（可用：${ss.map((s, i) => `#${i + 1}=${s.id}`).join('，')}）`);
  return [];
}

function leafMatch(c: Ctx, f: BeatFilter, r: BeatRow): boolean {
  if (f.scenes) {
    const ids = new Set(f.scenes.flatMap((k) => sceneIdsOf(c, k)));
    if (!ids.has(r.sceneId)) return false;
  }
  if (f.beatFrom !== undefined && r.beatNo < f.beatFrom) return false;
  if (f.beatTo !== undefined && r.beatNo > f.beatTo) return false;
  if (f.ranges && !f.ranges.some((g) => sceneIdsOf(c, g.scene).includes(r.sceneId) && r.beatNo >= (g.from ?? 1) && r.beatNo <= (g.to ?? Infinity))) return false;
  if (f.beatIds && !f.beatIds.includes(r.beatId)) return false;
  if (f.speaker !== undefined) {
    const want = arr(f.speaker);
    if (!want.some((w) => (w === 'none' ? r.speakerId === null : !!r.speakerId && castIds(c, w).has(r.speakerId)))) return false;
  }
  if (f.cast !== undefined) {
    const involved = new Set([...(r.speakerId ? [r.speakerId] : []), ...r.coSpeakers, ...r.focus]);
    if (!arr(f.cast).some((w) => [...castIds(c, w)].some((id) => involved.has(id)))) return false;
  }
  if (f.kind !== undefined && !arr(f.kind).includes(r.kind)) return false;
  const plain = r.text.replace(PUNCT, '');
  // punctuation and spaces are ignored on both sides; a needle that is ONLY punctuation ("……") is matched as written
  if (f.text !== undefined) {
    const needle = f.text.replace(PUNCT, '');
    if (needle === '' ? !r.text.includes(f.text) : !plain.includes(needle)) return false;
  }
  if (f.textRegex !== undefined) {
    const why = regexProblem(f.textRegex);
    if (why) { c.problems.add(`正则太复杂：${why}；请换简单写法（多数需求用 text / textFuzzy / charsMin 就够）`); return false; }
    let re: RegExp;
    try { re = new RegExp(f.textRegex, 'u'); } catch (e) { c.problems.add(`正则写错了：${(e as Error).message}`); return false; }
    if (!re.test(r.text)) return false;
  }
  if (f.textFuzzy !== undefined) {
    const needle = f.textFuzzy.replace(PUNCT, '');
    if (needle === '') { if (!r.text.includes(f.textFuzzy)) return false; }
    else if (needle.length >= 2 && !plain.includes(needle) && lcs([...needle], [...plain]) / [...needle].length < 0.7) return false;
    else if (needle.length < 2 && !plain.includes(needle)) return false;
  }
  if (f.charsMin !== undefined && r.chars < f.charsMin) return false;
  if (f.charsMax !== undefined && r.chars > f.charsMax) return false;
  if (f.emotion !== undefined && !arr(f.emotion).some((e) => (e === 'none' ? r.emotion === null : r.emotion === e))) return false;
  if (f.shotType !== undefined && !arr(f.shotType).includes(r.shotType)) return false;
  if (f.intent !== undefined && !arr(f.intent).some((e) => (e === 'none' ? r.intent === null : r.intent === e))) return false;
  if (f.flow !== undefined && !arr(f.flow).includes(r.flow)) return false;
  if (f.move !== undefined && !arr(f.move).includes(r.move)) return false;
  if (f.focusIncludes !== undefined && !arr(f.focusIncludes).some((w) => [...castIds(c, w)].some((id) => r.focus.includes(id)))) return false;
  if (f.fx !== undefined && !arr(f.fx).some((x) => (x === 'any' ? r.fx !== 'none' : r.fx === x))) return false;
  if (f.fxTone !== undefined && !(r.fxValue?.tone && arr(f.fxTone).includes(r.fxValue.tone))) return false;
  if (f.fxEdge !== undefined && !(r.fxValue?.edge && arr(f.fxEdge).includes(r.fxValue.edge))) return false;
  if (f.fxVariant !== undefined && !(r.fxValue?.variant && arr(f.fxVariant).includes(r.fxValue.variant))) return false;
  if (f.fxStrengthMin !== undefined && !(r.fxValue && r.fxValue.strength >= f.fxStrengthMin)) return false;
  if (f.fxStrengthMax !== undefined && !(r.fxValue && r.fxValue.strength <= f.fxStrengthMax)) return false;
  if (f.background !== undefined && !arr(f.background).includes(r.background)) return false;
  if (f.bgSwitch !== undefined && r.bgSwitch !== f.bgSwitch) return false;
  if (f.visible !== undefined && !arr(f.visible).every((w) => { const ids = castIds(c, w); return [...ids].some((id) => r.visible.includes(id)); })) return false;
  if (f.hidden !== undefined && !arr(f.hidden).some((w) => [...castIds(c, w)].some((id) => !r.visible.includes(id)))) return false;
  if (f.visibleMin !== undefined && r.visible.length < f.visibleMin) return false;
  if (f.visibleMax !== undefined && r.visible.length > f.visibleMax) return false;
  if (f.lineGapMin !== undefined && r.lineGap < f.lineGapMin) return false;
  if (f.lineGapMax !== undefined && r.lineGap > f.lineGapMax) return false;
  if (f.tailMin !== undefined && r.tail < f.tailMin) return false;
  if (f.tailMax !== undefined && r.tail > f.tailMax) return false;
  if (f.secondsMin !== undefined && r.seconds < f.secondsMin) return false;
  if (f.secondsMax !== undefined && r.seconds > f.secondsMax) return false;
  if (f.locked !== undefined && r.locked !== f.locked) return false;
  if (f.userEdited !== undefined && r.userEdited !== f.userEdited) return false;
  return true;
}

function match(c: Ctx, f: BeatFilter, r: BeatRow): boolean {
  if (!leafMatch(c, f, r)) return false;
  if (f.and && !f.and.every((x) => match(c, x, r))) return false;
  if (f.or && f.or.length > 0 && !f.or.some((x) => match(c, x, r))) return false;
  if (f.not && match(c, f.not, r)) return false;
  return true;
}

export interface QueryResult {
  rows: BeatRow[];
  /** Why part of the filter could not be understood (an unknown cast name, a bad regex ...): the result may then be too small. */
  problems: string[];
}

/** The beats a filter matches, in script order (scene by scene). An empty filter matches every beat. */
export function runQuery(idx: QueryIndex, filter: BeatFilter | undefined): QueryResult {
  const c: Ctx = { idx, problems: new Set(), castCache: new Map() };
  const rows = filter ? idx.rows.filter((r) => match(c, filter, r)) : idx.rows;
  return { rows, problems: [...c.problems] };
}

export const refOf = (r: BeatRow): BeatRef => ({ sceneId: r.sceneId, sceneNo: r.sceneNo, beatId: r.beatId, beatNo: r.beatNo });

const KIND_SHORT: Record<string, string> = { dialogue: '对', narration: '旁', action: '动', pause: '停', establishing: '空景', silent: '默', empty: '空' };

/** The compact table the model reads: one line per beat (capped), then the count and whether it was cut. */
export function queryTable(project: Project, rows: BeatRow[], limit = 60): string {
  const shown = rows.slice(0, limit);
  const name = (id: string) => nameOf(project, id);
  const lines = shown.map((r) => [`${r.sceneNo}-${r.beatNo}`, r.beatId, KIND_SHORT[r.kind] ?? r.kind, r.speaker, `「${clip(r.text, 14)}」`, r.shotType, r.emotion ?? '—', r.fx === 'none' ? '—' : r.fx, r.visible.map(name).join('+') || '无人', r.lineGap, r.locked ? '锁' : r.userEdited ? '手改' : '—'].join('|'));
  return [`共 ${rows.length} 句${rows.length > shown.length ? `（只列前 ${shown.length} 句；完整结果在 queryId 里，batch_edit 会全部用上）` : ''}`, '场-句|id|类|说话人|台词|景别|情绪|特效|画面上的人|句后停顿|标记', ...lines].join('\n');
}

