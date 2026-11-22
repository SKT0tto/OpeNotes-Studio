/**
 * Deterministic repair of names in a translation: the model sometimes writes the simplified-Chinese spelling of a name (灯) where Japanese
 * uses another kanji (燈). Only a spelling that differs from the Japanese one by kanji variants is touched, and only where it is used as a name.
 */
import { addressAlternatives, addressForm, selfForm, selfForms } from '../../../shared/catalog/addressing';
import { JA_NAMES, JA_NAME_KANA, KANJI_TO_SIMPLIFIED, NAME_PARTS } from '../../../shared/catalog/romaji';

const fold = (s: string) => [...s].map((c) => KANJI_TO_SIMPLIFIED[c] ?? c).join('');
const isKanji = (c: string | undefined) => !!c && /[一-鿿]/.test(c);
/** What may follow a name: an honorific, a particle, punctuation (or the end of the text). */
const AFTER = /^(ちゃん|さん|くん|君|先輩|せんぱい|様|さま|って|の|は|が|も|と|に|を|へ|や|よ|ね|、|。|！|？|!|\?|…|・|」|』|）|$)/;

/** Replaces `from` by `to` where it is a name: everywhere when `anywhere`, else when not after a kanji and followed by an honorific / particle / punctuation / the end. */
function swap(text: string, from: string, to: string, anywhere: boolean): string {
  if (!from || from === to) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(from, i)) {
      const prev = out.slice(-1) || undefined;
      if (anywhere || (!isKanji(prev) && AFTER.test(text.slice(i + from.length)))) {
        out += to;
        i += from.length;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Fixes the names of the given cast keys (those with a known Japanese spelling) in a translated line. */
export function fixNames(spoken: string, keys: readonly string[]): string {
  let t = spoken;
  for (const key of keys) {
    const zh = NAME_PARTS[key];
    const ja = JA_NAMES[key];
    if (!zh || !ja) continue;
    // only spellings that are the same name written with other kanji (爽世 -> そよ is a different name, not a variant)
    const variant = (z: string, j: string) => z !== j && fold(j) === z;
    if (variant(zh.family + zh.given, ja.full)) t = swap(t, zh.family + zh.given, ja.full, true);
    if (variant(zh.family, ja.family)) t = swap(t, zh.family, ja.family, false);
    if (variant(zh.given, ja.given)) t = swap(t, zh.given, ja.given, false);
  }
  return t;
}

const HONORIFIC = /^(ちゃん|さん|くん|先輩)/;

/**
 * Makes the way characters call each other follow `shared/data/addressing.json`: a given name of another cast member (alone, or with
 * ちゃん / さん / くん / 先輩) becomes the speaker's default form for that person; family-name forms stay. Only where it is really a name
 * (same checks as `swap`), and never a form the table lists as a same-time alternative. Unknown speaker or pair: unchanged.
 */
function fixCalls(spoken: string, speakerKey: string, castKeys: readonly string[]): string {
  let t = spoken;
  for (const key of new Set(castKeys)) {
    if (key === speakerKey) continue;
    const ja = JA_NAMES[key];
    const form = addressForm(speakerKey, key);
    if (!ja || !form) continue;
    const alts = new Set(addressAlternatives(speakerKey, key));
    let out = '';
    let i = 0;
    while (i < t.length) {
      if (t.startsWith(ja.given, i) && !isKanji(t[i - 1])) {
        let end = i + ja.given.length;
        const h = HONORIFIC.exec(t.slice(end));
        if (h) end += h[0].length;
        const matched = t.slice(i, end);
        if (AFTER.test(t.slice(end)) && !alts.has(matched)) {
          out += form;
          i = end;
          continue;
        }
      }
      out += t[i];
      i++;
    }
    t = out;
  }
  return t;
}

const FIRST_PERSON = ['わたくし', 'あたくし', 'あたし', 'アタシ', 'ぼく', '僕', '俺'];
const isKana = (c: string | undefined) => !!c && /[ぁ-ゟ゠-ヿ]/.test(c);
/** What may follow a first-person word without making it part of a longer word. */
const SELF_NEXT = /^(たち|達|ら|ども|は|が|も|の|を|に|へ|と|で|って|じゃ|だ|さ|ね|よ|、|。|！|？|…|・|」|』|）|!|\?|\s|$)/;
const SELF_PREV_PARTICLE = 'はがもをにへとでよね';

/** Replaces a clearly different first-person word (あたし, 僕, 俺 ...) by the speaker's default one; 私 / わたし count as the same. */
function fixSelf(spoken: string, speakerKey: string): string {
  const want = selfForm(speakerKey);
  if (!want) return spoken;
  const own = new Set(selfForms(speakerKey));
  let out = '';
  let i = 0;
  while (i < spoken.length) {
    const word = FIRST_PERSON.find((w) => spoken.startsWith(w, i));
    if (word && !own.has(word) && word !== want) {
      const prev = spoken[i - 1];
      const prevOk = prev === undefined || (!isKanji(prev) && (!isKana(prev) || SELF_PREV_PARTICLE.includes(prev)));
      if (prevOk && SELF_NEXT.test(spoken.slice(i + word.length))) {
        out += want;
        i += word.length;
        continue;
      }
    }
    out += spoken[i];
    i++;
  }
  return out;
}

/** Repairs how the speaker calls the other cast members and themselves; no known speaker or data: the text unchanged. */
export function fixAddress(spoken: string, speakerKey: string | null | undefined, castKeys: readonly string[]): string {
  if (!speakerKey) return spoken;
  return fixSelf(fixCalls(spoken, speakerKey, castKeys), speakerKey);
}

const HONORIFIC_ONLY = /^(ちゃん|さん|くん|君|先輩|せんぱい|様|さま)/;
/** Single-kanji parts that are also everyday words (要): only a name when an honorific follows. */
const WORD_LIKE = new Set(['要']);
const READING_AFTER = /^(ちゃん|さん|くん|君|先輩|せんぱい|様|さま|って|の|は|が|も|と|に|を|へ|や|よ|ね|で|か|だ|です|から|たち|、|。|！|？|!|\?|…|・|」|』|）|$)/;
const hasKanji = (s: string) => /[一-鿿]/.test(s);

/** Replaces `from` by `to` where it is really a name (not after a kanji; followed by an honorific, or — for word-like parts — only an honorific). */
function readName(text: string, from: string, to: string): string {
  if (!from || !hasKanji(from)) return text;
  const strict = [...from].length === 1 && WORD_LIKE.has(from);
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(from, i)) {
      const rest = text.slice(i + from.length);
      if (!isKanji(out.slice(-1) || undefined) && (strict ? HONORIFIC_ONLY : READING_AFTER).test(rest)) {
        out += to;
        i += from.length;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * Name parts that pyopenjtalk misreads (from g2p checks on 2026-11-22), as `<key>f` (family) / `<key>g` (given). Only these are rewritten, in
 * katakana (hiragana names get mis-segmented: はま-, まは- read as particles); every other part stays in kanji, which it reads correctly.
 */
const MISREAD = new Set([
  '001g', '002g', '003g', '003f', '005g', '006g', '007g', '008g', '010f', '010g', '013f', '013g', '014g',
  '017f', '019f', '020g', '021f', '021g', '022f', '022g', '023g', '025g',
]);
const toKatakana = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

/**
 * The text GPT-SoVITS gets: the misread kanji name parts of the cast rewritten into katakana readings (燈 -> トモリ, 豊川 -> トガワ).
 * Full name first (also with a space or ・ between; each part on its own, 高松燈 -> 高松トモリ), then family, then given name. The stored
 * `spoken` is never changed.
 */
export function readingForTts(ja: string, castKeys: readonly string[]): string {
  let t = ja;
  for (const key of new Set(castKeys)) {
    const n = JA_NAMES[key];
    const k = JA_NAME_KANA[key];
    if (!n || !k) continue;
    const fam = MISREAD.has(`${key}f`) ? toKatakana(k.family) : n.family;
    const giv = MISREAD.has(`${key}g`) ? toKatakana(k.given) : n.given;
    if (fam !== n.family || giv !== n.given) for (const sep of ['', ' ', '　', '・']) t = readName(t, n.family + sep + n.given, fam + sep + giv);
    if (fam !== n.family) t = readName(t, n.family, fam);
    if (giv !== n.given) t = readName(t, n.given, giv);
  }
  return t;
}
