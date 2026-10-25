/**
 * The Live2D character on the project hub (title screen). Purely decorative and user-controlled:
 * - the model is picked by the user (「换角色」, or 「不显示角色」), stored with its position and scale in localStorage;
 * - drag to move, wheel / pinch to scale, double-click or 「重置位置」 to reset, click for a reaction (hit areas when the model has them);
 * - only a box around the model's visible bounds takes pointer input — the rest of the stage passes through to the UI;
 * - loads after first paint, shows nothing (and reports nothing) when Cubism Core or the model is unavailable, one model in one Pixi
 *   app, paused behind dialogs, destroyed on unmount (opening a project unmounts the hub); prefers-reduced-motion: no idle loop.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Application } from 'pixi.js';
import type { CompactCatalog, CompactModel, ModelEntry } from '@shared/schema/assets';
import type { Calibration } from '@shared/schema/calibration';
import { costumeLabelZh } from '@shared/catalog/labels';
import { fetchCalibration, fetchModel, type Health } from '../api';
import { ensureRuntime } from '../engine/runtime';
import { Live2DActor, NEUTRAL_SIGNS } from '../engine/Live2DActor';
import { probeModel } from '../engine/ModelProbe';
import {
  BASE_HEIGHT, DEFAULT_PLACEMENT, HUB_CHARACTER_KEY, dragBy, hitZone, isClick, parsePrefs, pickReaction, reactionPool,
  resolveHubModel, serializePrefs, usableHubModels, zoomAt, type HubCharacterPrefs, type HubPlacement,
} from './hubCharacterLogic';

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Stored hub-character prefs (choice, position, scale). Storage failures fall back to the defaults and never throw. */
export function useHubCharacterPrefs(): [HubCharacterPrefs, (next: HubCharacterPrefs) => void] {
  const [prefs, setPrefs] = useState<HubCharacterPrefs>(() => {
    try {
      return parsePrefs(localStorage.getItem(HUB_CHARACTER_KEY));
    } catch {
      return parsePrefs(null);
    }
  });
  const update = useCallback((next: HubCharacterPrefs) => {
    setPrefs(next);
    try {
      localStorage.setItem(HUB_CHARACTER_KEY, serializePrefs(next));
    } catch {
      /* private window / blocked storage: keep it for this visit only */
    }
  }, []);
  return [prefs, update];
}

interface Loaded {
  app: Application;
  actor: Live2DActor;
  cal: Calibration;
  entry: ModelEntry;
  still: boolean;
}

export function HubCharacter({ health, modelId, placement, onPlacement, onPick, paused }: {
  health: Health;
  modelId: string | null;
  placement: HubPlacement;
  onPlacement: (p: HubPlacement) => void;
  onPick: () => void;
  paused: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const loaded = useRef<Loaded | null>(null);
  const place = useRef<HubPlacement>(placement);
  const [shown, setShown] = useState(false);
  const commit = useRef(onPlacement);
  useEffect(() => {
    commit.current = onPlacement;
  }, [onPlacement]);

  /** Put the model at `p` and move the input box over its visible bounds. */
  const apply = useCallback((p: HubPlacement) => {
    place.current = p;
    const l = loaded.current;
    const el = hit.current;
    if (!l || !el) return;
    const { width: w, height: h } = l.app.screen;
    const s = (h * BASE_HEIGHT * p.scale) / l.cal.totalHeight;
    const ax = p.x * w;
    const ay = p.y * h;
    l.actor.model.scale.set(s);
    l.actor.model.position.set(ax - l.cal.ground.x * s, ay - l.cal.bounds.y * s);
    const left = Math.max(0, ax + (l.cal.bounds.x - l.cal.ground.x) * s);
    const top = Math.max(0, ay);
    const right = Math.min(w, ax + (l.cal.bounds.x + l.cal.bounds.w - l.cal.ground.x) * s);
    const bottom = Math.min(h, ay + l.cal.bounds.h * s);
    Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px` });
    if (!l.app.ticker.started) l.app.render();
  }, []);

  // an external change (reset, or the commit of a gesture) moves the model
  useEffect(() => {
    apply(placement);
  }, [placement, apply]);

  useEffect(() => {
    const el = host.current;
    if (!modelId || !el) return;
    const still = reducedMotion();
    let dead = false;
    let app: Application | null = null;
    let inited = false;
    let actor: Live2DActor | null = null;
    const run = async () => {
      const rt = await ensureRuntime(health.cubismCoreUrl, health.cubismMemoryMB);
      if (dead) return;
      const [entry, saved] = await Promise.all([fetchModel(modelId), fetchCalibration(modelId).catch(() => null)]);
      if (dead) return;
      app = new Application();
      await app.init({ resizeTo: el, backgroundAlpha: 0, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 1.5), autoDensity: true });
      inited = true;
      if (dead) return void app.destroy(true, { children: true });
      app.canvas.setAttribute('aria-hidden', 'true');
      el.appendChild(app.canvas);
      const a = await Live2DActor.load(rt, { id: `hub:${modelId}`, modelUrl: entry.url, signs: saved ?? NEUTRAL_SIGNS, ticker: app.ticker });
      if (dead) return void a.destroy();
      actor = a;
      a.model.alpha = 0;
      app.stage.addChild(a.model);
      await new Promise((r) => setTimeout(r, 120)); // one evaluated frame before measuring the pose
      if (dead) return;
      const cal = saved ?? probeModel(a, modelId); // probed for placement only; never saved from the hub
      a.override.signs = cal;
      loaded.current = { app, actor: a, cal, entry, still };
      apply(place.current);
      app.renderer.on('resize', () => apply(place.current));
      if (!still) {
        const idle = entry.motions.find((m) => m.family === 'idle01' && m.side === 'C') ?? entry.motions.find((m) => m.family.startsWith('idle'));
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
    const go = () => void run().catch(() => undefined);
    const timer = window.setTimeout(() => (ric ? ric(go, { timeout: 1500 }) : go()), 250);
    return () => {
      dead = true;
      window.clearTimeout(timer);
      setShown(false);
      loaded.current = null;
      actor?.destroy();
      // an app still initialising is destroyed by run() once init settles
      if (app && inited) app.destroy(true, { children: true });
    };
  }, [modelId, health.cubismCoreUrl, health.cubismMemoryMB, apply]);

  // pause the idle loop while an overlay / dialog covers the stage
  useEffect(() => {
    const l = loaded.current;
    if (!l || !shown || l.still) return;
    if (paused) l.app.ticker.stop();
    else l.app.ticker.start();
  }, [paused, shown]);

  // --- reactions -----------------------------------------------------------------------------------------------------------------
  const reaction = useRef({ token: 0, until: 0 });
  const react = useCallback((x: number, y: number) => {
    const l = loaded.current;
    const now = performance.now();
    if (!l || now < reaction.current.until) return;
    let names: string[];
    try {
      names = l.actor.model.hitTest(x, y);
    } catch {
      names = [];
    }
    const pool = reactionPool(l.entry.motions, l.entry.expressions, hitZone(names));
    const { motion, expression } = pickReaction(pool);
    const token = ++reaction.current.token;
    reaction.current.until = now + 700;
    hit.current?.setAttribute('data-reacting', '1');
    const done = (ms: number) => window.setTimeout(() => {
      if (token !== reaction.current.token || loaded.current !== l) return;
      hit.current?.removeAttribute('data-reacting');
      void l.actor.setExpression(null).catch(() => false);
      if (l.still) {
        l.app.render();
        l.app.ticker.stop();
      }
    }, ms);
    if (l.still) {
      // reduced motion: an expression only, no body motion, then back to a still frame
      if (!expression) return void hit.current?.removeAttribute('data-reacting');
      l.app.ticker.start();
      void l.actor.setExpression(expression).catch(() => false);
      done(1600);
      return;
    }
    if (motion) void l.actor.playMotion(motion).catch(() => false); // a one-shot: falls back to the idle loop when it ends
    if (expression) void l.actor.setExpression(expression).catch(() => false);
    done(2800);
  }, []);

  // --- gestures: drag, pinch, click, wheel -----------------------------------------------------------------------------------------
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ x: number; y: number; t: number; place: HubPlacement; moved: boolean; pinch?: { dist: number; place: HubPlacement } } | null>(null);
  const local = (e: { clientX: number; clientY: number }) => {
    const r = host.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0), w: r?.width ?? 1, h: r?.height ?? 1 };
  };
  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 } : null;
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) gesture.current = { x: p.x, y: p.y, t: performance.now(), place: place.current, moved: false };
    else if (pointers.current.size === 2 && gesture.current) {
      const ps = pinchState();
      if (ps) gesture.current = { ...gesture.current, moved: true, pinch: { dist: ps.dist, place: place.current } };
    }
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g.pinch && pointers.current.size >= 2) {
      const ps = pinchState();
      if (ps && g.pinch.dist > 0) apply(zoomAt(g.pinch.place, ps.dist / g.pinch.dist, ps.mx, ps.my, p.w, p.h));
      return;
    }
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    if (!g.moved && !isClick(dx, dy, 0)) g.moved = true;
    if (g.moved) apply(dragBy(g.place, dx, dy, p.w, p.h));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (pointers.current.size === 1) {
      // pinch ended with one finger left: carry on as a drag from here
      const [rest] = [...pointers.current.values()];
      gesture.current = { x: rest!.x, y: rest!.y, t: performance.now(), place: place.current, moved: true };
      return;
    }
    if (pointers.current.size > 0) return;
    gesture.current = null;
    const p = local(e);
    if (!g.moved && e.type === 'pointerup' && isClick(p.x - g.x, p.y - g.y, performance.now() - g.t)) react(p.x, p.y);
    else if (g.moved) commit.current(place.current);
  };

  useEffect(() => {
    const el = hit.current;
    if (!el) return;
    let timer = 0;
    const onWheel = (e: WheelEvent) => {
      if (!loaded.current) return;
      e.preventDefault();
      const p = local(e);
      const factor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * 0.0015)));
      apply(zoomAt(place.current, factor, p.x, p.y, p.w, p.h));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => commit.current(place.current), 250);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.clearTimeout(timer);
    };
  }, [apply]);

  return (
    <>
      <div ref={host} className={`stage-actor${shown ? ' shown' : ''}`} aria-hidden="true" />
      <div
        ref={hit}
        className="hub-char-hit"
        hidden={!shown}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={() => commit.current({ ...DEFAULT_PLACEMENT })}
        data-testid="hub-character"
        title="拖动移动 · 滚轮缩放 · 双击复位 · 点击互动"
      >
        <button className="char-swap" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={onPick} tabIndex={-1} aria-hidden="true">
          换角色
        </button>
      </div>
    </>
  );
}

/** The always-reachable (keyboard too) character menu shown in the top-right corner. */
export function HubCharacterMenu({ hidden, onPick, onReset, onToggle }: { hidden: boolean; onPick: () => void; onReset: () => void; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', off);
    window.addEventListener('keydown', off);
    return () => {
      window.removeEventListener('pointerdown', off);
      window.removeEventListener('keydown', off);
    };
  }, [open]);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="char-menu" ref={box}>
      <button className="env-pill" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} data-testid="hub-char-menu">
        <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c.8-3.4 3.6-5.5 7-5.5s6.2 2.1 7 5.5" /></svg>
        角色
      </button>
      {open && (
        <div className="char-menu-pop" role="menu">
          <button role="menuitem" onClick={run(onPick)} data-testid="hub-char-pick">换角色…</button>
          <button role="menuitem" onClick={run(onReset)} disabled={hidden} data-testid="hub-char-reset">重置位置</button>
          <button role="menuitem" onClick={run(onToggle)} data-testid="hub-char-toggle">{hidden ? '显示角色' : '不显示角色'}</button>
        </div>
      )}
    </div>
  );
}

/** Model picker for the hub character: search, grouped by band and character, with preview thumbnails. */
export function HubModelPicker({ catalog, current, onPick, onClose }: {
  catalog: CompactCatalog;
  current: string | null | undefined;
  onPick: (model: string | null | undefined) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const fallback = resolveHubModel(catalog, undefined);
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const byChar = new Map<string, CompactModel[]>();
    for (const m of usableHubModels(catalog)) (byChar.get(m.characterKey) ?? byChar.set(m.characterKey, []).get(m.characterKey)!).push(m);
    const out: Array<{ band: string; chars: Array<{ key: string; name: string; color: string | null; models: CompactModel[] }> }> = [];
    const bandOf = (bandKey: string | null, bandName: string) => catalog.bands.find((b) => b.key === bandKey)?.name ?? (bandName || '其他');
    for (const ch of catalog.characters) {
      const models = (byChar.get(ch.key) ?? []).filter((m) => {
        if (!words.length) return true;
        const hay = [ch.name, ch.nickname ?? '', ...ch.aliases, ch.bandName, costumeLabelZh(m.costumeInfo, m.costume), m.id].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      if (!models.length) continue;
      const band = bandOf(ch.bandKey, ch.bandName);
      let g = out.find((x) => x.band === band);
      if (!g) out.push((g = { band, chars: [] }));
      g.chars.push({ key: ch.key, name: ch.name, color: ch.color, models });
    }
    return out;
  }, [catalog, query]);
  const isCurrent = (id: string) => current === id || (current === undefined && id === fallback);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide hub-picker" role="dialog" aria-modal="true" aria-label="选择角色" data-testid="hub-model-picker">
        <header>
          <strong>选择标题画面角色</strong>
          <button className="btn" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="hub-picker-top">
          <input className="text" type="search" placeholder="搜索角色 / 乐队 / 服装，多个词用空格" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus aria-label="搜索角色" data-testid="hub-model-search" />
          <button className={`btn${current === undefined ? ' toggle on' : ''}`} onClick={() => onPick(undefined)}>默认</button>
          <button className={`btn${current === null ? ' toggle on' : ''}`} onClick={() => onPick(null)} data-testid="hub-model-none">不显示角色</button>
        </div>
        <div className="hub-picker-list">
          {groups.length === 0 && <p className="hint">没有匹配的角色。</p>}
          {groups.map((g) => (
            <section key={g.band}>
              <h3>{g.band}</h3>
              {g.chars.map((ch) => (
                <div key={ch.key} className="hub-picker-char">
                  <div className="hub-picker-name"><i className="swatch" style={{ background: ch.color ?? '#556' }} />{ch.name}</div>
                  <div className="hub-picker-models">
                    {ch.models.map((m) => (
                      <button key={m.id} className={`hub-picker-card${isCurrent(m.id) ? ' on' : ''}`} onClick={() => onPick(m.id)} title={m.id} data-testid="hub-model-card" data-model-id={m.id}>
                        {m.preview ? <span className="thumb"><img src={m.preview} loading="lazy" decoding="async" alt="" /></span> : <span className="thumb gen" style={{ '--c': ch.color ?? '#5b8cff' } as CSSProperties}>{ch.name.slice(0, 1)}</span>}
                        <span className="cap">{costumeLabelZh(m.costumeInfo, m.costume)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

