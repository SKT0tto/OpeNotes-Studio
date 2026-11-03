/**
 * Names of characters in other scripts than the data file's simplified Chinese: romaji for typing a name into a search box, and (for matching
 * files that are named after a character) the structured parts and the kanji that differ between simplified Chinese and Japanese.
 */

/** Romanised / short names so that typing "Uika" finds 三角初华 (the data file only holds the Chinese names). Keys are `characters.json` keys. */
export const ROMAJI_ALIASES: Record<string, string> = {
  '001': 'tomori anon', '002': 'anon chihaya', '003': 'rana kaname', '004': 'soyo nagasaki', '005': 'taki shiina',
  '006': 'uika misumi', '007': 'mutsumi wakaba', '008': 'umiri yahata', '009': 'nyamu yutenji', '010': 'sakiko togawa',
};

export interface NameParts {
  /** Simplified Chinese family / given name. */
  family: string;
  given: string;
  /** Hepburn romaji (lowercase). */
  familyR: string;
  givenR: string;
  /** Kana spellings of the given name (some are written in kana in Japanese). */
  kana?: string[];
}

/** MyGO!!!!! (001-005) and Ave Mujica (006-010): the names that are reliable. Other keys match by their full Chinese name only. */
export const NAME_PARTS: Record<string, NameParts> = {
  '001': { family: '高松', given: '灯', familyR: 'takamatsu', givenR: 'tomori', kana: ['ともり'] },
  '002': { family: '千早', given: '爱音', familyR: 'chihaya', givenR: 'anon', kana: ['あのん'] },
  '003': { family: '要', given: '乐奈', familyR: 'kaname', givenR: 'rana', kana: ['らーな', 'らな'] },
  '004': { family: '长崎', given: '爽世', familyR: 'nagasaki', givenR: 'soyo', kana: ['そよ'] },
  '005': { family: '椎名', given: '立希', familyR: 'shiina', givenR: 'taki', kana: ['たき'] },
  '006': { family: '三角', given: '初华', familyR: 'misumi', givenR: 'uika', kana: ['ういか'] },
  '007': { family: '若叶', given: '睦', familyR: 'wakaba', givenR: 'mutsumi', kana: ['むつみ'] },
  '008': { family: '八幡', given: '海铃', familyR: 'yahata', givenR: 'umiri', kana: ['うみり'] },
  '009': { family: '祐天寺', given: '若麦', familyR: 'yutenji', givenR: 'nyamu', kana: ['にゃむ'] },
  '010': { family: '丰川', given: '祥子', familyR: 'togawa', givenR: 'sakiko', kana: ['さきこ'] },
};

/** Japanese (shinjitai) / traditional kanji -> the simplified form the data file uses, for the characters that occur in names. */
export const KANJI_TO_SIMPLIFIED: Record<string, string> = {
  燈: '灯', 愛: '爱', 楽: '乐', 樂: '乐', 豊: '丰', 豐: '丰', 葉: '叶', 長: '长', 鈴: '铃', 華: '华', 蛍: '萤', 螢: '萤', 沢: '泽', 澤: '泽',
  須: '须', 浜: '滨', 濱: '滨', 馬: '马', 宮: '宫', 寧: '宁', 倉: '仓', 櫻: '樱', 桜: '樱', 憂: '忧', 響: '响', 紗: '纱', 莉: '莉', 麦: '麦', 麥: '麦',
  龍: '龙', 竜: '龙', 鳥: '鸟', 鷗: '鸥', 嶋: '岛', 島: '岛', 綾: '绫', 眞: '真', 凛: '凛', 瀬: '濑', 薫: '薰', 彩: '彩', 蘭: '兰', 巴: '巴',
  與: '与', 条: '条', 條: '条', 広: '广', 廣: '广', 関: '关', 關: '关', 辺: '边', 邊: '边', 渡: '渡', 実: '实', 實: '实', 歌: '歌', 晴: '晴', 夢: '梦',
};
