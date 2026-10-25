/**
 * The idling Live2D character on the project hub (title screen). Purely decorative: it loads after first paint, shows nothing
 * (and reports nothing) when Cubism Core or the model is unavailable, uses one model in one Pixi app, and is destroyed on unmount
 * (opening a project unmounts the hub). With prefers-reduced-motion it renders a still pose and stops the ticker.
 */
import { useEffect, useRef, useState } from 'react';
import { Application } from 'pixi.js';
import type { CompactCatalog } from '@shared/schema/assets';
import type { Calibration } from '@shared/schema/calibration';
import { fetchCalibration, fetchModel, type Health } from '../api';
import { ensureRuntime } from '../engine/runtime';
import { Live2DActor, NEUTRAL_SIGNS } from '../engine/Live2DActor';
import { probeModel } from '../engine/ModelProbe';

const DEFAULT_MODEL = '001_casual_spring_01';

/** A full-quality, animated ADV model for a character (casual / school first), or null. */
export function pickHubModel(catalog: CompactCatalog, characterKey: string | null): string | null {
  const usable = catalog.models.filter((m) => m.mode === 'adv' && !m.still && m.quality === '' && !m.isSub && m.motionCount > 0);
  const rank = (base: string) => (base === 'casual' ? 0 : base === 'school' ? 1 : 2);
  if (characterKey) {
    const own = usable.filter((m) => m.characterKey === characterKey).sort((a, b) => rank(a.costumeInfo.base) - rank(b.costumeInfo.base));
    if (own[0]) return own[0].id;
  }
  return usable.find((m) => m.id === DEFAULT_MODEL)?.id ?? usable.sort((a, b) => rank(a.costumeInfo.base) - rank(b.costumeInfo.base))[0]?.id ?? null;
}

/** Upper body large on the right, head near the top, legs running off the bottom like a title screen. */
function place(actor: Live2DActor, cal: Calibration, w: number, h: number): void {
  const s = (h * 1.32) / cal.totalHeight;
  actor.model.scale.set(s);
  actor.model.position.set(w * 0.5 - cal.ground.x * s, h * 0.07 - cal.bounds.y * s);
}

export function HubCharacter({ health, modelId, paused }: { health: Health; modelId: string | null; paused: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!modelId || !el) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let dead = false;
    let app: Application | null = null;
    let inited = false;
    let actor: Live2DActor | null = null;
    const run = async () => {
      const rt = await ensureRuntime(health.cubismCoreUrl, health.cubismMemoryMB);
      if (dead) return;
      const [me, saved] = await Promise.all([fetchModel(modelId), fetchCalibration(modelId).catch(() => null)]);
      if (dead) return;
      app = new Application();
      await app.init({ resizeTo: el, backgroundAlpha: 0, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 1.5), autoDensity: true });
      inited = true;
      if (dead) return void app.destroy(true, { children: true });
      app.canvas.setAttribute('aria-hidden', 'true');
      el.appendChild(app.canvas);
      appRef.current = app;
      const a = await Live2DActor.load(rt, { id: `hub:${modelId}`, modelUrl: me.url, signs: saved ?? NEUTRAL_SIGNS, ticker: app.ticker });
      if (dead) return void a.destroy();
      actor = a;
      a.model.alpha = 0;
      app.stage.addChild(a.model);
      await new Promise((r) => setTimeout(r, 120)); // one evaluated frame before measuring the pose
      if (dead) return;
      const cal = saved ?? probeModel(a, modelId); // probed for placement only; never saved from the hub
      a.override.signs = cal;
      const fit = () => app && place(a, cal, app.screen.width, app.screen.height);
      fit();
      app.renderer.on('resize', fit);
      if (!still) {
        const idle = me.motions.find((m) => m.family === 'idle01' && m.side === 'C') ?? me.motions.find((m) => m.family.startsWith('idle'));
        if (idle) await a.playIdle(idle.name).catch(() => false);
      }
      if (dead) return;
      a.model.alpha = 1;
      setShown(true);
      if (still) {
        app.render();
        app.ticker.stop();
      }
    };
    // after first paint, and when the browser is idle
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const timer = window.setTimeout(() => (ric ? ric(() => void run().catch(() => undefined), { timeout: 1500 }) : void run().catch(() => undefined)), 250);
    return () => {
      dead = true;
      window.clearTimeout(timer);
      setShown(false);
      appRef.current = null;
      actor?.destroy();
      // an app still initialising is destroyed by run() once init settles
      if (app && inited) app.destroy(true, { children: true });
    };
  }, [modelId, health.cubismCoreUrl, health.cubismMemoryMB]);

  // pause the idle loop while an overlay / dialog covers the stage
  useEffect(() => {
    const app = appRef.current;
    if (!app || !shown || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (paused) app.ticker.stop();
    else app.ticker.start();
  }, [paused, shown]);

  return <div ref={host} className={`stage-actor${shown ? ' shown' : ''}`} aria-hidden="true" />;
}
