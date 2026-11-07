/**
 * Auto-match: which trained weights and reference audio belong to which character.
 *  1. By name: file and folder names are scored against each character's aliases (Chinese name, Japanese kanji, romaji, kana);
 *     a clear winner takes the file. Several files for one character: the highest epoch, GPT and SoVITS from the same version family.
 *  2. For characters that found nothing, one AI call over the files nobody claimed (only when an AI is configured); every path it returns
 *     must be one of the files it was shown.
 */
import { z } from 'zod';
import { NAME_PARTS } from '../../../../shared/catalog/romaji';
import type { PluginServerContext } from '../../../../shared/plugins/api';
import { aliasesOf, scoreText, versionIn } from './names';
import { scanInstall, type RefFile, type Scan, type ScanReport, type WeightFile } from './scan';

export interface MatchCharacter { key: string; name: string }
/** A reference clip the person may choose (for the dropdown of a row). */
export interface RefCandidate {
  path: string;
  text: string;
  lang: string;
  seconds: number | null;
  tag: string;
  /** A neutral, calm delivery (叙述, 平静 ...): the safest voice to clone from. */
  calm: boolean;
  /** Where the text came from: a .txt / .list next to the clip, or the file name. */
  textFrom: RefFile['textFrom'];
  /** Name of the folder it sits in (to tell versions apart). */
  folder: string;
}
/** One trained model of a character (GPT and SoVITS paired by experiment name). */
export interface WeightVariant { label: string; gpt?: string; sovits?: string; version: string; epoch: number }
export interface MatchRow {
  characterKey: string;
  name: string;
  /** In the open project's cast (ticked by default); voices are shared by all projects, so the others are listed too. */
  inProject: boolean;
  gpt?: string;
  sovits?: string;
  ref?: { path: string; text: string; lang: string };
  source: 'filename' | 'ai';
  /** Why (AI rows) or which family (filename rows). */
  reason?: string;
  /** Every model found for the character (best first) and which one `gpt` / `sovits` came from. */
  variants: WeightVariant[];
  variant: number;
  /** Reference clips of 3-10 s, best first (calm ones first). */
  candidates: RefCandidate[];
}
export interface MatchResult {
  rows: MatchRow[];
  /** Characters of the project nothing was found for. */
  unmatched: string[];
  scanned: { gpt: number; sovits: number; refs: number };
  /** What each folder held. */
  report: ScanReport[];
  /** Folders scanned: reference clips may be played from them (and nowhere else). */
  dirs: string[];
  ai: 'used' | 'not-needed' | 'unavailable' | 'failed';
  warnings: string[];
}

const THRESHOLD = 5;

/** Every character whose names are known, project or not: a folder named after one of them belongs to that one. */
export function knownCharacters(requested: readonly MatchCharacter[]): MatchCharacter[] {
  const out = [...requested];
  for (const [key, p] of Object.entries(NAME_PARTS)) if (!out.some((c) => c.key === key)) out.push({ key, name: `${p.family}${p.given}` });
  return out;
}

type Aliased = Array<{ key: string; aliases: ReturnType<typeof aliasesOf> }>;

/** The character a text clearly names (the best score, at least THRESHOLD and ahead of every other), else null. */
function owner(chars: Aliased, parts: readonly string[]): string | null {
  const scored = chars.map((c) => ({ key: c.key, score: scoreText(c.aliases, parts) })).filter((x) => x.score >= THRESHOLD).sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!.key;
}

/** A short label (`tomori_01`, `愛音`), not a sentence somebody says: only a label may say whose recording a file is. */
export function isLabelName(base: string): boolean {
  const t = base.trim();
  if (/[。、！？…!?,，.]/.test(t.replace(/\.[a-z0-9]+$/i, ''))) return false;
  return [...t.replace(/[\d_\-\s]/g, '')].length <= 8;
}

/**
 * Who a reference clip belongs to. A folder that names a character decides, whoever it is (also a character that is not in the project:
 * then the clip is nobody's here). Without such a folder the file name decides, but only a label-style name, never spoken text.
 */
function refOwner(chars: Aliased, r: RefFile): string | null {
  if (r.folders.length > 0) {
    const k = owner(chars, r.folders);
    if (k) return k;
  }
  return isLabelName(r.base) ? owner(chars, [r.base]) : null;
}

/** Whose weights a file is: the folder it sits in decides first (whoever that is), then its own name. */
function weightOwner(chars: Aliased, w: WeightFile): string | null {
  const folders = w.parts.slice(0, -1);
  return (folders.length > 0 ? owner(chars, folders) : null) ?? owner(chars, w.parts.slice(-1));
}

const newest = (a: WeightFile, b: WeightFile) => b.epoch - a.epoch || b.step - a.step || b.mtime - a.mtime;

/**
 * Every trained model of a character, best first: the family that has both GPT and SoVITS (then the newest); inside it one entry per
 * experiment that has both files (the plainest stem first, e.g. `soyo` before `soyo非夹`) with its highest epoch. A family whose stems
 * do not meet gives one entry made of the best file of each side.
 */
export function weightVariants(gpt: WeightFile[], sovits: WeightFile[]): Array<{ label: string; gpt?: WeightFile; sovits?: WeightFile; family: string }> {
  const families = [...new Set([...gpt, ...sovits].map((w) => w.family))];
  const ranked = families.map((f) => {
    const fg = gpt.filter((w) => w.family === f);
    const fs = sovits.filter((w) => w.family === f);
    const shared = [...new Set(fg.map((w) => w.stem))].filter((st) => fs.some((w) => w.stem === st)).sort((a, b) => a.length - b.length || a.localeCompare(b));
    const entries = shared.length > 0
      ? shared.map((st) => ({ label: st, gpt: fg.filter((w) => w.stem === st).sort(newest)[0], sovits: fs.filter((w) => w.stem === st).sort(newest)[0], family: f }))
      : [{ label: [...new Set([fg.sort(newest)[0]?.stem, fs.sort(newest)[0]?.stem].filter(Boolean))].join(' + '), gpt: fg.sort(newest)[0], sovits: fs.sort(newest)[0], family: f }];
    const first = entries[0]!;
    return { entries, both: first.gpt && first.sovits ? 1 : 0, when: Math.max(first.gpt?.mtime ?? 0, first.sovits?.mtime ?? 0) };
  }).sort((a, b) => b.both - a.both || b.when - a.when);
  return ranked.flatMap((x) => x.entries.map((e) => ({ label: e.label, ...(e.gpt ? { gpt: e.gpt } : {}), ...(e.sovits ? { sovits: e.sovits } : {}), family: e.family })));
}

/** Best GPT / SoVITS of a character (the first of `weightVariants`). */
export function pickWeights(gpt: WeightFile[], sovits: WeightFile[]): { gpt?: WeightFile; sovits?: WeightFile } {
  const top = weightVariants(gpt, sovits)[0];
  return top ? { ...(top.gpt ? { gpt: top.gpt } : {}), ...(top.sovits ? { sovits: top.sovits } : {}) } : {};
}

/** Neutral deliveries: the safest voice to clone from. */
const NEUTRAL = /叙述|平静|通常|普通|标准|交谈|交流|陈述|normal|neutral|calm/i;
/** Strong emotion or an unusual manner of speaking: the cloned voice would carry it into every line. */
const STRONG = /颤|兴奋|悲|惊|生气|愤|哈|笑|哭|开心|感叹|疑问|反问|吐槽|发誓|军训|不甘|渴望|赞叹|牢骚|焦|愉快|抗拒|责难|调侃|喊|叫|撒娇|害怕|紧张|犹豫|无奈|叹气|低沉|夹子音|不演了|典中典|企鹅|推销|重力|唐/;
/** Voice variants kept in their own subfolder next to the plain voice. */
const VARIANT = /夹子音|不演了|不夹|非夹/;
/** The reference length GPT-SoVITS accepts (all versions refuse anything outside it). */
export const REF_MIN_SECONDS = 3;
export const REF_MAX_SECONDS = 10;

export const isCalmTag = (tag: string): boolean => NEUTRAL.test(tag) && !STRONG.test(tag);
const usableLength = (r: RefFile): boolean => r.seconds === null || (r.seconds >= REF_MIN_SECONDS && r.seconds <= REF_MAX_SECONDS);

/** The deliveries that are plain narration: the best reference. Other neutral tags (交流 ...) and compounds (叙述，提示) come after. */
const PLAIN = new Set(['叙述', '平静', '通常', '普通', '标准', 'normal', 'neutral', 'calm']);
const tagParts = (tag: string): string[] => tag.split(/[，,、]/).map((x) => x.trim()).filter(Boolean);

/** Higher is a better reference. Never called for a clip outside 3-10 s. */
function refScore(r: RefFile, want: string): number {
  let n = 0;
  // length: a few seconds of plain speech is the safest (the limit is 3-10 s; clips close to either end risk a refusal or a drifting voice)
  if (r.seconds === null) n -= 1; // the length could not be read: it may still be refused
  else if (r.seconds >= 4 && r.seconds <= 6.5) n += 2;
  else if (r.seconds >= 3.5 && r.seconds <= 8) n += 1;
  if (r.text) n += 3;
  if (r.textFrom === 'txt' || r.textFrom === 'list') n += 1;
  if (r.textSuspect) n -= 8;
  const parts = tagParts(r.tag);
  if (parts.length > 0) {
    if (isCalmTag(r.tag)) n += parts.every((x) => PLAIN.has(x.toLowerCase())) ? 3 : 2;
    else if (STRONG.test(r.tag)) n -= 4;
  }
  if (r.text) {
    // a text that is probably mis-recognised: letters and digits inside Japanese, gaps between kana
    if (/[A-Za-z]/.test(r.text) && /[぀-ヿ㐀-鿿]/.test(r.text)) n -= 2;
    if (/[0-9０-９]/.test(r.text)) n -= 1;
    if (/[぀-ヿ㐀-鿿]\s+[぀-ヿ㐀-鿿]/.test(r.text)) n -= 1;
    if ([...r.text].length < 6) n -= 2;
    // pauses, a trailing-off start, shouting and questions all colour the cloned voice
    const pauses = (r.text.match(/…+|\.{3,}/g) ?? []).length;
    n -= Math.min(4, pauses);
    if (!r.tag && pauses >= 2) n -= 3;
    if (/^[…・.]/.test(r.text)) n -= 2;
    if (/[!！?？]/.test(r.text)) n -= 1;
  }
  // the folder the text was written for: a v4 training folder holds clean transcripts, a v2 folder rough recognition
  const has = r.folders.map(versionIn).find(Boolean);
  if (has === 'v4') n += 3;
  if (want && has) n += has === want ? 3 : -3;
  if (r.folders.some((f) => VARIANT.test(f))) n -= 2;
  return n;
}

/** The usable references of a character (3-10 s), best first: calm ones, from the model's version, with a text that can be trusted. */
export function rankRefs(refs: RefFile[], opts: { version?: string | undefined } = {}): RefFile[] {
  const want = (opts.version ?? '').toLowerCase();
  return refs.filter(usableLength).map((r) => ({ r, n: refScore(r, want) })).sort((a, b) => b.n - a.n || [...a.r.text].length - [...b.r.text].length || a.r.rel.localeCompare(b.r.rel)).map((x) => x.r);
}

/** Best reference of a character, or undefined when none is 3-10 s long. */
export function pickRef(refs: RefFile[], opts: { version?: string | undefined } = {}): RefFile | undefined {
  return rankRefs(refs, opts)[0];
}

const candidateOf = (r: RefFile): RefCandidate => ({ path: r.path, text: r.text, lang: r.lang || 'ja', seconds: r.seconds, tag: r.tag, calm: !!r.tag && isCalmTag(r.tag), textFrom: r.textFrom, folder: r.folders.at(-1) ?? '' });

export interface AiMatch { characterKey: string; gpt?: string | null | undefined; sovits?: string | null | undefined; ref?: string | null | undefined; reason: string }
export const AiMatchSchema = z.object({
  matches: z.array(z.object({ characterKey: z.string(), gpt: z.string().nullish(), sovits: z.string().nullish(), ref: z.string().nullish(), reason: z.string().default('') })),
});

export const MATCH_AI_VERSION = 'voice-match-1';
const MATCH_AI_SYSTEM = `你是 BanG Dream!（邦邦）的资料助手。下面给出一些还没有对上号的角色（characterKey 与中文名），以及 GPT-SoVITS 文件夹里没有被认领的文件（相对路径）：GPT 权重(.ckpt)、SoVITS 权重(.pth)、参考音频。请只在有把握时，按文件名和文件夹名（可能是日文、罗马字、缩写，例如 ksm = 户山香澄、tomori = 高松灯）把文件对应到角色。没有把握就不要写。

输出一个 JSON 对象：{"matches":[{"characterKey":"…","gpt":"文件路径或 null","sovits":"文件路径或 null","ref":"文件路径或 null","reason":"一句话说明依据"}]}
- 路径必须逐字取自给出的清单，不要改写、不要编造。
- 同一个角色有多个版本时，选 epoch 最高的一个。
- 只回答 characters 里的角色；没有把握的角色整个省略。`;

/** The AI stage: matches for the characters in `todo` from the unclaimed files. Paths are checked against the lists it was shown. */
export async function aiMatch(
  ctx: Pick<PluginServerContext, 'llm'>,
  todo: MatchCharacter[],
  files: { gpt: WeightFile[]; sovits: WeightFile[]; refs: RefFile[] },
  signal?: AbortSignal,
): Promise<MatchRow[]> {
  const MAX = 300;
  const gpt = files.gpt.slice(0, MAX);
  const sovits = files.sovits.slice(0, MAX);
  const refs = files.refs.slice(0, MAX);
  if (gpt.length + sovits.length + refs.length === 0 || todo.length === 0) return [];
  const r = await ctx.llm.callJson<z.infer<typeof AiMatchSchema>>({
    system: MATCH_AI_SYSTEM,
    user: { characters: todo.map((c) => ({ characterKey: c.key, name: c.name })), files: { gpt: gpt.map((f) => f.rel), sovits: sovits.map((f) => f.rel), ref: refs.map((f) => f.rel) } },
    schema: AiMatchSchema, schemaName: 'VoiceMatch', promptVersion: MATCH_AI_VERSION, maxTokens: 4096 + 200 * todo.length, signal,
  });
  const byRel = <T extends { rel: string }>(list: T[], rel: string | null | undefined): T | undefined => (rel ? list.find((f) => f.rel === rel) : undefined);
  const out: MatchRow[] = [];
  const names = new Map(todo.map((c) => [c.key, c.name]));
  const seen = new Set<string>();
  for (const m of r.data.matches) {
    if (!names.has(m.characterKey) || seen.has(m.characterKey)) continue;
    const g = byRel(gpt, m.gpt);
    const s = byRel(sovits, m.sovits);
    const f = byRel(refs, m.ref);
    if (!g && !s && !f) continue; // nothing it said is a real file
    seen.add(m.characterKey);
    out.push({ characterKey: m.characterKey, name: names.get(m.characterKey)!, inProject: true, variants: [], variant: 0, candidates: [], ...(g ? { gpt: g.path } : {}), ...(s ? { sovits: s.path } : {}), ...(f ? { ref: { path: f.path, text: f.text, lang: f.lang || 'ja' } } : {}), source: 'ai', reason: m.reason });
  }
  return out;
}

export async function autoMatch(
  ctx: Pick<PluginServerContext, 'llm'>,
  settings: { sovitsRoot?: string | undefined; refDirs: string[] },
  characters: MatchCharacter[],
  signal?: AbortSignal,
): Promise<MatchResult> {
  const scan: Scan = scanInstall(settings.sovitsRoot ?? '', settings.refDirs);
  // every character whose names are known takes part, so that a folder named after someone who is not in the project is not given to a
  // project character (their files are listed as rows of their own, unticked)
  const all = knownCharacters(characters);
  const chars: Aliased = all.map((c) => ({ key: c.key, aliases: aliasesOf(c.key, c.name) }));
  const claimed = { gpt: new Set<string>(), sovits: new Set<string>(), refs: new Set<string>() };
  const owned = { gpt: new Set<string>(), sovits: new Set<string>(), refs: new Set<string>() };
  const mine = new Map<string, { gpt: WeightFile[]; sovits: WeightFile[]; refs: RefFile[] }>(all.map((c) => [c.key, { gpt: [], sovits: [], refs: [] }]));

  for (const w of scan.gpt) {
    const k = weightOwner(chars, w);
    if (k) { mine.get(k)!.gpt.push(w); owned.gpt.add(w.path); }
  }
  for (const w of scan.sovits) {
    const k = weightOwner(chars, w);
    if (k) { mine.get(k)!.sovits.push(w); owned.sovits.add(w.path); }
  }
  for (const r of scan.refs) {
    const k = refOwner(chars, r);
    if (k) { mine.get(k)!.refs.push(r); owned.refs.add(r.path); }
  }

  const inProject = new Set(characters.map((c) => c.key));
  const warnings = [...scan.warnings];
  const rows: MatchRow[] = [];
  for (const c of all) {
    const m = mine.get(c.key)!;
    const variants = weightVariants(m.gpt, m.sovits);
    const w: { gpt?: WeightFile | undefined; sovits?: WeightFile | undefined } = variants[0] ?? {};
    const version = w.sovits?.version || w.gpt?.version;
    const ranked = rankRefs(m.refs, { version });
    const ref = ranked[0];
    if (!w.gpt && !w.sovits && !ref) continue;
    if (inProject.has(c.key) && !ref) warnings.push(m.refs.length > 0 ? `${c.name}：找到 ${m.refs.length} 个参考音频，但没有 ${REF_MIN_SECONDS}–${REF_MAX_SECONDS} 秒长的（GPT-SoVITS 会拒绝），请手动选一个` : `${c.name}：找到了模型，但没有找到参考音频`);
    if (w.gpt) claimed.gpt.add(w.gpt.path);
    if (w.sovits) claimed.sovits.add(w.sovits.path);
    if (ref) claimed.refs.add(ref.path);
    const family = w.gpt?.family ?? w.sovits?.family;
    rows.push({
      characterKey: c.key, name: c.name, inProject: inProject.has(c.key),
      ...(w.gpt ? { gpt: w.gpt.path } : {}), ...(w.sovits ? { sovits: w.sovits.path } : {}),
      ...(ref ? { ref: { path: ref.path, text: ref.text, lang: ref.lang || 'ja' } } : {}),
      source: 'filename', ...(family ? { reason: family.startsWith('pack:') ? `${w.sovits?.version || w.gpt?.version || ''} ${family.slice(5)}`.trim() : `版本 ${family}` } : {}),
      variants: variants.map((v) => ({ label: v.label, ...(v.gpt ? { gpt: v.gpt.path } : {}), ...(v.sovits ? { sovits: v.sovits.path } : {}), version: v.sovits?.version || v.gpt?.version || '', epoch: Math.max(v.gpt?.epoch ?? 0, v.sovits?.epoch ?? 0) })),
      variant: 0,
      candidates: ranked.slice(0, 60).map(candidateOf),
    });
  }

  let unmatched = characters.filter((c) => !rows.some((r) => r.characterKey === c.key));
  let ai: MatchResult['ai'] = 'not-needed';
  if (unmatched.length > 0) {
    // only files nobody's name is on
    const free = {
      gpt: scan.gpt.filter((f) => !claimed.gpt.has(f.path) && !owned.gpt.has(f.path)),
      sovits: scan.sovits.filter((f) => !claimed.sovits.has(f.path) && !owned.sovits.has(f.path)),
      refs: scan.refs.filter((f) => !claimed.refs.has(f.path) && !owned.refs.has(f.path)),
    };
    const avail = ctx.llm.available();
    if (free.gpt.length + free.sovits.length + free.refs.length === 0) ai = 'not-needed';
    else if (!avail.ok) ai = 'unavailable';
    else {
      try {
        const more = await aiMatch(ctx, unmatched, free, signal);
        rows.push(...more);
        ai = 'used';
        unmatched = unmatched.filter((c) => !more.some((r) => r.characterKey === c.key));
      } catch (e) {
        if (signal?.aborted) throw e;
        ai = 'failed';
        warnings.push(`AI 匹配失败：${(e as Error).message}`);
      }
    }
  }
  if (rows.length === 0) warnings.push(nothingFound(scan));
  const order = new Map(characters.map((c, i) => [c.key, i]));
  rows.sort((a, b) => (order.get(a.characterKey) ?? 1e6) - (order.get(b.characterKey) ?? 1e6) || a.characterKey.localeCompare(b.characterKey));
  return { rows, unmatched: unmatched.map((c) => c.key), scanned: { gpt: scan.gpt.length, sovits: scan.sovits.length, refs: scan.refs.length }, report: scan.report, dirs: scan.dirs, ai, warnings };
}

/** Why nothing was found, in words: which folders were read, how many files of each kind, and what to try. */
export function nothingFound(scan: Scan): string {
  const read = scan.report.map((r) => `${r.path}（.ckpt ${r.ckpt} 个、.pth ${r.pth} 个、音频 ${r.audio} 个）`).join('；');
  const total = scan.gpt.length + scan.sovits.length + scan.refs.length;
  return total === 0
    ? `没有找到任何模型或参考音频。读过的文件夹：${read}。请填 GPT-SoVITS 的安装目录、整合包文件夹，或某个角色的文件夹（里面要有 .ckpt / .pth 权重或 .wav / .mp3 参考音频）。`
    : `找到了 ${scan.gpt.length} 个 GPT 权重、${scan.sovits.length} 个 SoVITS 权重、${scan.refs.length} 个参考音频（${read}），但认不出它们属于哪个角色。文件名或文件夹名里需要有角色名（中文、日文或罗马字，如 灯 / 燈 / tomori），或者放进以角色命名的子文件夹；也可以在下面手动填。`;
}
