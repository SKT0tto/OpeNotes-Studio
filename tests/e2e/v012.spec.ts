/**
 * v0.1.2 in a real browser, on a real AI-generated project (tests/fixtures/ai-generated-project.json):
 *  1. every visible character is moving (motion queue running, parameters changing) at every sampled moment of every scene,
 *     including the live-mode performance scene, long after the instrument one-shots would have ended;
 *  2. an actor whose motions were stopped comes back to its idle by itself;
 *  3. jumping to another beat / scene in the editor never shows an empty stage (the previous frame stays until the new one is ready).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import './helpers/studio';

test.setTimeout(420_000);

const FIXTURE = fileURLToPath(new URL('../fixtures/ai-generated-project.json', import.meta.url));
const MOTION_PARAMS = ['ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleY', 'ParamBodyAngleZ', 'ParamEyeLOpen', 'ParamArmLA', 'ParamBrowLY'];

async function importProject(request: APIRequestContext): Promise<string> {
  const project = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { id: string; title: string };
  project.id = `p_e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  project.title = `v012-e2e ${Date.now()}`;
  const res = await request.post('/api/projects', { data: project });
  expect(res.ok(), 'fixture project is accepted by the server').toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function ready(page: Page) {
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 240_000 });
}
const idle = (page: Page) => expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 90_000 }).toBe(false);

/** Seek, run the clock for `seconds` and report, for every character that stayed on screen, how much its pose moved. */
async function sampleMotion(page: Page, t: number, seconds = 3) {
  await page.evaluate((x) => window.__studio.player!.seek(x), t);
  await idle(page);
  await page.evaluate(() => window.__studio.player!.play());
  const out = await page.evaluate(
    async ({ seconds: secs, ids }) => {
      const st = window.__studio;
      const seen = new Map<string, { model: string; n: number; running: number; lo: Record<string, number>; hi: Record<string, number> }>();
      const t0 = performance.now();
      let frames = 0;
      while (performance.now() - t0 < secs * 1000) {
        const probe = st.stageProbe()!;
        const state = st.player!.state()!;
        frames++;
        for (const cast of probe.people) {
          const a = state.actors.find((x) => x.castId === cast)!;
          if (a.opacity < 0.5) continue;
          const e = seen.get(cast) ?? { model: a.modelId, n: 0, running: 0, lo: {}, hi: {} };
          e.n++;
          if (st.getActorMotion(a.modelId).running) e.running++;
          const p = st.getActorParams(a.modelId, ids);
          for (const id of ids) {
            const v = p[id]!.applied;
            if (v === null || v === undefined) continue;
            e.lo[id] = Math.min(e.lo[id] ?? v, v);
            e.hi[id] = Math.max(e.hi[id] ?? v, v);
          }
          seen.set(cast, e);
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      return { frames, actors: [...seen.entries()].map(([cast, e]) => ({ cast, model: e.model, n: e.n, running: e.running, spread: Math.max(0, ...ids.map((id) => (e.hi[id] ?? 0) - (e.lo[id] ?? 0))) })) };
    },
    { seconds, ids: MOTION_PARAMS },
  );
  await page.evaluate(() => window.__studio.player!.pause());
  return out;
}

test('every visible character of a generated project moves, in every scene, early and late', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const id = await importProject(request);
  try {
    await page.goto(`/play/${id}`);
    await ready(page);
    const starts = await page.evaluate(() => window.__studio.player!.sceneStarts());
    const duration = await page.evaluate(() => window.__studio.player!.duration());
    let checked = 0;
    for (let i = 0; i < starts.length; i++) {
      const end = starts[i + 1] ?? duration;
      // early in the scene and as late as possible (the live-mode instrument one-shots are long over by then)
      for (const t of [starts[i]! + 5, end - 5]) {
        if (t < starts[i]! + 2) continue;
        const r = await sampleMotion(page, t);
        expect(r.actors.length, `someone is on screen at ${t.toFixed(1)} s (scene ${i + 1})`).toBeGreaterThan(0);
        for (const a of r.actors) {
          if (a.n < 8) continue; // only characters that stayed on screen for the whole window
          checked++;
          expect(a.running / a.n, `scene ${i + 1} @${t.toFixed(1)} s: ${a.cast} (${a.model}) has a running motion`).toBeGreaterThan(0.95);
          expect(a.spread, `scene ${i + 1} @${t.toFixed(1)} s: ${a.cast} (${a.model}) moved`).toBeGreaterThan(0.01);
        }
      }
    }
    expect(checked, 'enough character windows were checked').toBeGreaterThanOrEqual(starts.length);
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});

test('a character whose motions were stopped is back in motion by itself within a moment', async ({ page, request }) => {
  const id = await importProject(request);
  try {
    await page.goto(`/play/${id}`);
    await ready(page);
    const starts = await page.evaluate(() => window.__studio.player!.sceneStarts());
    await page.evaluate((x) => window.__studio.player!.seek(x), starts[starts.length - 1]! + 11); // the performance scene, after the instrument one-shots would have ended
    await idle(page);
    const models = await page.evaluate(() => window.__studio.stageProbe()!.people.map((c) => window.__studio.player!.state()!.actors.find((a) => a.castId === c)!.modelId));
    expect(models.length).toBeGreaterThan(0);
    const r = await page.evaluate(async (ids) => {
      const st = window.__studio;
      const out: Array<{ model: string; stopped: boolean; backAfterMs: number }> = [];
      for (const m of ids) {
        st.stopActorMotion(m);
        const stopped = !st.getActorMotion(m).running; // synchronously after the stop: nothing runs
        const t0 = performance.now();
        while (!st.getActorMotion(m).running && performance.now() - t0 < 3000) await new Promise((res) => requestAnimationFrame(() => res(null)));
        out.push({ model: m, stopped, backAfterMs: st.getActorMotion(m).running ? performance.now() - t0 : -1 });
      }
      return out;
    }, models);
    for (const x of r) {
      expect(x.stopped, `${x.model}: motions really were stopped`).toBe(true);
      expect(x.backAfterMs, `${x.model}: idle restarted by itself`).toBeGreaterThanOrEqual(0);
      expect(x.backAfterMs, `${x.model}: within a moment`).toBeLessThan(1500);
    }
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});

test('jumping to another beat or scene in the editor never shows an empty stage', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  const id = await importProject(request);
  try {
    await page.goto(`/editor/${id}`);
    await ready(page);
    const beats = await page.evaluate(() => {
      const p = window.__studio.player!;
      const starts = p.sceneStarts();
      const all = Object.entries(p.beatStarts()).sort((a, b) => a[1] - b[1]);
      // the second beat of each scene (after the scene's own lead-in, with people in front of the camera)
      return starts.map((s, i) => all.filter(([, t]) => t >= s && t < (starts[i + 1] ?? Infinity))[1]![0]);
    });
    expect(beats.length).toBeGreaterThanOrEqual(3);
    await page.getByTestId(`outline-beat-${beats[0]}`).click();
    await idle(page);
    await page.waitForTimeout(600);
    // sample the canvas and the stage every animation frame
    await page.evaluate(() => {
      const w = window as unknown as { __f: { n: number; hidden: number; noPeople: number; black: number }; __stop?: boolean };
      w.__f = { n: 0, hidden: 0, noPeople: 0, black: 0 };
      w.__stop = false;
      const probe = document.createElement('canvas');
      probe.width = 32;
      probe.height = 18;
      const ctx = probe.getContext('2d', { willReadFrequently: true })!;
      const tick = () => {
        const pr = window.__studio.stageProbe();
        const c = document.querySelector<HTMLCanvasElement>('[data-testid=play-canvas]');
        if (pr && c) {
          ctx.drawImage(c, 0, 0, 32, 18);
          const d = ctx.getImageData(0, 0, 32, 18).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i]! + d[i + 1]! + d[i + 2]!;
          w.__f.n++;
          if (!pr.sceneVisible) w.__f.hidden++;
          if (pr.people.length === 0) w.__f.noPeople++;
          if (sum / (32 * 18 * 3) < 2) w.__f.black++;
        }
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // far jumps first (cold scenes), then back, then within one scene
    const route = [beats[beats.length - 1], beats[1], beats[Math.floor(beats.length / 2)], beats[0], beats[2]];
    for (const b of route) {
      await page.getByTestId(`outline-beat-${b!}`).click();
      await idle(page);
      await page.waitForTimeout(500);
      const t = await page.evaluate(() => window.__studio.player!.time());
      const want = await page.evaluate((x) => window.__studio.player!.beatStarts()[x]!, b!);
      expect(t, `landed on beat ${b}`).toBeGreaterThanOrEqual(want - 0.01);
    }
    const f = await page.evaluate(() => {
      const w = window as unknown as { __f: { n: number; hidden: number; noPeople: number; black: number }; __stop?: boolean };
      w.__stop = true;
      return w.__f;
    });
    expect(f.n, 'frames were sampled').toBeGreaterThan(60);
    expect(f.hidden, 'frames with the scene hidden').toBe(0);
    expect(f.noPeople, 'frames with a background and nobody on it').toBe(0);
    expect(f.black, 'all-black frames').toBe(0);
    // the timeline lists the rule director's reaction keys as ghost keys: their ids must be unique (React key warnings land here)
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});
