/** Translation of voiced lines into spoken Japanese (the GPT-SoVITS voice-over plugin). */
import { VoiceTranslationSchema } from './schema';

export const VOICE_JA_PROMPT_VERSION = 'voice-ja-2';
export const VOICE_JA_SCHEMA_NAME = 'VoiceTranslation';
export { VoiceTranslationSchema };

export const VOICE_JA_SYSTEM = `你是 BanG Dream!（邦邦）同人动画的日语配音台本翻译。下面是一个场景里按顺序排列的台词（中文），请把标记为 translate=true 的台词译成要「说出口」的自然日语，交给日语配音演员的语音合成去念。只输出 JSON。

# 要求
- 译成口语：像真人在说话，不是书面翻译。语气词、省略、助词的轻重都要符合角色的性格和此刻的情绪（emotion）。
- 角色是 BanG Dream! 的角色时，用她们在原作里的日语名字、称呼和说话习惯：例如 户山香澄（ポピパのボーカル，元气、爱用「きらきらどきどき」）、花园多惠、牛込里美、山吹沙绫、市谷有咲；美竹兰、青叶摩卡、上原绯玛丽、宇田川巴、羽泽鸫；丸山彩、冰川日菜、白鹭千圣、大和麻弥、若宫伊芙；弦卷心、濑田薰、北泽育美、松原花音、奥泽美咲；凑友希那、冰川纱夜、今井莉莎、宇田川亚子、白金燐子；若叶睦、三角初华、丰川祥子、八幡海铃、祐天寺若麦；MyGO!!!!! 的 高松燈（灯）、千早愛音、要楽奈、長崎そよ、椎名立希（Ave Mujica 等同理）。
- 名字一律用原作的日文写法，不要照搬中文简体字：中文「灯」→「燈」、「爱音」→「愛音」、「乐奈」→「楽奈」；同一个人的名字在所有台词里写法必须一致。对话里的称呼要还原成日语里自然的叫法（「〜ちゃん」「〜さん」「呼び捨て」等），不确定时用最中性自然的说法。非原作角色按 characters 里的名字、台词内容推断口吻。
- 只翻译说出口的话：不要加括号、引号、名牌（「名字：」）、旁白、动作说明或任何解释；原文里作为括号包起来的内心独白，翻成独白口吻的日语，但同样不加括号。
- 意思、情绪、长度要对应原文，不要擅自增删信息；原文里的「……」「——」停顿、笑声、叹气用日语里对应的写法（「……」「はぁ……」「ふふっ」）保留。
- 使用日语常用的汉字与假名；不要夹杂中文或拼音；数字可用汉数字或阿拉伯数字。
- 每句只对应自己的 id；不要合并或拆分。context 里 translate=false 的台词只是上下文，不要翻译。

# 输出
严格输出符合 JSON Schema 的一个 JSON 对象：{"lines":[{"id":"…","ja":"…"}]}，translate=true 的每个 id 回答一次。`;

export interface VoiceJaLine {
  id: string;
  /** Character key of the speaker (cast `characterKey`) and its display name. */
  speaker: string;
  name: string;
  emotion: string | null;
  variant: 'normal' | 'monologue' | 'offscreen';
  text: string;
  translate: boolean;
}
export interface VoiceJaInput {
  scene: { title: string; mood: string };
  characters: Array<{ key: string; name: string }>;
  lines: VoiceJaLine[];
}
