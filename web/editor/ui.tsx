/** Small editor UI primitives: collapsible sections, labelled rows, scrubbable number fields, splitters, provenance marks. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Meta } from '@shared/schema/project';

export const SOURCE_LABEL: Record<Meta['source'], string> = { ai: 'AI', rule: '规则', user: '人工', default: '默认' };

export function Section({ title, hint, defaultOpen = true, children, testid }: { title: string; hint?: string; defaultOpen?: boolean; children: ReactNode; testid?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="grp" data-testid={testid}>
      <button className="grp-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="grp-title">{title}</span>
        {hint && <span className="grp-hint">{hint}</span>}
      </button>
      {open && <div className="grp-body">{children}</div>}
    </section>
  );
}

/** Provenance bar + badge (+ optional lock toggle) of an editable unit (PLAN 1.1). */
export function MetaMark({ meta, onLock }: { meta: Meta; onLock?: (locked: boolean) => void }) {
  return (
    <span className="metamark" title={`来源：${SOURCE_LABEL[meta.source]}${meta.reason ? `（${meta.reason}）` : ''}`}>
      <span className={`src src-${meta.source}`}>{SOURCE_LABEL[meta.source]}</span>
      {onLock && (
        <button className={`lock${meta.locked ? ' on' : ''}`} onClick={() => onLock(!meta.locked)} aria-pressed={meta.locked} title={meta.locked ? '已锁定：重新生成时保持不变' : '锁定'}>
          <LockIcon locked={meta.locked} />
        </button>
      )}
    </span>
  );
}

/** Flat monochrome padlock (closed / open), shared by every lock control and badge. */
export function LockIcon({ locked, size = 13 }: { locked: boolean; size?: number }) {
  return (
    <svg className="lock-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill={locked ? 'currentColor' : 'none'} fillOpacity={locked ? 0.25 : 0} />
      {locked ? <path d="M5 7V5a3 3 0 0 1 6 0v2" /> : <path d="M5 7V5a3 3 0 0 1 5.6-1.5" />}
    </svg>
  );
}

/** Lock button of ONE field of a unit (`meta.lockedFields`): the AI and the rule director keep that field, the rest may change. */
export function FieldLock({ meta, field, toggle }: { meta: Meta; field: string; toggle: (on: boolean) => void }) {
  const whole = meta.locked;
  const on = whole || (meta.lockedFields?.includes(field) ?? false);
  return (
    <button
      className={`lock flock${on ? ' on' : ''}`}
      aria-pressed={on}
      disabled={whole}
      data-testid={`fieldlock-${field}`}
      title={whole ? '整个单元已锁定' : on ? '这个字段已锁定：重新生成时保持不变（点击解除）' : '只锁定这个字段'}
      onClick={() => toggle(!on)}
    >
      <LockIcon locked={on} size={11} />
    </button>
  );
}

/** Toggle `field` in `meta.lockedFields` (a draft of the unit's meta). */
export function setFieldLock(meta: Meta, field: string, on: boolean): void {
  const set = new Set(meta.lockedFields ?? []);
  if (on) set.add(field);
  else set.delete(field);
  if (set.size > 0) meta.lockedFields = [...set];
  else delete meta.lockedFields;
}

export function Row({ label, children, meta, onLock, testid, extra }: { label: string; children: ReactNode; meta?: Meta; onLock?: (locked: boolean) => void; testid?: string; extra?: ReactNode }) {
  return (
    <div className={`row${meta ? ` from-${meta.source}` : ''}`} data-testid={testid}>
      <span className="row-label">{label}</span>
      <span className="row-ctl">{children}</span>
      {meta && <MetaMark meta={meta} {...(onLock ? { onLock } : {})} />}
      {extra}
    </div>
  );
}

/** Evaluate a plain arithmetic expression ("0.4*2"); null when it is not one. */
export function evalNumber(text: string): number | null {
  const t = text.trim().replace(/，/g, '.');
  if (t === '' || !/^[0-9+\-*/().\s]+$/.test(t)) return null;
  try {
    const v = new Function(`"use strict"; return (${t});`)() as unknown;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export interface NumFieldProps {
  label?: string;
  value: number;
  onChange: (v: number) => void;
  /** Called when a drag / typing session ends (closes the undo group). */
  onCommit?: () => void;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  unit?: string;
  testid?: string;
}

/** Number field: drag the label to scrub (Shift x10, Alt x0.1), or type a value / expression. */
export function NumField({ value, onChange, onCommit, min = -Infinity, max = Infinity, step = 0.01, digits = 2, unit, label, testid }: NumFieldProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{ x: number; v: number } | null>(null);
  const shown = draft ?? String(Number(value.toFixed(digits)));

  const commit = () => {
    if (draft !== null) {
      const v = evalNumber(draft);
      if (v !== null) onChange(clamp(v));
      setDraft(null);
    }
    onCommit?.();
  };
  return (
    <span className="num">
      {label && (
        <span
          className="scrub"
          title="左右拖动调整数值（Shift 粗调，Alt 细调）"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, v: value };
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            onChange(clamp(drag.current.v + Math.round((e.clientX - drag.current.x) / 3) * step * k));
          }}
          onPointerUp={() => {
            drag.current = null;
            onCommit?.();
          }}
        >
          {label}
        </span>
      )}
      <input
        className="num-in"
        value={shown}
        inputMode="decimal"
        data-testid={testid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

/** Slider + number, both feeding the same coalesced edit. */
export function SliderField(p: NumFieldProps & { min: number; max: number }) {
  const { value, onChange, onCommit, min, max, step = 0.01 } = p;
  return (
    <span className="slider-field">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={onCommit} onKeyUp={onCommit} />
      <NumField {...p} />
    </span>
  );
}

export function Modal({ title, onClose, children, testid, wide, xl }: { title: string; onClose: () => void; children: ReactNode; testid?: string; wide?: boolean; xl?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Close before workspace shortcuts can clear the editor selection.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}${xl ? ' xl' : ''}`} role="dialog" aria-label={title} data-testid={testid}>
        <header>
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
