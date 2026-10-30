/**
 * Title-screen background choice (「背景」 menu next to 「角色」): 自动 / 指定背景 / 我的图片 / 纯色·渐变, plus a dim slider.
 * The choice lives in localStorage like the character prefs; the personal picture lives on the server under the data dir
 * (see server/hub/routes.ts). A missing source silently falls back to 自动.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORY_LABEL, searchBackgrounds } from '@shared/catalog/bgUi';
import { bgCategoryOf } from '@shared/director/bgCategory';
import type { BgCategory } from '@shared/schema/assetLabels';
import type { BackgroundEntry } from '@shared/schema/assets';
import { BgCard } from './bg/BgCard';
import {
  DIM_MAX, HUB_BACKGROUND_KEY, parseBackgroundPrefs, serializeBackgroundPrefs, type HubBackgroundChoice, type HubBackgroundPrefs, type HubImageInfo,
} from './hubBackgroundLogic';

export const HUB_BG_MAX_MB = 20;

/** Stored background prefs. Storage failures fall back to 自动 and never throw. */
export function useHubBackgroundPrefs(): [HubBackgroundPrefs, (next: HubBackgroundPrefs) => void] {
  const [prefs, setPrefs] = useState<HubBackgroundPrefs>(() => {
    try {
      return parseBackgroundPrefs(localStorage.getItem(HUB_BACKGROUND_KEY));
    } catch {
      return parseBackgroundPrefs(null);
    }
  });
  const update = useCallback((next: HubBackgroundPrefs) => {
    setPrefs(next);
    try {
      localStorage.setItem(HUB_BACKGROUND_KEY, serializeBackgroundPrefs(next));
    } catch {
      /* blocked storage: keep it for this visit only */
    }
  }, []);
  return [prefs, update];
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `HTTP ${res.status}`;
}

/** The personal picture on the server: info (null while loading), upload (resolves to an error text or null), remove. */
export function useHubCustomImage(): { info: HubImageInfo | null; upload: (f: File) => Promise<string | null>; remove: () => Promise<void> } {
  const [info, setInfo] = useState<HubImageInfo | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/hub/background')
      .then((r) => (r.ok ? (r.json() as Promise<HubImageInfo>) : { exists: false }), () => ({ exists: false }))
      .then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, []);
  const upload = useCallback(async (file: File): Promise<string | null> => {
    if (file.size > HUB_BG_MAX_MB * 1024 ** 2) return `图片超过大小上限 ${HUB_BG_MAX_MB} MB`;
    try {
      const res = await fetch('/api/hub/background', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      if (!res.ok) return await readError(res);
      setInfo((await res.json()) as HubImageInfo);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, []);
  const remove = useCallback(async () => {
    await fetch('/api/hub/background', { method: 'DELETE' }).catch(() => undefined);
    setInfo({ exists: false });
  }, []);
  return { info, upload, remove };
}

/**
 * The picture to paint behind the title menu. 自动 keeps `autoUrl` exactly as before; the other picture choices stay on the gradient
 * until the picture has really loaded (after first paint, no layout shift) and become 自动 when it fails to load.
 */
export function useStageBackground(choice: HubBackgroundChoice, autoUrl: string | undefined): string | undefined {
  const want = choice.kind === 'asset' || choice.kind === 'image' ? choice.url : null;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!want) return;
    const img = new Image();
    img.onload = () => setLoaded(want);
    img.onerror = () => setFailed(want);
    img.src = want;
    return () => {
      img.onload = img.onerror = null;
    };
  }, [want]);
  if (choice.kind === 'gradient') return undefined;
  if (choice.kind === 'auto') return autoUrl;
  if (!want) return undefined;
  if (failed === want) return autoUrl;
  return loaded === want ? want : undefined;
}

/** The stage picture layer behind the title menu (the gradient shows until a chosen picture has loaded). */
export function StageBackground({ choice, autoUrl }: { choice: HubBackgroundChoice; autoUrl: string | undefined }) {
  const url = useStageBackground(choice, autoUrl);
  return <div className="stage-bg" style={url ? { backgroundImage: `url("${url}")` } : undefined} aria-hidden="true" />;
}

const RANK: Record<BgCategory, number> = { scene: 0, event: 1, insert: 2, decor: 3 };

/** Pick one library background by title; scene pictures come first, decor last (shown, but never preferred). */
export function HubBackgroundPicker({ backgrounds, current, onPick, onClose }: {
  backgrounds: readonly BackgroundEntry[];
  current: string | undefined;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(36);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const hits = useMemo(() => {
    const found = searchBackgrounds(backgrounds.filter((b) => !b.labels?.duplicateOf), query);
    return query.trim() ? found : [...found].sort((a, b) => RANK[bgCategoryOf(a)] - RANK[bgCategoryOf(b)]); // stable: keeps the catalogue order inside a category
  }, [backgrounds, query]);
  return createPortal(
    <div className="bgx-modal" role="dialog" aria-modal="true" aria-label="选择标题画面背景" data-testid="hub-bg-picker" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bgx-picker">
        <header>
          <h3>选择标题画面背景</h3>
          <input ref={input} type="search" className="text" placeholder="搜索标题 / 地点 / 标签，多个词用空格（如 夜 教室）" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(36); }} aria-label="搜索背景" data-testid="hub-bg-search" />
          <button type="button" className="btn" onClick={onClose} data-testid="hub-bg-close">关闭</button>
        </header>
        <div className="bgx-picker-body">
          <p className="hint">{CATEGORY_LABEL.scene}在前，装饰素材（logo、纯色、界面截图）排在最后。</p>
          <div className="bgx-grid">
            {hits.slice(0, limit).map((b) => (
              <BgCard key={b.id} bg={b} testid="hub-bg-card" selected={b.id === current} onClick={() => onPick(b.id)} />
            ))}
          </div>
          {hits.length === 0 && <p className="empty">没有匹配的背景。</p>}
          {hits.length > limit && <button type="button" className="btn more" onClick={() => setLimit(limit + 36)}>显示更多（还有 {hits.length - limit} 张）</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** 「背景」 pill + popup menu. Stays open while the dim slider is used; Escape / outside click closes it. */
export function HubBackgroundMenu({ prefs, onChange, image, onUpload, onRemove, canPick, onPick }: {
  prefs: HubBackgroundPrefs;
  onChange: (p: HubBackgroundPrefs) => void;
  image: HubImageInfo | null;
  onUpload: (f: File) => Promise<boolean>;
  onRemove: () => Promise<void>;
  canPick: boolean;
  onPick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
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
  const set = (p: Partial<HubBackgroundPrefs>) => onChange({ ...prefs, ...p });
  const has = image?.exists === true;
  const radio = (on: boolean, label: string, run: () => void, testid: string, disabled = false) => (
    <button role="menuitemradio" aria-checked={on} className="bg-opt" disabled={disabled} onClick={() => { setOpen(false); run(); }} data-testid={testid}>
      <span className="tick" aria-hidden="true">{on ? '✓' : ''}</span>{label}
    </button>
  );
  return (
    <div className="char-menu bg-menu" ref={box}>
      <button className="env-pill" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} data-testid="hub-bg-menu">
        <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6M9 9h.01" /></svg>
        背景
      </button>
      {open && (
        <div className="char-menu-pop" role="menu" aria-label="标题画面背景">
          {radio(prefs.mode === 'auto', '自动', () => set({ mode: 'auto' }), 'hub-bg-auto')}
          {radio(prefs.mode === 'asset', '指定背景…', onPick, 'hub-bg-asset', !canPick)}
          {radio(prefs.mode === 'image' && has, '我的图片', () => set({ mode: 'image' }), 'hub-bg-image', !has)}
          <button role="menuitem" className="bg-opt sub" onClick={() => file.current?.click()} data-testid="hub-bg-upload">
            <span className="tick" aria-hidden="true" />{has ? '更换我的图片…' : '上传我的图片…'}
          </button>
          {has && (
            <button role="menuitem" className="bg-opt sub" onClick={() => { setOpen(false); void onRemove(); if (prefs.mode === 'image') set({ mode: 'auto' }); }} data-testid="hub-bg-remove">
              <span className="tick" aria-hidden="true" />移除我的图片
            </button>
          )}
          {radio(prefs.mode === 'gradient', '纯色 / 渐变', () => set({ mode: 'gradient' }), 'hub-bg-gradient')}
          <label className="bg-dim">
            <span>暗化 {Math.round(prefs.dim * 100)}%</span>
            <input type="range" min={0} max={DIM_MAX * 100} step={5} value={Math.round(prefs.dim * 100)} onChange={(e) => set({ dim: Number(e.target.value) / 100 })} data-testid="hub-bg-dim" />
          </label>
        </div>
      )}
      <input
        ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden data-testid="hub-bg-file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          setOpen(false);
          if (f) void onUpload(f).then((ok) => ok && set({ mode: 'image' }));
        }}
      />
    </div>
  );
}
