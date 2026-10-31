import { expect, test, type Page } from '@playwright/test';
import { fitsDialog } from '../../shared/style/dialogLayout';
import { OURNOTES_STYLE } from '../../shared/style/ournotes';
import type { Project } from '../../shared/schema/project';
import { beatStart, openDemoEditor, settled } from './helpers/editor';

test.use({ viewport: { width: 1920, height: 1250 } });

const D = OURNOTES_STYLE.dialog;
const S = '今天的排练比我想的还要顺利，大家都把自己的部分练得很熟了，我真的很开心。';
// AI-written corpus: ordinary lines, Latin mixes, brackets, quotes, an author newline
const CORPUS = [
  '今天的排练比我想的还要顺利呢。',
  S + S.slice(0, 20) + '。',
  '今天的LIVE真的太棒了！最后一首的时候整个场子都在跟着唱，我在台上差点哭出来～下次一定要把这首歌也放进setlist里，绝对！',
  '「如果我们解散了，你会难过吗」——她当时是这么问我的。我笑着说当然不会啊，怎么可能呢。',
  '第一行\n第二行，' + S,
  S.repeat(3),
];

async function reload(page: Page, project: Project) {
  await page.evaluate((p) => window.__studio.player!.reload(p), project);
  await settled(page);
}
const beatIdsOf = (p: Project) => p.scenes[0]!.beats.filter((b) => b.kind === 'dialogue' && b.variant === 'normal').map((b) => b.id);

test('the dialogue box draws exactly the lines the shared layout computes (also expanded: down, up, scroll)', async ({ page }) => {
  await openDemoEditor(page, 'dialog-layout');
  const proj = (await page.evaluate(() => window.__studio.player!.project())) as Project;
  const ids = beatIdsOf(proj);
  const id = ids[0]!;
  const rowsOnScreen = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid=dialog] [data-part=text]') as HTMLElement;
    return { rows: el.textContent!.split('\n'), top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height, scrollH: el.scrollHeight };
  });
  const seekEnd = async (id: string, chars: number) => {
    const start = await beatStart(page, id);
    await page.evaluate((x) => window.__studio.player!.seek(x), start + chars / 10 + 0.8);
    await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 60_000 }).toBe(false);
    await page.waitForTimeout(250);
  };

  let baseTop = 0;
  for (const text of CORPUS) {
    const p = JSON.parse(JSON.stringify(proj)) as Project;
    const b = p.scenes[0]!.beats.find((x) => x.id === id)!;
    b.text = text;
    b.variant = 'normal';
    await reload(page, p);
    await seekEnd(id, [...text].length);
    const shown = await rowsOnScreen();
    const fit = fitsDialog(text, D, 'normal');
    // clipped (not expanded): the first maxLines lines, each exactly as laid out, no line wraps again in the DOM
    expect(shown.rows).toEqual(fit.rows.slice(0, D.maxLines).map((r) => r.text));
    expect(shown.height).toBeLessThanOrEqual((shown.rows.length + 0.5) * (45 / 1080) * (await page.getByTestId('play-stage').boundingBox())!.height);
    if (baseTop === 0) baseTop = shown.top;
    expect(Math.abs(shown.top - baseTop)).toBeLessThan(1);
  }

  const stageH = (await page.getByTestId('play-stage').boundingBox())!.height;
  const line = (45 / 1080) * stageH;
  for (const [text, lines] of [[S + S + S.slice(0, 8) + '。', 3], [S.repeat(3), 4], [S.repeat(4) + S.slice(0, 10) + '。', 5], [S.repeat(5) + S.slice(0, 16) + '。', 7]] as Array<[string, number]>) {
    expect(fitsDialog(text, D).lines).toBe(lines);
    const p = JSON.parse(JSON.stringify(proj)) as Project;
    const b = p.scenes[0]!.beats.find((x) => x.id === id)!;
    b.variant = 'normal';
    b.text = text;
    b.overflow = 'expand';
    await reload(page, p);
    await seekEnd(id, [...text].length);
    const shown = await rowsOnScreen();
    const sub = await page.evaluate(() => window.__studio.player!.state()!.subtitle);
    expect(sub?.expand).toBe(true);
    const all = fitsDialog(text, D).rows.map((r) => r.text);
    // up to 6 lines are all visible; beyond that the window shows the last six
    expect(shown.rows).toEqual(all.slice(-6));
    // 3 lines: grows down (top unchanged); 4..6: the area moves up by n-3 lines; 7+: capped at 3 lines up
    const up = Math.min(Math.max(lines, 3), 6) - 3;
    expect(shown.top).toBeCloseTo(baseTop - up * line, 0);
  }
});

test('regression of the width table: the browser own wrapping (explicit breaks off) gives the same line count as fitsDialog', async ({ page }) => {
  await openDemoEditor(page, 'dialog-layout-dom');
  const texts = [...CORPUS, '今天的排练比我想的还要顺利，'.repeat(2), '字'.repeat(62), '字'.repeat(63), '字'.repeat(31) + '。', 'a'.repeat(120), '今天的LIVE真的太棒了！'.repeat(4)];
  const dom = await page.evaluate((list) => {
    const stageH = document.querySelector('[data-testid=play-stage]')!.getBoundingClientRect().height;
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;left:0;top:0;visibility:hidden;width:${(1070 / 1080) * stageH}px;font-size:${(34 / 1080) * stageH}px;line-height:${(45 / 1080) * stageH}px;white-space:pre-wrap;word-break:break-all;font-family:"Noto Sans SC","Source Han Sans SC","HarmonyOS Sans SC","Microsoft YaHei UI","Microsoft YaHei","PingFang SC",sans-serif`;
    document.body.appendChild(probe);
    const out = list.map((t) => { probe.textContent = t; return Math.round(probe.getBoundingClientRect().height / ((45 / 1080) * stageH)); });
    probe.remove();
    return out;
  }, texts);
  expect(dom).toEqual(texts.map((t) => fitsDialog(t, D, 'normal').lines));
});

