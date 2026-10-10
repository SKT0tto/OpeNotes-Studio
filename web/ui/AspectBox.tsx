/**
 * The one canvas host: measures the space it is given (ResizeObserver, so window resizes, panel drags / collapses and browser
 * zoom are all covered) and centres a frame of exactly `aspect` inside it (letterbox / pillarbox). Every stage, preview, lab
 * canvas and thumbnail goes through this, so nothing is ever stretched or cropped.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { fitAspect } from '@shared/layout/fitAspect';

interface Box { left: number; top: number; width: number; height: number }
const ZERO: Box = { left: 0, top: 0, width: 0, height: 0 };

function measure(el: HTMLElement, aspect: number): Box {
  const cs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const padL = px(cs.paddingLeft);
  const padT = px(cs.paddingTop);
  const w = el.clientWidth - padL - px(cs.paddingRight);
  const h = el.clientHeight - padT - px(cs.paddingBottom);
  const f = fitAspect(w, h, aspect);
  return { left: padL + (w - f.width) / 2, top: padT + (h - f.height) / 2, width: f.width, height: f.height };
}
const same = (a: Box, b: Box) => Math.abs(a.left - b.left) < 0.01 && Math.abs(a.top - b.top) < 0.01 && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;

export function AspectBox({ aspect, className, frameClassName, frameTestId, style, children }: {
  aspect: number;
  /** The area that is measured (give it a definite size from the layout: flex 1 / min-height 0, or a fixed height). */
  className?: string;
  frameClassName?: string;
  frameTestId?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>(ZERO);
  useLayoutEffect(() => {
    const el = outer.current!;
    const update = () => {
      const b = measure(el, aspect);
      setBox((s) => (same(s, b) ? s : b));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [aspect]);
  return (
    <div ref={outer} className={className} style={{ position: 'relative', overflow: 'hidden', ...style }} data-aspect-area="">
      <div className={frameClassName} data-testid={frameTestId} data-aspect={aspect} style={{ position: 'absolute', ...box }}>
        {children}
      </div>
    </div>
  );
}
