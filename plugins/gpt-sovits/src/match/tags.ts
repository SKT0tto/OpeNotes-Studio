/**
 * Bare emotion tags at the start of a reference file name: `叙述ほんと。わたしもわかる` -> tag `叙述`, text `ほんと。わたしもわかる`.
 * The vocabulary is matched longest-first and repeatedly (`回忆叙述`, `叙述，提示`), so real Japanese that follows (`楽奈ちゃん`) is never cut.
 */

const VOCAB = [
  '叙述', '疑问', '感叹', '开心', '兴奋', '犹豫', '烦恼', '吐槽', '交谈', '交流', '交心', '疑惑', '关心', '关切', '公关', '列举', '劝告', '劝导', '反问', '发牢骚',
  '发自内心', '发誓', '内心独白', '军训', '创可贴推销', '典中典', '否认', '确认', '哈？', '哭腔', '唐笑', '喃喃自语', '自言自语', '回忆', '大笑', '小震惊', '小疑问',
  '妈妈', '安慰', '客套', '微微低沉', '微笑赞叹', '念字', '思考', '总结', '悲伤', '惊慌失措', '惊讶', '震惊', '感谢与感叹', '吐槽与调侃', '生气与吐槽', '认可与确定',
  '疑问与反问', '试图引起注意', '紧急道歉', '真情吐露', '颤颤巍巍地吐露', '企鹅追人', '主唱太拼命了', '不演了', '不甘', '不自信', '重力展开', '重复他人之言', '愉快叙述', '正常叙述', '开朗',
  '标准', '温柔', '愤怒', '生气', '提议', '提醒', '提示', '无奈', '松口气', '渴望', '知晓', '经典', '给予', '自我沉浸', '赞叹', '赞同', '赞扬', '道歉', '邀请',
  '阅读', '领悟', '责难', '调侃', '困惑', '吐露', '叹气', '打招呼', '轻微', '轻视', '抗拒', '忠告', '惊慌', '需要拆分', '包含', '讲道理', '夹子音', '低沉',
].sort((a, b) => b.length - a.length);

/** Characters used in Simplified Chinese only (Japanese writes them differently), so a leading run containing one is not Japanese. */
const SIMPLIFIED_ONLY = new Set([...'这们说话无没对时过样让问见觉听关长开东车专实现动应为书设请语谁调论还间发经气爱吗贴难惊愤帮记给总结绝变边须页么别吧讲认确夹谈惯师选运连达进远队阳顺飞鸟齐龙门鱼马']);
/** Also ordinary Japanese words: only a tag at the very start or right after a separator, never glued behind another tag. */
const AMBIGUOUS = new Set(['交流', '思考', '困惑', '提示', '吐露']);
const SEPARATOR = /^[，,、]/;
const KANA = /[぀-ヿ]/;
const CJK_RUN = /^[㐀-鿿]+/;

export interface BareTag {
  tag: string;
  rest: string;
  /** A leading run of Chinese characters the vocabulary did not resolve and that contains simplified-only characters: the text is probably wrong. */
  suspect: boolean;
}

/** Splits leading bare tags off a file name that contains kana; names without kana are returned unchanged. */
export function splitBareTag(name: string): BareTag {
  if (!KANA.test(name)) return { tag: '', rest: name, suspect: false };
  const found: string[] = [];
  let rest = name.trim();
  let open = true; // the start, or right after a separator
  for (let guard = 0; guard < 8; guard++) {
    let hit = VOCAB.find((v) => rest.startsWith(v) && (open || !AMBIGUOUS.has(v)));
    if (!hit && found.length > 0 && open && /^笑[぀-ヿ]/.test(rest)) hit = '笑';
    if (!hit) break;
    found.push(hit);
    rest = rest.slice(hit.length);
    open = SEPARATOR.test(rest);
    if (open) rest = rest.slice(1);
  }
  const run = CJK_RUN.exec(rest)?.[0] ?? '';
  const suspect = [...run].some((c) => SIMPLIFIED_ONLY.has(c));
  return { tag: found.join('，'), rest: rest.trim(), suspect };
}
