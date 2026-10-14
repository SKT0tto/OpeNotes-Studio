import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORY_LABEL, searchBackgrounds } from '@shared/catalog/bgUi';
import { bgCategoryOf } from '@shared/director/bgCategory';
import type { BgCategory } from '@shared/schema/assetLabels';
import type { BackgroundEntry } from '@shared/schema/assets';
import { reloadCatalog } from '../useCatalog';
import { BgCard } from './BgCard';
import { BgDropOverlay, BgUploadButton, BgUploadStatus, useBgDrop, useBgUpload } from './BgUpload';
import { useShowDecor } from './useShowDecor';

export interface BgFitInfo {
  level: 'ok' | 'fallback' | 'no';
  /** Why it is flagged (shown under the card). */
  reason: string | null;
}

export interface BgPickerProps {
  backgrounds: readonly BackgroundEntry[];
  current?: string | null;
  title: string;
  /** Which backgrounds fit the scene (the first group "适合本场景"); the rest are listed below with the reason. */
  fit: (b: BackgroundEntry) => BgFitInfo;
  /** `insert`: cut-away pictures (sky, signal, crossing) come first. */
  use?: 'scene' | 'insert';
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Popup grid to choose a background: search, "适合本场景" first, ⚠ with the reason for the others, decor hidden unless the switch is on. */
export function BgPicker({ backgrounds, current, title, fit, use = 'scene', onPick, onClose }: BgPickerProps) {
  const [query, setQuery] = useState('');
  const [showDecor, setShowDecor] = useShowDecor();
  const [cat, setCat] = useState<'' | BgCategory>('');
  const [pendingDecor, setPendingDecor] = useState<BackgroundEntry | null>(null);
  const [limit, setLimit] = useState(36);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const up = useBgUpload((ids) => {
    void reloadCatalog().then(() => setUploaded((u) => [...new Set([...ids, ...u])]), (e: unknown) => alert((e as Error).message));
  });
  const drop = useBgDrop((fs) => void up.upload(fs));
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (pendingDecor) setPendingDecor(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, pendingDecor]);

  const hits = useMemo(() => {
    const pool = backgrounds.filter((b) => !uploaded.includes(b.id) && !b.labels?.duplicateOf && (showDecor || bgCategoryOf(b) !== 'decor') && (!cat || bgCategoryOf(b) === cat));
    const found = searchBackgrounds(pool, query);
    if (use === 'insert' && !query) return [...found].sort((a, b) => Number(bgCategoryOf(b) === 'insert') - Number(bgCategoryOf(a) === 'insert'));
    return found;
  }, [backgrounds, query, showDecor, cat, use, uploaded]);
  const fresh = useMemo(() => uploaded.map((id) => backgrounds.find((b) => b.id === id)).filter((b): b is BackgroundEntry => !!b), [uploaded, backgrounds]);
  const groups = useMemo(() => {
    const ok: BackgroundEntry[] = [];
    const rest: BackgroundEntry[] = [];
    for (const b of hits) {
      const f = fit(b);
      const insertFirst = use === 'insert' && bgCategoryOf(b) === 'insert';
      if ((f.level === 'ok' && bgCategoryOf(b) !== 'insert') || insertFirst) ok.push(b);
      else rest.push(b);
    }
    return { ok, rest };
  }, [hits, fit, use]);

  const choose = (b: BackgroundEntry) => {
    if (bgCategoryOf(b) === 'decor' && use === 'scene') setPendingDecor(b);
    else onPick(b.id);
  };
  const shown = [...groups.ok, ...groups.rest].slice(0, limit);
  const okShown = shown.filter((b) => groups.ok.includes(b));
  const restShown = shown.filter((b) => !groups.ok.includes(b));
  const card = (b: BackgroundEntry) => {
    const f = fit(b);
    return <BgCard key={b.id} bg={b} testid="picker-card" selected={b.id === current} warn={f.level === 'ok' ? null : `${f.level === 'no' ? '' : '？'}${f.reason ?? ''}`.trim() || null} onClick={() => choose(b)} />;
  };

  return createPortal(
    <div className="bgx-modal" role="dialog" aria-label={title} data-testid="bg-picker" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bgx-picker bgx-dropzone" {...drop.handlers}>
        <BgDropOverlay show={drop.dragging} />
        <header>
          <h3>{title}</h3>
          <input ref={input} type="search" className="text" placeholder="搜索标题 / 描述 / 标签 / 地点，多个词用空格（如 夜 卧室）" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(36); }} data-testid="picker-search" aria-label="搜索背景" />
          <div className="bgx-chips">
            {([['', '全部'], ['scene', CATEGORY_LABEL.scene], ['insert', CATEGORY_LABEL.insert], ['event', CATEGORY_LABEL.event]] as Array<['' | BgCategory, string]>).map(([k, label]) => (
              <button key={k} type="button" className={`bgx-chip ${cat === k ? 'on' : ''}`} onClick={() => setCat(k)}>{label}</button>
            ))}
            <label className="bgx-switch" title="logo、纯色、网页界面等素材平时不会出现在这里，也不会被 AI 选用">
              <input type="checkbox" checked={showDecor} onChange={(e) => setShowDecor(e.target.checked)} data-testid="picker-show-decor" />显示装饰素材
            </label>
          </div>
          <BgUploadButton up={up} />
          <button type="button" className="btn" onClick={onClose} data-testid="picker-close">关闭</button>
        </header>
        <div className="bgx-picker-body">
          <BgUploadStatus up={up} />
          {fresh.length > 0 && <h4 data-testid="picker-group-uploaded">刚上传（{fresh.length}）</h4>}
          {fresh.length > 0 && <div className="bgx-grid">{fresh.map(card)}</div>}
          {okShown.length > 0 && <h4 data-testid="picker-group-ok">{use === 'insert' ? '插入镜头候选' : '适合本场景'}（{groups.ok.length}）</h4>}
          <div className="bgx-grid">{okShown.map(card)}</div>
          {restShown.length > 0 && <h4 data-testid="picker-group-rest">其他（{groups.rest.length}）· 带 ⚠ 的与出场角色或类别不符，仍可手动选用</h4>}
          <div className="bgx-grid">{restShown.map(card)}</div>
          {hits.length === 0 && <p className="empty">没有匹配的背景。</p>}
          {hits.length > limit && <button type="button" className="btn more" onClick={() => setLimit(limit + 36)}>显示更多（还有 {hits.length - limit} 张）</button>}
        </div>
        {pendingDecor && (
          <div className="bgx-confirm" role="alertdialog" data-testid="picker-decor-confirm">
            <p>「{pendingDecor.name}」是装饰素材（logo、纯色或界面截图），平时不用作剧情背景。仍要选用吗？连续性检查会给出提示。</p>
            <button type="button" className="btn primary" onClick={() => onPick(pendingDecor.id)} data-testid="picker-decor-ok">仍然选用</button>
            <button type="button" className="btn" onClick={() => setPendingDecor(null)}>取消</button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
