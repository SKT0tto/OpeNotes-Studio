/** Top-bar 「布局」 menu: layout presets, 重置布局, and a show / hide list of every panel. */
import { useEffect, useRef, useState } from 'react';
import type { DockController } from './Dock';
import { PANEL_IDS, PANEL_TITLE, PRESETS, REQUIRED, type PanelId } from './layoutModel';

export function LayoutMenu({ dock, present }: { dock: DockController | null; present: ReadonlySet<PanelId> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span className="layout-menu" ref={root}>
      <button className={`btn toggle${open ? ' on' : ''}`} disabled={!dock} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="btn-layout" title="面板布局：预设、重置、显示 / 隐藏面板">布局</button>
      {open && dock && (
        <div className="layout-pop" role="menu" data-testid="layout-menu">
          <div className="lm-head">预设</div>
          {PRESETS.map((p) => (
            <button key={p.id} role="menuitem" className="lm-item" title={p.hint} data-testid={`layout-preset-${p.id}`} onClick={() => { dock.applyPreset(p.id); setOpen(false); }}>{p.label}</button>
          ))}
          <button role="menuitem" className="lm-item" data-testid="layout-reset" title="恢复默认布局，并清除已保存的布局" onClick={() => { dock.reset(); setOpen(false); }}>重置布局</button>
          <div className="lm-head">面板</div>
          {PANEL_IDS.map((id) => (
            <label key={id} className="lm-item lm-check" title={REQUIRED.includes(id) ? '必需面板，不能关闭' : undefined}>
              <input type="checkbox" role="menuitemcheckbox" checked={present.has(id)} disabled={REQUIRED.includes(id)} data-testid={`layout-toggle-${id}`} onChange={() => dock.toggle(id)} />
              {PANEL_TITLE[id]}
            </label>
          ))}
          <div className="lm-foot">拖动面板标签可停靠到其他面板的四周，拖动分隔线调整大小，双击标签最大化。</div>
        </div>
      )}
    </span>
  );
}
