/**
 * Deterministic repair of names in a translation: the model sometimes writes the simplified-Chinese spelling of a name (灯) where Japanese
 * uses another kanji (燈). Only a spelling that differs from the Japanese one by kanji variants is touched, and only where it is used as a name.
 */
import { JA_NAMES, KANJI_TO_SIMPLIFIED, NAME_PARTS } from '../../../shared/catalog/romaji';

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
