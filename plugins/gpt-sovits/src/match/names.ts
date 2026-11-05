/**
 * Names in file names. `canon` folds a file / folder name into one comparable form (kanji variants -> simplified, no epoch / step / version
 * tags, no 【emotion】 tags); `scoreText` says how strongly a text names a character.
 */
import { KANJI_TO_SIMPLIFIED, NAME_PARTS } from '../../../../shared/catalog/romaji';

/** `【開心】今日はいい天気` -> `今日はいい天気` (also 「」-less `[tag]`). */
export const stripTags = (s: string): string => s.replace(/【[^】]*】|\[[^\]]*\]/g, '').trim();

const fold = (s: string): string => [...s.normalize('NFKC').toLowerCase()].map((c) => KANJI_TO_SIMPLIFIED[c] ?? c).join('');

const TOKEN_NOISE = /^(e\d+|s\d+|ep\d+|epoch\d+|step\d+|v\d+[a-z]*|v\d+|gpt|sovits|ckpt|pth|final|best|lora)$/i;

/** Tokens of a name: folded, tags and training-run noise removed, split on everything that is not a letter, digit or CJK. */
export function tokens(s: string): string[] {
  return fold(stripTags(s)).split(/[^\p{L}\p{N}]+/u).filter((t) => t && !TOKEN_NOISE.test(t));
}

/** Training run of a checkpoint name: `_e15_s200` -> {epoch 15, step 200} (0 when absent). */
export function runOf(name: string): { epoch: number; step: number } {
  const e = /(?:^|[^a-z0-9])e(?:p(?:och)?)?(\d+)(?![a-z0-9])/i.exec(name);
  const s = /(?:^|[^a-z0-9])s(?:tep)?(\d+)(?![a-z0-9])/i.exec(name);
  return { epoch: e ? Number(e[1]) : 0, step: s ? Number(s[1]) : 0 };
}

interface Alias { text: string; weight: number; kind: 'cjk' | 'latin' }

const isCjk = (s: string) => /[぀-ヿ㐀-鿿]/.test(s);

/** What a character is called in files: weighted aliases (folded). */
export function aliasesOf(key: string, displayName: string): Alias[] {
  const out: Alias[] = [];
  const add = (text: string, weight: number) => {
    const t = fold(text).trim();
    if (t) out.push({ text: t, weight, kind: isCjk(t) ? 'cjk' : 'latin' });
  };
  add(displayName, 10);
  const p = NAME_PARTS[key];
  if (p) {
    add(p.family + p.given, 10);
    add(`${p.familyR} ${p.givenR}`, 9);
    add(p.givenR, 6);
    add(p.familyR, 5);
    add(p.given, [...p.given].length >= 2 ? 6 : 5);
    add(p.family, 5);
    for (const k of p.kana ?? []) add(k, 6);
  } else if ([...displayName].length >= 4) {
    add([...displayName].slice(-2).join(''), 5);
  }
  return out;
}

/** The best weight among a character's aliases found in `parts` (names of the file and its folders), 0 = not named. */
export function scoreText(aliases: readonly Alias[], parts: readonly string[]): number {
  const toks = parts.flatMap(tokens);
  const joined = toks.join(' ');
  let best = 0;
  for (const a of aliases) {
    let hit: boolean;
    if (a.kind === 'latin') {
      const words = a.text.split(/\s+/);
      hit = words.every((w) => toks.includes(w));
    } else if ([...a.text].length >= 2) hit = joined.includes(a.text);
    else hit = toks.includes(a.text);
    if (hit) best = Math.max(best, a.weight);
  }
  return best;
}

/** The experiment a checkpoint belongs to: the file name before `-e<N>` / `_e<N>` (`soyo非夹_e8_s616_l128.pth` -> `soyo非夹`), folded. */
export function stemOf(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const cut = /[-_ ]e(?:p(?:och)?)?\d+(?![a-z0-9])/i.exec(base);
  return fold(cut ? base.slice(0, cut.index) : base).trim();
}

/** A model version written in a name: `GPT_weights_v2Pro` -> `v2pro`, `训练v4模型时收集的…` -> `v4`; '' when none. */
export function versionIn(name: string): string {
  return /(?:^|[^a-z0-9])(v\d+(?:pro(?:plus)?|dev|turbo)?)(?![a-z0-9])/i.exec(name)?.[1]?.toLowerCase() ?? '';
}
