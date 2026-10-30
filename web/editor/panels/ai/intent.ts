/**
 * Typed commands that mean exactly one of the generation actions. Deliberately conservative: only a WHOLE sentence that matches (after trimming
 * spaces and 。！!～~ at the ends) is routed; anything with more in it (「节奏慢一点」, 「多用双人」, 「镜头」…) goes to the assistant as usual. The
 * panel shows a one-click 「改成发给 AI」 under a routed command, so a wrong guess costs one click. Pure.
 */

export type Intent =
  | { kind: 'scene' }
  | { kind: 'sceneNo'; no: number }
  | { kind: 'all' }
  | { kind: 'fresh' };

const DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「3」 / 「三」 / 「十」 / 「十二」 / 「二十一」 → number (1–99), NaN when it is neither. */
export function parseSceneNo(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m && (m[1] || m[2])) return (m[1] ? DIGITS[m[1]]! : 1) * 10 + (m[2] ? DIGITS[m[2]]! : 0);
  if (s.length === 1 && DIGITS[s]) return DIGITS[s]!;
  return NaN;
}

const SCENE = /^(请)?(帮我)?(重新)?生成(一下)?(这一?场|本场|当前场景?)$/;
const SCENE_NO = /^(请)?(重新)?生成第([一二两三四五六七八九十\d]+)场$/;
const ALL = /^(请)?(重新)?生成(全部|所有)场景?(的演出)?$/;
const FRESH = /^换一版$/;

/**
 * `sceneCount`: the project's scenes (a scene number that does not exist is not routed). `hasPrevious`: there is an earlier generation turn
 * whose request 「换一版」 can repeat.
 */
export function routeIntent(text: string, ctx: { sceneCount: number; hasPrevious: boolean }): Intent | null {
  const t = text.trim().replace(/^[。！!～~\s]+|[。！!～~\s]+$/g, '');
  if (!t) return null;
  if (SCENE.test(t)) return { kind: 'scene' };
  const n = SCENE_NO.exec(t);
  if (n) {
    const no = parseSceneNo(n[3]!);
    return Number.isInteger(no) && no >= 1 && no <= ctx.sceneCount ? { kind: 'sceneNo', no } : null;
  }
  if (ALL.test(t)) return { kind: 'all' };
  if (FRESH.test(t)) return ctx.hasPrevious ? { kind: 'fresh' } : null;
  return null;
}
