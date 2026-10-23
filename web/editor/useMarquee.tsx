/**
 * Marquee selection for a scrolling list / grid of beats. Press on empty space (not on a text field, button, draggable row or the
 * open line editor), drag past a few pixels and every beat the band touches joins the shared beat multi-selection (`ui.cards`);
 * Ctrl / Shift / Cmd while pressing adds to the selection the drag started from. The band is drawn in content coordinates inside
 * `rootRef` (which must be `position: relative`; `mode` 'list' selects the rows the band spans, 'grid' the cards it covers), and the nearest scrolling ancestor auto-scrolls when the pointer nears its edge.
 * While dragging only the multi-selection changes; the primary beat (inspector) moves when the drag ends, so rows never reflow mid-drag.
 */
import { useEffect, useState, type RefObject } from 'react';
import { beatOrder, type BeatPick } from '@shared/agent/selection';
import { useProject } from '../store/projectStore';
import { useUi } from '../store/uiStore';
import { NO_MARQUEE_SELECTOR, autoScrollDelta, exceedsThreshold, hitItems, marqueePick, marqueePrimary, normRect, type Item, type Pt, type Rect } from './marquee';

const scrollParent = (el: HTMLElement): HTMLElement => {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return document.documentElement;
};

interface Drag {
  start: Pt; // client coordinates of the press
  origin: Pt; // content coordinates of the press
  add: boolean;
  base: BeatPick;
  items: Item[];
  scroller: HTMLElement;
  active: boolean;
  last: Pt;
  raf: number;
  hit: string[];
  order: string[];
}

export function useMarquee(rootRef: RefObject<HTMLElement | null>, itemSelector: string, mode: 'list' | 'grid', enabled = true): { band: Rect | null } {
  const [band, setBand] = useState<Rect | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;
    let drag: Drag | null = null;
    let shown = '';

    const contentOrigin = () => {
      const r = root.getBoundingClientRect();
      return { x: r.left, y: r.top };
    };
    const measure = (): Item[] => {
      const o = contentOrigin();
      return [...root.querySelectorAll<HTMLElement>(itemSelector)].map((el) => {
        const r = el.getBoundingClientRect();
        // in a one-column list a band is only about the rows it spans, so a drag down the gutter selects them (x is ignored)
        const wide = mode === 'list';
        return { id: el.dataset.beatId!, rect: { left: wide ? -Infinity : r.left - o.x, top: r.top - o.y, right: wide ? Infinity : r.right - o.x, bottom: r.bottom - o.y } };
      });
    };
    const update = () => {
      const d = drag;
      if (!d || !d.active) return;
      const o = contentOrigin();
      const rect = normRect(d.origin, { x: d.last.x - o.x, y: d.last.y - o.y });
      setBand(rect);
      d.hit = hitItems(rect, d.items);
      const pick = marqueePick(d.order, d.base, d.hit, d.add);
      const key = pick.ids.join(',');
      if (key !== shown) {
        shown = key;
        useUi.getState().set({ cards: pick.ids });
      }
    };
    const tick = () => {
      const d = drag;
      if (!d) return;
      const view = d.scroller.getBoundingClientRect();
      const dy = autoScrollDelta(d.last.y, view.top, view.bottom);
      if (dy !== 0) {
        const before = d.scroller.scrollTop;
        d.scroller.scrollTop += dy;
        if (d.scroller.scrollTop !== before) update();
      }
      d.raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (!drag) return;
      cancelAnimationFrame(drag.raf);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      drag = null;
      setBand(null);
    };
    const onMove = (e: MouseEvent) => {
      const d = drag;
      if (!d) return;
      d.last = { x: e.clientX, y: e.clientY };
      if (!d.active) {
        if (!exceedsThreshold(d.start, d.last)) return;
        d.active = true;
        d.items = measure(); // the layout does not change while only the multi-selection moves
        d.raf = requestAnimationFrame(tick);
      }
      update();
    };
    const onUp = () => {
      const d = drag;
      if (!d) return;
      if (d.active) {
        const pick = marqueePick(d.order, d.base, d.hit, d.add);
        const primary = marqueePrimary(d.order, d.base, d.hit);
        const project = useProject.getState().project;
        useUi.getState().set({ cards: pick.ids });
        if (project && primary && primary !== d.base.primary) {
          const owner = project.scenes.find((s) => s.beats.some((b) => b.id === primary))?.id;
          if (owner) useProject.getState().select({ sceneId: owner, beatId: primary });
        }
        if (pick.ids.length > 0) useUi.getState().set({ inspectorTab: 'beat' });
      }
      stop();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drag) return;
      if (drag.active) useUi.getState().set({ cards: drag.base.ids });
      e.stopPropagation();
      stop();
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || drag) return;
      const t = e.target as Element | null;
      if (!t || t.closest(NO_MARQUEE_SELECTOR)) return;
      const project = useProject.getState().project;
      if (!project) return;
      const o = contentOrigin();
      const ui = useUi.getState();
      drag = {
        start: { x: e.clientX, y: e.clientY },
        origin: { x: e.clientX - o.x, y: e.clientY - o.y },
        add: e.ctrlKey || e.metaKey || e.shiftKey,
        base: { ids: ui.cards, primary: useProject.getState().selection.beatId },
        items: [],
        scroller: scrollParent(root),
        active: false,
        last: { x: e.clientX, y: e.clientY },
        raf: 0,
        hit: [],
        order: beatOrder(project),
      };
      shown = ui.cards.join(',');
      e.preventDefault(); // no text selection while rubber-banding
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
    };
    root.addEventListener('mousedown', onDown);
    return () => {
      root.removeEventListener('mousedown', onDown);
      stop();
    };
  }, [rootRef, itemSelector, mode, enabled]);
  return { band };
}

/** The rubber band, drawn inside the (position: relative) list root. */
export function MarqueeBand({ band }: { band: Rect | null }) {
  if (!band) return null;
  return <div className="marquee-band" data-testid="marquee-band" style={{ left: band.left, top: band.top, width: band.right - band.left, height: band.bottom - band.top }} />;
}
