import { describe, expect, it } from 'vitest';
import { OURNOTES_STYLE } from '@shared/style/ournotes';
import { fitsDialog } from '@shared/style/dialogLayout';
import { checkPieces, minPiecesFor, splitForDialog, wrapperOf } from '@shared/director/splitLines';

const D = OURNOTES_STYLE.dialog;
const han = (n: number) => '字'.repeat(n);

// AI-written lines (none of them comes from a maintainer's project)
const LINES: Record<string, string> = {
  confess: '我本来想跟你说，我早就一点都不在意了，反正那都是很久以前的事。可是看到你把那张旧照片一直夹在笔记本里……我就再也装不下去了。对不起，我其实一直都很想你。',
  monologue: '（明明只要说一句「我也想去」就好了，为什么每次话到嘴边，都会变成「随便你们」呢……这样下去，大家迟早会连问都不再问我了吧。我真是个笨蛋。）',
  excited: '好耶！终于订到排练室了！周六下午两点到六点，四个小时整整的！……啊，等一下，那天好像是小秋的补习日来着？完了完了，我得赶紧去问问她。',
  bravado: '所以说，为了能在文化祭上把那首新歌完整地弹下来，我决定从明天开始每天早上六点起床练琴，一天都不偷懒！……不过，闹钟响的时候我真的爬得起来吗。',
  list: '先把鼓的位置往左挪一点，然后键盘放到窗边，音箱靠墙，线全部从后面走，这样大家站进来的时候就不会被绊到了，最后再把灯调暗一点就好。',
  rain: '雨下了整整一个下午，排练室的窗户上全是水痕。谁都没有提起昨天的争吵，只有节拍器还在角落里一下一下地响着，像是在替她们数着沉默。',
  nopunct: '就这样吧我们明天见路上小心别忘了把谱子带上还有那个效果器也是上次你忘在我家了我妈还以为是什么奇怪的机器差点就拿去扔掉了你说好不好笑',
  mixed: '今天的LIVE真的太棒了！最后一首的时候整个场子都在跟着唱，我在台上差点哭出来～下次一定要把这首歌也放进setlist里，绝对！',
  short: '我想再试一次。',
  quote: '「如果我们解散了，你会难过吗」——她当时是这么问我的。我笑着说当然不会啊，怎么可能呢。可是那天回家的路上，我一个人在车站坐了很久很久。',
  shock: '等、等一下！你是说那个在网上翻唱我们歌的人，其实就是隔壁班的转学生——！？骗人的吧，她明明每次在走廊上见到我，都一副完全不认识的样子……',
};

const run = (t: string, variant: 'normal' | 'monologue' | 'offscreen' = 'normal') => {
  const r = splitForDialog(t, D, variant);
  return { r, c: checkPieces(t, r.pieces, D, variant) };
};

describe('splitForDialog', () => {
  it('a line that fits comes back unchanged (even exactly two lines)', () => {
    expect(splitForDialog(LINES.short!, D).pieces).toEqual([LINES.short]);
    expect(splitForDialog(han(62), D).pieces).toEqual([han(62)]);
    expect(splitForDialog(han(63), D).pieces).toHaveLength(2);
  });

  it('every sample splits into pieces that pass checkPieces', () => {
    for (const [name, t] of Object.entries(LINES)) {
      const { r, c } = run(t);
      expect(c.problems, name).toEqual([]);
      expect(c.ok, name).toBe(true);
      for (const p of r.pieces) expect(fitsDialog(p, D).over, name).toBe(false);
    }
  });

  it('uses the pause: …… before a turn, 。 for explanation', () => {
    expect(run(LINES.bravado!).r.pieces).toEqual([
      '所以说，为了能在文化祭上把那首新歌完整地弹下来，我决定从明天开始每天早上六点起床练琴，一天都不偷懒！……',
      '不过，闹钟响的时候我真的爬得起来吗。',
    ]);
    expect(run(LINES.excited!).r.pieces[0]!.endsWith('四个小时整整的！……')).toBe(true);
    expect(run(LINES.confess!).r.pieces[0]!.endsWith('很久以前的事。')).toBe(true);
  });

  it('a thin tail (4-5 characters) is avoided when a pause elsewhere exists: 「告诉我吧。」 stays with the question before it', () => {
    const t = '你刚才说「没关系」的时候，眼睛一直在看别的地方。我认识你多少年了，这种程度的谎话我怎么可能看不出来。所以，到底发生了什么？告诉我吧。';
    const { r, c } = run(t);
    expect(c.ok).toBe(true);
    expect(r.pieces).toHaveLength(2);
    expect(r.pieces[0]!.endsWith('看不出来。')).toBe(true);
    expect(r.pieces[1]).toBe('所以，到底发生了什么？告诉我吧。');
    // no sample is cut into a piece of fewer than 6 characters
    for (const [name, x] of Object.entries(LINES)) for (const p of run(x).r.pieces) expect([...p].filter((ch) => !/[，。、！？…—（）「」]/.test(ch)).length, name).toBeGreaterThanOrEqual(6);
  });

  it('a thin tail is still taken when every other cut is worse (a width break costs more)', () => {
    const t = `${han(60)}好不好呀，${han(2)}`;
    expect(run(t).c.ok).toBe(true);
  });

  it('a list without a turn is cut at a comma into two even-ish halves', () => {
    const { r } = run(LINES.list!);
    expect(r.pieces).toHaveLength(2);
    expect(r.pieces[0]!.endsWith('，')).toBe(true);
    expect(Math.abs([...r.pieces[0]!].length - [...r.pieces[1]!].length)).toBeLessThan(20);
  });

  it('never cuts inside 「」 and keeps …… together', () => {
    for (const name of ['monologue', 'quote', 'shock', 'confess'] as const) {
      const { r } = run(LINES[name]!);
      for (const p of r.pieces) {
        const inner = wrapperOf(p) ? wrapperOf(p)!.inner : p;
        expect((inner.match(/「/g) ?? []).length, `${name}: ${p}`).toBe((inner.match(/」/g) ?? []).length);
        expect(/^…(?!…)/.test(inner) || /(?<!…)…$/.test(inner)).toBe(false);
        expect(/^—(?!—)/.test(inner) || /(?<!—)—$/.test(inner)).toBe(false);
      }
    }
  });

  it('a wrapped monologue: every piece is wrapped by the same pair', () => {
    const { r } = run(LINES.monologue!);
    expect(r.pieces.length).toBeGreaterThan(1);
    for (const p of r.pieces) {
      expect(p.startsWith('（') && p.endsWith('）')).toBe(true);
      expect(wrapperOf(p)).not.toBeNull();
    }
    expect(r.pieces.map((p) => p.slice(1, -1)).join('')).toBe(LINES.monologue!.slice(1, -1));
  });

  it('variant monologue: the brackets the box adds are part of the measurement (2em)', () => {
    const m = splitForDialog(han(60) + '。', D, 'monologue');
    expect(m.pieces.length).toBeGreaterThanOrEqual(2);
    for (const p of m.pieces) expect(fitsDialog(p, D, 'monologue').over).toBe(false);
  });

  it('no punctuation at all: a width break with a warning, still valid', () => {
    const { r, c } = run(LINES.nopunct!);
    expect(r.hardBreak).toBe(true);
    expect(r.warnings.join('')).toMatch(/硬断/);
    expect(c.ok).toBe(true);
    for (const p of r.pieces) expect(/^[，。！？」）]/.test(p)).toBe(false);
  });

  it('mixed Latin keeps words whole when a pause exists', () => {
    const t = LINES.mixed!.replace('绝对！', '绝对！下次我们还要一起去看另一场现场演出，到时候你一定要来哦！');
    const { r, c } = run(t);
    expect(c.ok).toBe(true);
    expect(r.pieces.join('')).toBe(t);
    expect(r.pieces.some((p) => p.includes('setlist'))).toBe(true);
    expect(r.pieces.some((p) => p.includes('LIVE'))).toBe(true);
  });

  it('is deterministic', () => {
    for (const t of Object.values(LINES)) expect(splitForDialog(t, D)).toEqual(splitForDialog(t, D));
  });

  it('respects a different maxLines (3): the same text needs fewer pieces', () => {
    const style = { ...D, maxLines: 3 };
    expect(splitForDialog(LINES.confess!, style).pieces).toHaveLength(1);
    expect(splitForDialog(han(100) + '。' + han(100), style).pieces.length).toBeGreaterThanOrEqual(2);
  });

  it('author newlines survive inside a piece', () => {
    const t = '第一行\n第二行，' + han(60) + '。';
    const { r, c } = run(t);
    expect(c.ok).toBe(true);
    expect(r.pieces.join('')).toContain('第一行\n第二行');
  });

  it('property: any generated text splits into valid pieces with the exact same text', () => {
    // a small deterministic generator (LCG), no Math.random
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const frags = ['你好', '今天', '我们', '一起去', '看看', 'LIVE', 'setlist', '，', '。', '！', '？', '……', '——', '「真的吗」', '（小声）', '不过', '啊', ' ', '\n', 'ー', '～'];
    for (let n = 0; n < 80; n++) {
      let t = '';
      const len = 20 + Math.floor(rnd() * 90);
      for (let i = 0; i < len; i++) t += frags[Math.floor(rnd() * frags.length)];
      if (rnd() < 0.2) t = `（${t}）`;
      if (rnd() < 0.1) t = `「${t}」`;
      for (const variant of ['normal', 'monologue'] as const) {
        const r = splitForDialog(t, D, variant);
        if (!fitsDialog(t, D, variant).over) {
          expect(r.pieces).toEqual([t]);
          continue;
        }
        const c = checkPieces(t, r.pieces, D, variant);
        expect(c.problems, JSON.stringify({ t, variant, pieces: r.pieces })).toEqual([]);
        const strip = (s: string) => s.replace(/[\s\u3000]/g, '');
        const unwrap = (s: string) => (wrapperOf(s) ? wrapperOf(s)!.inner : s);
        const joined = wrapperOf(t) ? r.pieces.map((p) => p.slice(1, -1)).join('') : r.pieces.join('');
        expect(strip(joined)).toBe(strip(unwrap(t)));
      }
    }
  }, 30000);
});

describe('checkPieces', () => {
  const t = LINES.bravado!;
  const good = ['所以说，为了能在文化祭上把那首新歌完整地弹下来，我决定从明天开始每天早上六点起床练琴，一天都不偷懒！……', '不过，闹钟响的时候我真的爬得起来吗。'];

  it('accepts a faithful split', () => {
    const c = checkPieces(t, good, D);
    expect(c).toMatchObject({ ok: true, problems: [], minPieces: 2, maxPieces: 3 });
    expect(c.lines.every((n) => n <= 2)).toBe(true);
  });
  it('ignores whitespace at the cuts and around the line', () => {
    expect(checkPieces(`  ${t} `, [` ${good[0]}`, `\u3000${good[1]}\n`], D).ok).toBe(true);
  });
  it('rejects a changed, dropped or added character, and says where', () => {
    const changed = checkPieces(t, [good[0]!, good[1]!.replace('闹钟', '闹铃')], D);
    expect(changed.ok).toBe(false);
    expect(changed.problems[0]).toMatch(/与原文/);
    expect(checkPieces(t, [good[0]!, good[1]!.slice(0, -1)], D).problems.join('')).toMatch(/漏了/);
    expect(checkPieces(t, [good[0]!, good[1]! + '的'], D).problems.join('')).toMatch(/多出/);
    expect(checkPieces(t, [good[0]!.replace('！……', '！'), good[1]!], D).ok).toBe(false);
    expect(checkPieces(t, [good[0]!, good[0]!, good[1]!], D).ok).toBe(false);
  });
  it('rejects a piece that does not fit', () => {
    const c = checkPieces(han(130), [han(70), han(60)], D);
    expect(c.ok).toBe(false);
    expect(c.problems.join('')).toMatch(/超出 2 行/);
  });
  it('count: at least the minimum, at most minimum + 1', () => {
    expect(checkPieces(han(100), [han(100)], D).ok).toBe(false);
    const four = [han(25), han(25), han(25), han(25)];
    expect(checkPieces(han(100), four, D).problems.join('')).toMatch(/最多/);
    expect(checkPieces(han(100), four, D, 'normal', { maxExtra: 2 }).ok).toBe(true);
    expect(checkPieces(han(100), four, D, 'normal', { maxExtra: 2, maxPieces: 3 }).ok).toBe(false);
    expect(checkPieces(han(100), [han(50), han(50)], D).ok).toBe(true);
    expect(checkPieces(han(100), [han(40), han(30), han(30)], D).ok).toBe(true);
  });
  it('a line that fits must not be split', () => {
    expect(checkPieces('我想再试一次。', ['我想再试', '一次。'], D).problems.join('')).toMatch(/不应该拆/);
    expect(checkPieces('我想再试一次。', ['我想再试一次。'], D).ok).toBe(true);
  });
  it('rejects empty pieces and an empty answer', () => {
    expect(checkPieces(t, [good[0]!, '  ', good[1]!], D).problems.join('')).toMatch(/空/);
    expect(checkPieces(t, [], D).ok).toBe(false);
  });
  it('wrapped text: missing brackets are added back (a repair, not an error); extra text is an error', () => {
    const m = LINES.monologue!;
    const inner = m.slice(1, -1);
    const cut = inner.indexOf('吧。') + 2;
    const c = checkPieces(m, [inner.slice(0, cut), inner.slice(cut)], D);
    expect(c.ok).toBe(true);
    expect(c.repairs.length).toBe(2);
    expect(c.pieces).toEqual([`（${inner.slice(0, cut)}）`, `（${inner.slice(cut)}）`]);
    const wrapped = checkPieces(m, [`（${inner.slice(0, cut)}）`, `（${inner.slice(cut)}）`], D);
    expect(wrapped.ok).toBe(true);
    expect(wrapped.repairs).toEqual([]);
    expect(checkPieces(m, [`（${inner.slice(0, cut)}）`, `（${inner.slice(cut)}了）`], D).ok).toBe(false);
  });
  it('monologue variant: the 2em of brackets count toward the fit', () => {
    const t2 = han(62) + han(60);
    expect(checkPieces(t2, [han(62), han(60)], D, 'normal').ok).toBe(true);
    expect(checkPieces(t2, [han(62), han(60)], D, 'monologue').problems.join('')).toMatch(/超出/);
  });
  it('minPiecesFor: the fewest pieces any legal cut allows', () => {
    expect(minPiecesFor(han(62), D)).toBe(1);
    expect(minPiecesFor(han(63), D)).toBe(2);
    expect(minPiecesFor(han(130), D)).toBe(3);
  });
});
