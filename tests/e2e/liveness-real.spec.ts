/**
 * v0.1.4: nobody on stage is frozen. Cubism Core's heap used to be configured at 32 MB; loading the 6th-10th model of a
 * ten-model project made the Core re-allocate its heap, and every model created before that kept rendering the OLD heap: motions and
 * parameters kept "running" in JS (so parameter-based checks pass) while the picture stopped. These tests read the Core's OUTPUT
 * (vertex hash) and the canvas pixels instead, on a project with 10 models (5 casual + 5 live-mode) and live scenes in the middle:
 *   - play it from the start, then jump through it in the order that reproduced the report (s_2 -> s_3 -> s_4 -> s_1 -> s_5),
 *   - on both the 16:9 and the 2.16:1 frame (a new app, but the Core heap is global).
 * Needs the real model library the fixture refers to; skipped when it is not there.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import './helpers/studio';

test.setTimeout(900_000);

const FIXTURE = fileURLToPath(new URL('../fixtures/ai-generated-project-c.json', import.meta.url));
const SCENE_ORDER = [1, 2, 3, 0, 4];

async function importProject(request: APIRequestContext): Promise<string> {
  const project = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { id: string; title: string };
  project.id = `p_e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  project.title = `liveness-real ${Date.now()}`;
  const res = await request.post('/api/projects', { data: project });
  expect(res.ok(), 'fixture project is accepted by the server').toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** The fixture needs its ten models in the local library; without them there is nothing real to render. */
async function modelsAvailable(request: APIRequestContext): Promise<boolean> {
  const project = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { scenes: Array<{ wardrobe: Record<string, { modelId: string }> }> };
  const ids = new Set(project.scenes.flatMap((s) => Object.values(s.wardrobe).map((w) => w.modelId)));
  for (const id of ids) {
    const res = await request.get(`/api/catalog/models/${encodeURIComponent(id)}`);
    if (!res.ok()) return false;
  }
  return ids.size >= 10;
}

async function open(page: Page, id: string, wide: boolean, heapMB?: number) {
  if (heapMB !== undefined) await page.addInitScript((mb) => ((globalThis as { __cubismMemoryMB?: number }).__cubismMemoryMB = mb), heapMB);
  await page.goto(`/play/${id}`);
  if (wide) await page.getByTestId('play-aspect').selectOption({ index: 1 });
  await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 300_000 });
  await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 120_000 }).toBe(false);
}

interface Sample { t: number; cast: string; model: string; hash: number; stale: boolean }

/** Gaps (in project seconds) in which a visible character's rendered vertices did not change; spans shorter than `minSpan` are ignored. */
function frozenSpans(samples: Sample[], window = 1.0, minSpan = 1.2) {
  const bad: string[] = [];
  const byCast = new Map<string, Sample[]>();
  for (const s of samples) (byCast.get(s.cast) ?? byCast.set(s.cast, []).get(s.cast)!).push(s);
  for (const [cast, list] of byCast) {
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      const brk = i === list.length || list[i]!.model !== list[i - 1]!.model || list[i]!.t - list[i - 1]!.t > 0.6;
      if (!brk) continue;
      const span = list.slice(start, i);
      start = i;
      if (span.length < 2 || span.at(-1)!.t - span[0]!.t < minSpan) continue;
      let lastChange = span[0]!.t;
      for (let k = 1; k < span.length; k++) {
        if (Math.abs(span[k]!.hash - span[k - 1]!.hash) > 1e-9) lastChange = span[k]!.t;
        else if (span[k]!.t - lastChange > window) {
          bad.push(`${cast}/${span[0]!.model} frozen from t=${lastChange.toFixed(1)} to ${span[k]!.t.toFixed(1)}`);
          lastChange = span[k]!.t; // report once per window
        }
      }
    }
  }
  return bad;
}

async function jumpAndCheck(page: Page, order: number[] = SCENE_ORDER, perScene = 1000) {
  const plan = await page.evaluate(({ order, limit }) => {
    const p = window.__studio.player!;
    const starts = p.beatStarts();
    const scenes = p.sceneStarts();
    const beats = Object.entries(starts).sort((a, b) => a[1] - b[1]);
    return order.flatMap((si) => {
      const lo = scenes[si]!;
      const hi = scenes[si + 1] ?? p.duration();
      return beats.filter(([, t]) => t >= lo - 1e-6 && t < hi - 1e-6).slice(0, limit).map(([beat, t]) => ({ beat, t: t + 0.3 }));
    });
  }, { order, limit: perScene });
  expect(plan.length).toBeGreaterThanOrEqual(Math.min(30, order.length * Math.min(perScene, 3)));
  const problems: string[] = [];
  let checked = 0;
  for (const step of plan) {
    await page.evaluate((t) => window.__studio.player!.seek(t), step.t);
    await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 120_000 }).toBe(false);
    const res = await page.evaluate(async () => {
      const st = window.__studio;
      const state = st.player!.state()!;
      const frameW = document.querySelector<HTMLCanvasElement>('[data-testid=play-canvas]')!.width / 1.5;
      const frameH = document.querySelector<HTMLCanvasElement>('[data-testid=play-canvas]')!.height / 1.5;
      const subjects = st.getActorScreenBoxes().filter((b) => {
        const a = state.actors.find((x) => x.castId === b.castId);
        const cx = b.head.x + b.head.w / 2;
        return !!a && a.opacity >= 0.95 && !!b.modelId && cx > 0 && cx < frameW && b.head.w > 4;
      });
      const grab = (b: (typeof subjects)[number]) => {
        const x = Math.max(0, Math.floor(b.head.x));
        const y = Math.max(0, Math.floor(b.head.y));
        const w = Math.min(frameW, Math.ceil(b.head.x + b.head.w)) - x;
        const h = Math.min(frameH, Math.ceil(b.head.y + b.head.h)) - y;
        return st.snapshotPixels(x, y, Math.max(1, w), Math.max(1, h));
      };
      const first = subjects.map((b) => ({ hashes: [st.getActorVertexHash(b.modelId!)], px: grab(b) }));
      for (let k = 0; k < 15; k++) {
        await new Promise((r) => setTimeout(r, 100));
        subjects.forEach((b, i) => first[i]!.hashes.push(st.getActorVertexHash(b.modelId!)));
      }
      return subjects.map((b, i) => {
        const now = grab(b);
        const before = first[i]!.px;
        let diff = 0;
        for (let k = 0; k < before.length; k += 4) {
          if (Math.abs(before[k]! - now[k]!) + Math.abs(before[k + 1]! - now[k + 1]!) + Math.abs(before[k + 2]! - now[k + 2]!) > 24) diff++;
        }
        const hs = first[i]!.hashes;
        // changes inside the first second (11 samples at 100 ms)
        const changes = hs.slice(1, 11).filter((h, k) => Math.abs(h - hs[k]!) > 1e-9).length;
        return { cast: b.castId, model: b.modelId!, changes, pixels: before.length ? diff / (before.length / 4) : 0, stale: st.getActorHeapStale(b.modelId!) };
      });
    });
    for (const r of res) {
      checked++;
      const where = `${step.beat} ${r.cast}/${r.model}`;
      if (r.stale) problems.push(`${where}: heap stale`);
      if (r.changes < 1) problems.push(`${where}: vertex hash did not change in 1 s`);
      if (r.pixels <= 0.005) problems.push(`${where}: head pixels changed ${(r.pixels * 100).toFixed(2)}% in 1.5 s`);
    }
  }
  expect(checked, 'characters were checked').toBeGreaterThan(Math.min(60, plan.length));
  expect(problems.slice(0, 20), 'frozen characters').toEqual([]);
}

for (const wide of [false, true]) {
  const name = wide ? '2.16:1' : '16:9';

  test(`sequential play-through at ${name}: every visible character's vertices keep changing`, async ({ page, request }) => {
    test.skip(!(await modelsAvailable(request)), 'the ten models of the fixture are not in the local library');
    const id = await importProject(request);
    try {
      await open(page, id, wide);
      await page.evaluate(() => {
        const w = window as unknown as { __samples: Sample[]; __stop: () => void };
        w.__samples = [];
        const h = setInterval(() => {
          const st = window.__studio;
          const p = st.player!;
          const state = p.state();
          if (!state || p.busy()) return;
          const boxes = st.getActorScreenBoxes();
          const frameW = document.querySelector<HTMLCanvasElement>('[data-testid=play-canvas]')!.width / 1.5;
          for (const b of boxes) {
            const a = state.actors.find((x) => x.castId === b.castId);
            if (!a || a.opacity < 0.95 || !b.modelId) continue;
            const cx = b.head.x + b.head.w / 2;
            if (cx < 0 || cx > frameW) continue;
            w.__samples.push({ t: p.time(), cast: b.castId, model: b.modelId, hash: st.getActorVertexHash(b.modelId), stale: st.getActorHeapStale(b.modelId) });
          }
        }, 100);
        w.__stop = () => clearInterval(h);
      });
      await page.evaluate(() => window.__studio.player!.play());
      await page.waitForFunction(() => window.__studio.player!.time() >= window.__studio.player!.duration() - 0.3, null, { timeout: 600_000, polling: 1000 });
      const samples = await page.evaluate(() => (window as unknown as { __samples: Sample[]; __stop: () => void }).__samples);
      expect(samples.length, 'the sampler saw people').toBeGreaterThan(200);
      expect(samples.filter((s) => s.stale).map((s) => `${s.cast}/${s.model}@${s.t.toFixed(1)}`).slice(0, 8), 'no model on a stale Core heap').toEqual([]);
      expect(frozenSpans(samples).slice(0, 12), 'no visible character is frozen for more than 1 s').toEqual([]);
    } finally {
      await request.delete(`/api/projects/${id}`);
    }
  });

  test(`jumping s_2 -> s_3 -> s_4 -> s_1 -> s_5 at ${name}: vertices and pixels of every visible head change`, async ({ page, request }) => {
    test.skip(!(await modelsAvailable(request)), 'the ten models of the fixture are not in the local library');
    const id = await importProject(request);
    try {
      await open(page, id, wide);
      await jumpAndCheck(page);
    } finally {
      await request.delete(`/api/projects/${id}`);
    }
  });
}

// The safety net on its own: with the old 32 MB heap the Core re-allocates while the project loads; the library must rebuild
// every model that was left on the old heap, so that nobody freezes.
test('with a deliberately tiny 32 MB Core heap the library repairs re-allocated heaps (nobody freezes)', async ({ page, request }) => {
  test.skip(!(await modelsAvailable(request)), 'the ten models of the fixture are not in the local library');
  const id = await importProject(request);
  const logs: string[] = [];
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
  try {
    await open(page, id, false, 32);
    await jumpAndCheck(page);
    expect(logs.some((l) => l.includes('[cubism] heap reallocated')), 'the guard had to rebuild models').toBe(true);
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});

test('editor: clicking through three scenes keeps every visible character moving', async ({ page, request }) => {
  test.skip(!(await modelsAvailable(request)), 'the ten models of the fixture are not in the local library');
  const id = await importProject(request);
  try {
    await page.goto(`/editor/${id}`);
    await expect(page.getByTestId('play-status')).toHaveText('就绪', { timeout: 300_000 });
    await expect.poll(() => page.evaluate(() => window.__studio.player!.busy()), { timeout: 120_000 }).toBe(false);
    await jumpAndCheck(page, [1, 2, 3], 3);
  } finally {
    await request.delete(`/api/projects/${id}`);
  }
});
