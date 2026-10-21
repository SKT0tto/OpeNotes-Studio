// Headless frame-work measurement of the player / editor (maintainer-run, needs a GPU and the asset library; not part of CI).
//   1. build the web app with the dev hooks:   npx vite build --config scripts/perf/vite.prof.config.mjs --outDir <tmp>/dist/web (a production build with the window.__studio hooks)
//      (see the "perf regression check" section of dev-notes/perf-optimization-plan.md), serve it with `node dist/server/index.mjs`;
//   2. create the test projects (ids in a JSON file: {"name": "p_id", ...}; names starting with "mygo" / "stress" pick the window start);
//   3. node scripts/perf/frame-work.mjs --base http://127.0.0.1:5474 --ids ids.json --label mine [--dur 40] [--only name] [--pages play,editor]
// Headless Edge only (never a visible window). Per project and page it records every Pixi frame (CPU work, rAF deltas, React commits,
// GL counters) and writes <out>/results/<label>-<profile>.json (--out, default .verify/perf); compare two labels with the numbers it prints.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(`--${k}`);
const BASE = arg('base', 'http://127.0.0.1:5474');
const PROFILE = arg('profile', 'normal');
const DUR = Number(arg('dur', '40'));
const ONLY = arg('only', '');
const PAGES = arg('pages', 'play,editor').split(',');
const ids = JSON.parse(fs.readFileSync(path.resolve(arg('ids', path.join(here, 'projects.json'))), 'utf8'));
const OUT = path.resolve(arg('out', '.verify/perf'));
for (const d of ['results', 'cpuprofiles', 'traces']) fs.mkdirSync(path.join(OUT, d), { recursive: true });

const ARGS = {
  common: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-size=1940,1200'],
  normal: [],
  cpu4: [],
  uncapped: ['--disable-gpu-vsync', '--disable-frame-rate-limit'],
  swgpu: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
};

export async function openCase(browser, project, pageKind) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.addInitScript({ path: path.join(here, 'inpage.js') });
  // never show anything but the perf projects (the profiling server has its own data dir anyway)
  await ctx.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const list = (await res.json()).filter((p) => Object.values(ids).includes(p.id));
    await route.fulfill({ response: res, json: list });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  const t0 = Date.now();
  await page.goto(`${BASE}/${pageKind === 'play' ? 'play' : 'editor'}/${ids[project]}`);
  await page.waitForFunction(() => window.__studio?.player && !window.__studio.player.busy(), null, { timeout: 180000 });
  await page.locator('[data-testid=play-toggle]').first().waitFor({ state: 'visible' });
  const loadMs = Date.now() - t0;
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp, errors, loadMs };
}

/** Start of the measurement window: mygo crosses the scene 1 -> 2 change; stress crosses the first background switch with moves / fades around. */
export async function windowStart(page, project) {
  return page.evaluate((proj) => {
    const p = window.__studio.player;
    const starts = p.sceneStarts();
    if (proj.startsWith('mygo')) return Math.max(0, starts[1] - 12);
    const bs = p.beatStarts();
    const sc = p.project().scenes[0];
    const key = sc.tracks.filter((t) => t.channel === 'background').flatMap((t) => t.keys).map((k) => bs[k.at.beatId]).sort((a, b) => a - b)[0];
    return Math.max(0, (key ?? 40) - 15);
  }, project);
}

async function settle(page) {
  await page.waitForFunction(() => !window.__studio.player.busy(), null, { timeout: 120000 });
  await page.waitForTimeout(1000);
}

async function playFor(page, seconds) {
  const btn = page.locator('[data-testid=play-toggle]').first();
  await btn.click();
  await page.waitForTimeout(seconds * 1000);
  await btn.click();
}

function summarize(frames) {
  const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };
  const stat = (arr) => arr.length ? { n: arr.length, mean: arr.reduce((a, b) => a + b, 0) / arr.length, p50: q(arr, 0.5), p95: q(arr, 0.95), p99: q(arr, 0.99), max: Math.max(...arr), over16: arr.filter((x) => x > 16.7).length, over33: arr.filter((x) => x > 33.3).length } : null;
  const groups = {
    all: () => true,
    steady: (f) => (f.lab & (1 | 2 | 8 | 16 | 32)) === 0,
    cameraMove: (f) => (f.lab & 1) !== 0 && (f.lab & 8) === 0,
    actorFade: (f) => (f.lab & 2) !== 0,
    actorWalk: (f) => (f.lab & 16) !== 0,
    dof: (f) => (f.lab & 4) !== 0 && (f.lab & 8) === 0,
    noDof: (f) => (f.lab & 4) === 0 && (f.lab & 8) === 0,
    sceneOrBgChange: (f) => (f.lab & 8) !== 0,
  };
  const out = {};
  for (const [k, pred] of Object.entries(groups)) {
    const fr = frames.filter((f, i) => i > 0 && pred(f));
    if (!fr.length) continue;
    const gpu = fr.map((f) => f.gpu).filter((x) => typeof x === 'number' && x >= 0);
    const m = (key) => fr.reduce((a, f) => a + f[key], 0) / fr.length;
    out[k] = {
      interval: stat(fr.map((f) => f.iv)), work: stat(fr.map((f) => f.work)), gpu: stat(gpu),
      workPlusGpu: stat(fr.filter((f) => typeof f.gpu === 'number' && f.gpu >= 0).map((f) => f.work + f.gpu)),
      meanMs: { player: m('player'), hidden: m('hidden'), automator: m('automator'), render: m('render'), l2dUpdate: m('l2dU'), l2dDraw: m('l2dD'), l2dBounds: m('l2dB') },
      perFrame: { draws: m('draws'), framebufferBinds: m('fb'), filterPasses: m('fp'), programSwitches: m('prog'), texUploads: m('tex'), reactCommits: m('commits'), domMutations: m('mut') },
    };
  }
  return out;
}

async function cpuProfile(cdp, page, file, seconds = 12) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const f0 = await page.evaluate(() => window.__perf.frames.length);
  await page.evaluate(() => window.__perf.start());
  await playFor(page, seconds);
  const { profile } = await cdp.send('Profiler.stop');
  const r = await page.evaluate(() => window.__perf.stop());
  fs.writeFileSync(file, JSON.stringify(profile));
  return { frames: r.frames.length, f0 };
}

async function trace(browser, page, file, seconds = 8) {
  const tmp = file.replace(/\.gz$/, '');
  await browser.startTracing(page, { path: tmp, screenshots: false, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'v8', 'v8.execute', 'disabled-by-default-v8.gc', 'blink.user_timing', 'gpu', 'viz', 'toplevel'] });
  await playFor(page, seconds);
  await browser.stopTracing();
  fs.writeFileSync(file, zlib.gzipSync(fs.readFileSync(tmp)));
  fs.unlinkSync(tmp);
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: [...ARGS.common, ...(ARGS[PROFILE] ?? [])] });
  const outFile = path.join(OUT, 'results', `${arg('label', 'run')}-${PROFILE}.json`);
  const results = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
  const projects = Object.keys(ids).filter((k) => !ONLY || ONLY.split(',').includes(k));
  for (const project of projects) {
    for (const pageKind of PAGES) {
      const key = `${project}/${pageKind}`;
      console.log(`[${PROFILE}] ${key}`);
      const { ctx, page, cdp, errors, loadMs } = await openCase(browser, project, pageKind);
      try {
        const info = await page.evaluate(() => {
          const gl = window.__studio.app.renderer.gl;
          const d = gl.getExtension('WEBGL_debug_renderer_info');
          return { gpu: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?', canvas: [window.__studio.app.canvas.width, window.__studio.app.canvas.height], css: [window.__studio.app.canvas.clientWidth, window.__studio.app.canvas.clientHeight] };
        });
        const inst = await page.evaluate(fs.readFileSync(path.join(here, 'instrument.js'), 'utf8'));
        const start = await windowStart(page, project);
        await page.evaluate((t) => window.__studio.player.seek(t), start);
        await settle(page);
        if (PROFILE === 'cpu4') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        await page.evaluate(() => window.__perf.start());
        await playFor(page, DUR);
        const rec = await page.evaluate(() => window.__perf.stop());
        await page.waitForTimeout(300);
        // late GPU query results land after stop
        const gpuLate = await page.evaluate(() => window.__perf.frames.map((f) => f.gpu));
        rec.frames.forEach((f, i) => { if (f.gpu === null && typeof gpuLate[i] === 'number') f.gpu = gpuLate[i]; });
        const mem = await page.evaluate(() => ({ heap: performance.memory?.usedJSHeapSize, tex: window.__perfGl.texBytesLive, texCount: window.__perfGl.texCount, models: window.__studio.listLoadedModels().length }));
        const summary = summarize(rec.frames);
        results[key] = { project, page: pageKind, profile: PROFILE, loadMs, start, dur: DUR, info, timerQuery: inst.timer, wallMs: rec.wall, commitsTotal: rec.commitsTotal, raf: rec.raf.slice(1).map((x) => +x.toFixed(2)), mutationsTotal: rec.mutationsTotal, mem, summary, errors: errors.slice(0, 10), frames: rec.frames.map((f) => [+f.iv.toFixed(3), +f.work.toFixed(3), f.gpu === null ? null : +f.gpu.toFixed(3), f.lab, +f.player.toFixed(3), +f.render.toFixed(3), +f.l2dU.toFixed(3), +f.l2dD.toFixed(3), +f.l2dB.toFixed(3), f.draws, f.fp, f.commits]), frameCols: ['iv', 'work', 'gpu', 'lab', 'player', 'render', 'l2dU', 'l2dD', 'l2dB', 'draws', 'filterPasses', 'commits'] };
        const a = summary.all;
        console.log(`  frames ${a.interval.n} interval mean ${a.interval.mean.toFixed(2)} p99 ${a.interval.p99.toFixed(1)} max ${a.interval.max.toFixed(1)} >16.7 ${a.interval.over16} >33 ${a.interval.over33} | work mean ${a.work.mean.toFixed(2)} p99 ${a.work.p99.toFixed(2)} | gpu ${a.gpu ? a.gpu.mean.toFixed(2) : '-'} | draws ${a.perFrame.draws.toFixed(0)} filters ${a.perFrame.filterPasses.toFixed(1)} commits/s ${(rec.commitsTotal / (rec.wall / 1000)).toFixed(1)}`);
        if (flag('cpuprofile')) {
          await page.evaluate((t) => window.__studio.player.seek(t), start);
          await settle(page);
          const r = await cpuProfile(cdp, page, path.join(OUT, 'cpuprofiles', `${PROFILE}-${project}-${pageKind}.cpuprofile`));
          results[key].cpuProfileFrames = r.frames;
        }
        if (flag('trace')) {
          await page.evaluate((t) => window.__studio.player.seek(t), start);
          await settle(page);
          await trace(browser, page, path.join(OUT, 'traces', `${PROFILE}-${project}-${pageKind}.trace.json.gz`));
        }
        if (PROFILE === 'cpu4') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      } catch (e) {
        console.error('  failed', e.message);
        results[key] = { project, page: pageKind, profile: PROFILE, error: e.message, errors };
      }
      fs.writeFileSync(outFile, JSON.stringify(results));
      await ctx.close();
    }
  }
  await browser.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
