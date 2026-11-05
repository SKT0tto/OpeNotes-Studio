/**
 * Auto-match: which trained weights and reference audio belong to which character.
 *  1. By name: file and folder names are scored against each character's aliases (Chinese name, Japanese kanji, romaji, kana);
 *     a clear winner takes the file. Several files for one character: the highest epoch, GPT and SoVITS from the same version family.
 *  2. For characters that found nothing, one AI call over the files nobody claimed (only when an AI is configured); every path it returns
 *     must be one of the files it was shown.
 */
import { z } from 'zod';
import type { PluginServerContext } from '../../../../shared/plugins/api';
import { aliasesOf, scoreText, versionIn } from './names';
import { scanInstall, type RefFile, type Scan, type WeightFile } from './scan';

export interface MatchCharacter { key: string; name: string }
export interface MatchRow {
  characterKey: string;
  name: string;
  gpt?: string;
  sovits?: string;
  ref?: { path: string; text: string; lang: string };
  source: 'filename' | 'ai';
  /** Why (AI rows) or which family (filename rows). */
  reason?: string;
}
export interface MatchResult {
  rows: MatchRow[];
  /** Characters nothing was found for. */
  unmatched: string[];
  scanned: { gpt: number; sovits: number; refs: number };
  ai: 'used' | 'not-needed' | 'unavailable' | 'failed';
  warnings: string[];
}

const THRESHOLD = 5;

/** The character a text clearly names (the best score, at least THRESHOLD and ahead of every other), else null. */
function owner(chars: Array<{ key: string; aliases: ReturnType<typeof aliasesOf> }>, parts: readonly string[]): string | null {
  const scored = chars.map((c) => ({ key: c.key, score: scoreText(c.aliases, parts) })).filter((x) => x.score >= THRESHOLD).sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0]!.score === scored[1]!.score) return null;
  return scored[0]!.key;
}

const newest = (a: WeightFile, b: WeightFile) => b.epoch - a.epoch || b.step - a.step || b.mtime - a.mtime;

/**
 * Best GPT / SoVITS of a character: the family that has both (then the newest). Inside it, one experiment that has both files
 * (the plainest stem, e.g. `soyo` over `soyo非夹`), then the highest epoch. Files whose stems do not meet are picked one by one.
 */
export function pickWeights(gpt: WeightFile[], sovits: WeightFile[]): { gpt?: WeightFile; sovits?: WeightFile } {
  const families = [...new Set([...gpt, ...sovits].map((w) => w.family))];
  const ranked = families.map((f) => {
    const fg = gpt.filter((w) => w.family === f);
    const fs = sovits.filter((w) => w.family === f);
    const shared = [...new Set(fg.map((w) => w.stem))].filter((st) => fs.some((w) => w.stem === st)).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    const g = (shared === undefined ? fg : fg.filter((w) => w.stem === shared)).sort(newest)[0];
    const s = (shared === undefined ? fs : fs.filter((w) => w.stem === shared)).sort(newest)[0];
    return { f, g, s, both: g && s ? 1 : 0, when: Math.max(g?.mtime ?? 0, s?.mtime ?? 0) };
  }).sort((a, b) => b.both - a.both || b.when - a.when);
  const top = ranked[0];
  return top ? { ...(top.g ? { gpt: top.g } : {}), ...(top.s ? { sovits: top.s } : {}) } : {};
}

const CALM = /平静|通常|普通|normal|neutral|calm/i;
/** Voice variants kept in their own subfolder next to the plain voice. */
const VARIANT = /夹子音|不演了|不夹|非夹/;

/** Best reference of a character: 3-10 s long, with a usable text, a calm emotion tag, from the model's version, and the plain voice. */
export function pickRef(refs: RefFile[], opts: { version?: string | undefined } = {}): RefFile | undefined {
  const want = (opts.version ?? '').toLowerCase();
  const score = (r: RefFile) => {
    let n = (r.seconds !== null && r.seconds >= 3 && r.seconds <= 10 ? 4 : r.seconds !== null && r.seconds > 0 && r.seconds <= 14 ? 1 : 0) + (r.text ? 3 : 0) + (CALM.test(r.tag) ? 1 : 0);
    if (r.textSuspect) n -= 8;
    const has = r.folders.map(versionIn).find(Boolean);
    if (want && has) n += has === want ? 3 : -3;
    if (r.folders.some((f) => VARIANT.test(f))) n -= 2;
    return n;
  };
  return [...refs].sort((a, b) => score(b) - score(a) || a.rel.localeCompare(b.rel))[0];
}

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
    out.push({ characterKey: m.characterKey, name: names.get(m.characterKey)!, ...(g ? { gpt: g.path } : {}), ...(s ? { sovits: s.path } : {}), ...(f ? { ref: { path: f.path, text: f.text, lang: f.lang || 'ja' } } : {}), source: 'ai', reason: m.reason });
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
  const chars = characters.map((c) => ({ key: c.key, aliases: aliasesOf(c.key, c.name) }));
  const claimed = { gpt: new Set<string>(), sovits: new Set<string>(), refs: new Set<string>() };
  const mine = new Map<string, { gpt: WeightFile[]; sovits: WeightFile[]; refs: RefFile[] }>(characters.map((c) => [c.key, { gpt: [], sovits: [], refs: [] }]));

  for (const w of scan.gpt) {
    const k = owner(chars, w.parts);
    if (k) mine.get(k)!.gpt.push(w);
  }
  for (const w of scan.sovits) {
    const k = owner(chars, w.parts);
    if (k) mine.get(k)!.sovits.push(w);
  }
  for (const r of scan.refs) {
    // a folder named after a character decides; otherwise the file name
    const k = (r.folders.length > 0 ? owner(chars, r.folders) : null) ?? owner(chars, [r.base]);
    if (k) mine.get(k)!.refs.push(r);
  }

  const rows: MatchRow[] = [];
  for (const c of characters) {
    const m = mine.get(c.key)!;
    const w = pickWeights(m.gpt, m.sovits);
    const ref = pickRef(m.refs, { version: w.sovits?.version || w.gpt?.version });
    if (!w.gpt && !w.sovits && !ref) continue;
    if (w.gpt) claimed.gpt.add(w.gpt.path);
    if (w.sovits) claimed.sovits.add(w.sovits.path);
    if (ref) claimed.refs.add(ref.path);
    const family = w.gpt?.family ?? w.sovits?.family;
    rows.push({
      characterKey: c.key, name: c.name,
      ...(w.gpt ? { gpt: w.gpt.path } : {}), ...(w.sovits ? { sovits: w.sovits.path } : {}),
      ...(ref ? { ref: { path: ref.path, text: ref.text, lang: ref.lang || 'ja' } } : {}),
      source: 'filename', ...(family ? { reason: family.startsWith('pack:') ? `${w.sovits?.version || w.gpt?.version || ''} ${family.slice(5)}`.trim() : `版本 ${family}` } : {}),
    });
  }

  let unmatched = characters.filter((c) => !rows.some((r) => r.characterKey === c.key));
  const warnings = [...scan.warnings];
  let ai: MatchResult['ai'] = 'not-needed';
  if (unmatched.length > 0) {
    const free = {
      gpt: scan.gpt.filter((f) => !claimed.gpt.has(f.path)),
      sovits: scan.sovits.filter((f) => !claimed.sovits.has(f.path)),
      refs: scan.refs.filter((f) => !claimed.refs.has(f.path)),
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
  const order = new Map(characters.map((c, i) => [c.key, i]));
  rows.sort((a, b) => (order.get(a.characterKey) ?? 0) - (order.get(b.characterKey) ?? 0));
  return { rows, unmatched: unmatched.map((c) => c.key), scanned: { gpt: scan.gpt.length, sovits: scan.sovits.length, refs: scan.refs.length }, ai, warnings };
}
