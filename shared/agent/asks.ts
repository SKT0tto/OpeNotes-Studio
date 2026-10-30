/**
 * What the user's own words ask for, decided on the server (not by the model): cutting a line into several beats, and showing a line in
 * full beyond the dialogue area's lines. The assistant's `beat_split_pieces` / `beat_split` and `dialog_expand` ops are rejected by
 * `checkOp` unless the matching flag is set, so an unrelated edit can never split or expand a line "on the side", also through
 * `batch_edit` and `run_script` (every op they produce goes through the same check).
 *
 * The expressions are moderate on purpose: a miss is cheap (the assistant says so and asks; the next turn's short 「好 / 要」 reply is
 * read against that question, see `requestFlags`), a false hit lets the model do something the user did not ask for.
 */

/** Text inside quotation marks is a line of the story being quoted, not an instruction (「把“拆开”改成…」). */
const QUOTED = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|《[^》]*》/g;
const withoutQuotes = (s: string): string => s.replace(QUOTED, '');

/** An explicit cut: 拆开 / 拆成两句 / 断开 / 分成两句 / 分三段 / 切成两句 / 断句 / 拆一下 ... */
const SPLIT_VERB = /拆(开|分|成|一下|下|句|掉|短)|拆$|断开|断成|断句|分句|切成|切开|(分|分成|分为|断成)(两|二|三|四|几|多|2|3|4)(句|段|行|拍|次)|分(两|二|三|四)(句|段|行|拍)|一分为(二|两)|(两|二|三|四)句(话)?来(说|读)/;
/** The overflow complaint: the text does not fit the dialogue box. */
const OVERFLOW = /(放不下|装不下|显示不全|显示不完|看不全|看不完|被截(断|掉|了)?|超出(了)?(对话框|对话区|屏幕|画面|两行|范围|框)|超过(了)?(两|二|2)行|溢出|(过|太|超)长)/;
/** A request to deal with it (not just to move on): 修 / 处理 / 解决 / 搞定 / 整理. 改 / 调 are too generic (改短 is a rewrite). */
const FIX_VERB = /(修|处理|解决|搞定|整理|弄)(一下|下|好|掉)?/;

/** Does the user ask for a line to be cut into consecutive beats? */
export function asksForLineSplit(userText: string): boolean {
  const t = withoutQuotes(userText.replace(/^[\s\S]*用户的指令：/, ''));
  if (!t.trim()) return false;
  if (SPLIT_VERB.test(t)) return true;
  // 「过长的台词都修一下」「放不下的那几句处理一下」: a complaint about the length plus a request to fix it, no rewriting verb
  return OVERFLOW.test(t) && FIX_VERB.test(t) && !/([改弄变调写]短|缩短|精简|删(掉|减|去)|压缩|简化|改写|重写)/.test(t);
}

/** Does the user ask for a line to be shown in full, past the dialogue area's lines? */
const EXPAND_NEAR = '(句|台词|对话|文字|字幕|行|显示|全部|完整|整)';
const EXPAND_WORD = new RegExp(`${EXPAND_NEAR}.{0,6}展开|展开.{0,6}${EXPAND_NEAR}`);
const SHOW_ALL = /(完整|全部|整句|整段|所有文字|全文)显示|显示(完整|全部(?!角色|人物|人|场景|背景)|整句|整段|整个台词|全文|所有(文字|台词|内容))|全显示|撑开|对话框.{0,4}(放大|变大|加高|加长|撑)/;
const MORE_ROWS = /(多|再多|多多)显示(几|一|两|三|四|\d)行|显示(三|四|五|六|3|4|5|6)行|(三|四|五|六|3|4|5|6)行(也)?(可以|没关系|没事|行|都行)/;
const OVERRUN_OK = /超出.{0,6}(屏幕|画面|对话框|对话区|框|两行|范围).{0,4}(也行|也可以|也没关系|没关系|无所谓|不要紧|没事|可以)|超出.{0,4}(也行|也可以|也没关系|没关系|无所谓)/;

export function asksForDialogExpand(userText: string): boolean {
  const t = withoutQuotes(userText.replace(/^[\s\S]*用户的指令：/, ''));
  if (!t.trim()) return false;
  return EXPAND_WORD.test(t) || SHOW_ALL.test(t) || MORE_ROWS.test(t) || OVERRUN_OK.test(t);
}

/** A short 「好 / 要 / 可以 / 拆吧」 reply: it answers the question the assistant asked in the previous turn. */
const AFFIRM = /^[\s，。！!~～]*(好(的|啊|吧|呀)?|要(的|吧)?|可以(的|吧)?|行(吧|啊)?|嗯+|是(的|啊)?|对(的|啊)?|拆吧|拆|展开吧|展开|就这样|照做|去吧|ok|yes|y)[\s，。！!~～]*$/i;

export interface RequestFlags {
  lineSplit: boolean;
  dialogExpand: boolean;
}

/**
 * The flags of one turn: the instruction itself, or a short 「好」 to the assistant's own question of the previous turn
 * (「要不要把这句拆开？」 / 「要不要展开显示？」), which is how a missed phrasing is recovered.
 */
export function requestFlags(instruction: string, history: ReadonlyArray<{ role: string; content: string }> = []): RequestFlags {
  const own = { lineSplit: asksForLineSplit(instruction), dialogExpand: asksForDialogExpand(instruction) };
  if (own.lineSplit && own.dialogExpand) return own;
  const text = instruction.replace(/^[\s\S]*用户的指令：/, '').trim();
  if (!AFFIRM.test(text)) return own;
  const lastAssistant = [...history].reverse().find((h) => h.role === 'assistant')?.content ?? '';
  const q = /[?？]\s*$/.test(lastAssistant.trim()) || /(要不要|是否|需要我|要我|可以吗|好吗|吗[？?])/.test(lastAssistant);
  if (!q) return own;
  const tail = lastAssistant.slice(-200);
  return {
    lineSplit: own.lineSplit || /拆|断开|分成|分句|分两句/.test(tail),
    dialogExpand: own.dialogExpand || /展开|完整显示|全部显示|显示全部/.test(tail),
  };
}
