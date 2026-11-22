/**
 * Names of characters in other scripts than the data file's simplified Chinese: romaji for typing a name into a search box, and (for matching
 * files that are named after a character) the structured parts and the kanji that differ between simplified Chinese and Japanese.
 */

/** Romanised / short names so that typing "Uika" finds 三角初华 (the data file only holds the Chinese names). Keys are `characters.json` keys. */
export const ROMAJI_ALIASES: Record<string, string> = {
  '001': 'tomori anon', '002': 'anon chihaya', '003': 'rana kaname', '004': 'soyo nagasaki', '005': 'taki shiina',
  '006': 'uika misumi', '007': 'mutsumi wakaba', '008': 'umiri yahata', '009': 'nyamu yutenji', '010': 'sakiko togawa',
  '011': 'arale nakamachi', '012': 'nonoka miyanaga', '013': 'ritsu minetsuki', '014': 'miyako fuji', '015': 'yuno sengoku',
  '016': 'hotaru shiomi', '017': 'natsume izawa', '018': 'nagi kotohira', '019': 'mahoro hamasaki', '020': 'hoka izumi',
  '021': 'raika suga', '022': 'miku mahashi', '023': 'yomogi yakura', '024': 'chieri umezato', '025': 'shizuku shinomiya',
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

/** Official Japanese spellings (full / given / family name), for the keys whose spelling is certain. */
export const JA_NAMES: Record<string, { full: string; given: string; family: string }> = {
  '001': { full: '高松燈', given: '燈', family: '高松' },
  '002': { full: '千早愛音', given: '愛音', family: '千早' },
  '003': { full: '要楽奈', given: '楽奈', family: '要' },
  '004': { full: '長崎そよ', given: 'そよ', family: '長崎' },
  '005': { full: '椎名立希', given: '立希', family: '椎名' },
  '006': { full: '三角初華', given: '初華', family: '三角' },
  '007': { full: '若葉睦', given: '睦', family: '若葉' },
  '008': { full: '八幡海鈴', given: '海鈴', family: '八幡' },
  '009': { full: '祐天寺にゃむ', given: 'にゃむ', family: '祐天寺' },
  '010': { full: '豊川祥子', given: '祥子', family: '豊川' },
  '011': { full: '仲町あられ', given: 'あられ', family: '仲町' },
  '012': { full: '宮永ののか', given: 'ののか', family: '宮永' },
  '013': { full: '峰月律', given: '律', family: '峰月' },
  '014': { full: '藤都子', given: '都子', family: '藤' },
  '015': { full: '千石ユノ', given: 'ユノ', family: '千石' },
  '016': { full: '汐見蛍', given: '蛍', family: '汐見' },
  '017': { full: '伊沢なつめ', given: 'なつめ', family: '伊沢' },
  '018': { full: '琴平凪', given: '凪', family: '琴平' },
  '019': { full: '浜崎まほろ', given: 'まほろ', family: '浜崎' },
  '020': { full: '和泉朋花', given: '朋花', family: '和泉' },
  '021': { full: '須賀蕾叶', given: '蕾叶', family: '須賀' },
  '022': { full: '馬橋心玖', given: '心玖', family: '馬橋' },
  '023': { full: '矢倉蓬咲', given: '蓬咲', family: '矢倉' },
  '024': { full: '梅里ちえり', given: 'ちえり', family: '梅里' },
  '025': { full: '四宮寧月', given: '寧月', family: '四宮' },
};

/** Kana readings of the official names (萌娘百科 「本名」), for the keys in `JA_NAMES`. Note 要楽奈 is らーな, not らくな. */
export const JA_NAME_KANA: Record<string, { family: string; given: string }> = {
  '001': { family: 'たかまつ', given: 'ともり' },
  '002': { family: 'ちはや', given: 'あのん' },
  '003': { family: 'かなめ', given: 'らーな' },
  '004': { family: 'ながさき', given: 'そよ' },
  '005': { family: 'しいな', given: 'たき' },
  '006': { family: 'みすみ', given: 'ういか' },
  '007': { family: 'わかば', given: 'むつみ' },
  '008': { family: 'やはた', given: 'うみり' },
  '009': { family: 'ゆうてんじ', given: 'にゃむ' },
  '010': { family: 'とがわ', given: 'さきこ' },
  '011': { family: 'なかまち', given: 'あられ' },
  '012': { family: 'みやなが', given: 'ののか' },
  '013': { family: 'みねつき', given: 'りつ' },
  '014': { family: 'ふじ', given: 'みやこ' },
  '015': { family: 'せんごく', given: 'ユノ' },
  '016': { family: 'しおみ', given: 'ほたる' },
  '017': { family: 'いざわ', given: 'なつめ' },
  '018': { family: 'ことひら', given: 'なぎ' },
  '019': { family: 'はまさき', given: 'まほろ' },
  '020': { family: 'いずみ', given: 'ほうか' },
  '021': { family: 'すが', given: 'らいか' },
  '022': { family: 'まはし', given: 'みく' },
  '023': { family: 'やくら', given: 'よもぎ' },
  '024': { family: 'うめざと', given: 'ちえり' },
  '025': { family: 'しのみや', given: 'しずく' },
};

/** Japanese (shinjitai) / traditional kanji -> the simplified form the data file uses, for the characters that occur in names. */
export const KANJI_TO_SIMPLIFIED: Record<string, string> = {
  燈: '灯', 愛: '爱', 楽: '乐', 樂: '乐', 豊: '丰', 豐: '丰', 葉: '叶', 長: '长', 鈴: '铃', 華: '华', 蛍: '萤', 螢: '萤', 沢: '泽', 澤: '泽',
  須: '须', 浜: '滨', 濱: '滨', 馬: '马', 宮: '宫', 寧: '宁', 倉: '仓', 櫻: '樱', 桜: '樱', 憂: '忧', 響: '响', 紗: '纱', 莉: '莉', 麦: '麦', 麥: '麦',
  龍: '龙', 竜: '龙', 鳥: '鸟', 鷗: '鸥', 嶋: '岛', 島: '岛', 綾: '绫', 眞: '真', 凛: '凛', 瀬: '濑', 薫: '薰', 彩: '彩', 蘭: '兰', 巴: '巴',
  與: '与', 条: '条', 條: '条', 広: '广', 廣: '广', 関: '关', 關: '关', 辺: '边', 邊: '边', 渡: '渡', 実: '实', 實: '实', 歌: '歌', 晴: '晴', 夢: '梦',
};
