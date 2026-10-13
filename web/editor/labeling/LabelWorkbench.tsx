/* eslint-disable react-hooks/refs -- the refs (current labels, undo stack, save chain) are read only inside event handlers; the chip helper just forwards those handlers */
/**
 * Labelling workbench (P20): look at the pictures and click, instead of answering a questionnaire.
 * Grid mode: select many cards and set band / owner / place / category / time of day with one chip. Queue mode: one large picture at a time with the
 * AI suggestion and the review notes, answered from the keyboard. Every change is saved at once (server-validated) and can be undone with Ctrl+Z.
 * It works from the label file, so it also works when the asset library is missing (contact-sheet crops or a placeholder card show the picture).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CATEGORY_COLOR, CATEGORY_LABEL, INDOOR_LABEL, REVIEW_COLOR, REVIEW_LABEL, TIME_LABEL, bandColor, entryFromLabel, fixPatch, pendingQueue, reviewOf, searchBackgrounds,
} from '@shared/catalog/bgUi';
import { BG_CATEGORIES, GENERIC_BAND, type BgFix, type BgLabel, type BgLabelPatch } from '@shared/schema/assetLabels';
import type { BackgroundEntry, CompactCatalog } from '@shared/schema/assets';
import { fetchCatalog, type Health } from '../../api';
import { fetchLabelFile, patchLabels, restoreLabels } from '../../labelsApi';
import { BANDS, BgCard, CHARACTERS, bandNameOfKey } from '../bg/BgCard';
import { BgThumb } from '../bg/BgThumb';
import { DetailEditor } from './DetailEditor';

type View = 'grid' | 'queue';
type GroupBy = 'place' | 'band' | 'category' | 'review';
interface UndoStep { desc: string; before: Record<string, BgLabel> }

const today = () => new Date().toISOString().slice(0, 10);
const placeOf = (b: BackgroundEntry) => b.labels?.placeName ?? b.labels?.location ?? b.name.replace(/（.*?）/g, '').split(/[·・]/)[0]!.trim();
const byId = (a: BackgroundEntry, b: BackgroundEntry) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id);
const BAND_KEYS = BANDS.map((b) => b.key);

export function LabelWorkbench({ health }: { health: Health | null }) {
  const [labels, setLabels] = useState<Record<string, BgLabel> | null>(null);
  const [catalog, setCatalog] = useState<CompactCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('grid');
  const [groupBy, setGroupBy] = useState<GroupBy>('place');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'confirmed'>('all');
  const [catFilter, setCatFilter] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'bad' | 'info' } | null>(null);
  const [undo, setUndo] = useState<UndoStep[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [pos, setPos] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [newPlace, setNewPlace] = useState<string | null>(null);

  const labelsRef = useRef<Record<string, BgLabel>>({});
  const undoRef = useRef<UndoStep[]>([]);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    labelsRef.current = labels ?? {};
    undoRef.current = undo;
  });

  useEffect(() => {
    fetchLabelFile().then((f) => setLabels(f.labels), (e: Error) => setError(e.message));
    fetchCatalog().then(setCatalog, () => setCatalog(null));
  }, []);
  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(null), toast.kind === 'bad' ? 6000 : 2200);
    return () => clearTimeout(h);
  }, [toast]);

  const catalogById = useMemo(() => new Map((catalog?.backgrounds ?? []).map((b) => [b.id, b])), [catalog]);
  const items = useMemo(() => Object.entries(labels ?? {}).map(([id, l]) => entryFromLabel(id, l, catalogById.get(id))).sort(byId), [labels, catalogById]);
  const itemById = useMemo(() => new Map(items.map((b) => [b.id, b])), [items]);
  const noLibrary = (health ? !health.assetRoot.ok || health.assetRoot.backgrounds === 0 : false) || (catalog !== null && catalog.backgrounds.length === 0);
  const confirmed = items.filter((b) => reviewOf(b) === 'confirmed').length;

  // ---- saving: optimistic, one request at a time (so the file sees the changes in order), rolled back with a toast on failure -------------------------
  const apply = useCallback((ids: string[], patch: BgLabelPatch, desc: string) => {
    const before: Record<string, BgLabel> = {};
    for (const id of ids) if (labelsRef.current[id]) before[id] = labelsRef.current[id]!;
    if (Object.keys(before).length === 0) return Promise.resolve();
    const stamp = today();
    setLabels((prev) => {
      const next = { ...(prev ?? {}) };
      for (const id of Object.keys(before)) next[id] = { ...next[id]!, ...patch, source: 'user', updatedAt: stamp } as BgLabel;
      return next;
    });
    const step: UndoStep = { desc, before };
    setUndo((u) => [...u, step]);
    const run = chain.current.then(() => patchLabels(Object.keys(before), patch)).catch((e: Error) => {
      setLabels((prev) => ({ ...(prev ?? {}), ...before }));
      setUndo((u) => u.filter((x) => x !== step));
      setToast({ text: `保存失败，已恢复：${e.message}`, kind: 'bad' });
    });
    chain.current = run;
    return run;
  }, []);

  const undoLast = useCallback(() => {
    const step = undoRef.current.at(-1);
    if (!step) return setToast({ text: '没有可撤销的操作', kind: 'info' });
    const now: Record<string, BgLabel> = {};
    for (const id of Object.keys(step.before)) if (labelsRef.current[id]) now[id] = labelsRef.current[id]!;
    setUndo((u) => u.slice(0, -1));
    setLabels((prev) => ({ ...(prev ?? {}), ...step.before }));
    chain.current = chain.current.then(() => restoreLabels(step.before)).then(
      () => setToast({ text: `已撤销：${step.desc}`, kind: 'info' }),
      (e: Error) => {
        setLabels((prev) => ({ ...(prev ?? {}), ...now }));
        setUndo((u) => [...u, step]);
        setToast({ text: `撤销失败：${e.message}`, kind: 'bad' });
      },
    );
  }, []);

  // ---- grid ---------------------------------------------------------------------------------------------------------------------------------------
  const visible = useMemo(() => {
    let list = items;
    if (catFilter) list = list.filter((b) => b.labels?.category === catFilter);
    if (filter === 'pending') list = list.filter((b) => reviewOf(b) !== 'confirmed');
    if (filter === 'confirmed') list = list.filter((b) => reviewOf(b) === 'confirmed');
    return searchBackgrounds(list, query);
  }, [items, query, filter, catFilter]);

  const groups = useMemo(() => {
    const keyOf = (b: BackgroundEntry): { key: string; color?: string } => {
      if (groupBy === 'place') return { key: placeOf(b) };
      if (groupBy === 'band') {
        const bands = b.labels?.bands ?? [];
        return bands.length === 0 ? { key: '未知', color: bandColor(null) } : { key: bands.map(bandNameOfKey).join(' / '), color: bandColor(bands[0]) };
      }
      if (groupBy === 'category') return { key: CATEGORY_LABEL[b.labels?.category ?? 'scene'], color: CATEGORY_COLOR[b.labels?.category ?? 'scene'] };
      const r = reviewOf(b);
      return { key: REVIEW_LABEL[r], color: REVIEW_COLOR[r] };
    };
    const m = new Map<string, { color?: string; list: BackgroundEntry[] }>();
    for (const b of visible) {
      const { key, color } = keyOf(b);
      const g = m.get(key) ?? { ...(color ? { color } : {}), list: [] };
      g.list.push(b);
      m.set(key, g);
    }
    return [...m.entries()].sort((a, b) => (groupBy === 'place' ? a[0].localeCompare(b[0], 'zh') : b[1].list.length - a[1].list.length));
  }, [visible, groupBy]);

  const click = (e: React.MouseEvent, id: string) => {
    const ids = visible.map((b) => b.id);
    if (e.shiftKey && anchor && ids.includes(anchor)) {
      const [a, z] = [ids.indexOf(anchor), ids.indexOf(id)];
      return setSel([...new Set([...sel, ...ids.slice(Math.min(a, z), Math.max(a, z) + 1)])]);
    }
    setAnchor(id);
    if (e.ctrlKey || e.metaKey) setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    else setSel(sel.length === 1 && sel[0] === id ? [] : [id]);
  };

  // marquee selection: drag on the empty part of the grid
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-bg-id],summary,button,input,select')) return;
    const r = wrap.current!.getBoundingClientRect();
    const start = { x: e.clientX - r.left + wrap.current!.scrollLeft, y: e.clientY - r.top + wrap.current!.scrollTop };
    const base = e.ctrlKey || e.metaKey ? sel : [];
    setBox({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
    const move = (ev: MouseEvent) => {
      const b = { x0: start.x, y0: start.y, x1: ev.clientX - r.left + wrap.current!.scrollLeft, y1: ev.clientY - r.top + wrap.current!.scrollTop };
      setBox(b);
      const [l, t, rr, bb] = [Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.max(b.x0, b.x1), Math.max(b.y0, b.y1)];
      const hit: string[] = [];
      wrap.current!.querySelectorAll<HTMLElement>('[data-bg-id]').forEach((el) => {
        const c = el.getBoundingClientRect();
        const [cl, ct] = [c.left - r.left + wrap.current!.scrollLeft, c.top - r.top + wrap.current!.scrollTop];
        if (cl < rr && cl + c.width > l && ct < bb && ct + c.height > t) hit.push(el.dataset.bgId!);
      });
      setSel([...new Set([...base, ...hit])]);
    };
    const up = () => {
      setBox(null);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const selected = useMemo(() => sel.map((id) => itemById.get(id)).filter((b): b is BackgroundEntry => !!b), [sel, itemById]);
  const places = useMemo(() => {
    const c = new Map<string, number>();
    for (const b of items) {
      const p = b.labels?.placeName ?? b.labels?.location;
      if (p) c.set(p, (c.get(p) ?? 0) + 1);
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).map(([p]) => p);
  }, [items]);

  // ---- queue --------------------------------------------------------------------------------------------------------------------------------------
  const openQueue = useCallback((startId?: string) => {
    const q = pendingQueue(items).map((b) => b.id);
    setQueue(q);
    setPos(Math.max(0, startId ? q.indexOf(startId) : 0));
    setView('queue');
  }, [items]);
  const cur = view === 'queue' ? itemById.get(queue[pos] ?? '') ?? null : null;

  const setBands = (ids: string[], bands: string[], opts: { additive?: boolean; confirm?: boolean } = {}) => {
    const additive = opts.additive ?? false;
    const confirm = opts.confirm ?? true;
    const patch = (id: string): BgLabelPatch => {
      const have = labelsRef.current[id]?.bands ?? [];
      const next = additive ? (have.includes(bands[0]!) ? have.filter((x) => x !== bands[0]) : [...have.filter((x) => x !== GENERIC_BAND), ...bands]) : bands;
      return { bands: next };
    };
    // one request per distinct result keeps it one undo step per distinct value
    const by = new Map<string, string[]>();
    for (const id of ids) {
      const key = JSON.stringify(patch(id).bands);
      by.set(key, [...(by.get(key) ?? []), id]);
    }
    for (const [key, group] of by) void apply(group, { bands: JSON.parse(key) as string[], ...(bands.length === 0 || !confirm ? {} : { confidence: 'confirmed' as const }) }, `乐队 → ${bands.length === 0 ? '未知' : bands.map(bandNameOfKey).join('/')}（${group.length} 张）`);
  };

  const confirmCurrent = useCallback(() => {
    if (!cur) return;
    const l = cur.labels;
    const patch: BgLabelPatch = { confidence: l?.bands.length === 0 ? 'unknown' : 'confirmed', fixes: [] };
    for (const f of l?.fixes ?? []) Object.assign(patch, fixPatch(f) ?? {});
    if (l?.bands.length === 0) {
      setToast({ text: '这张的乐队还是「未知」：先按 1–5 / 0 选一个，再按 Enter 确认', kind: 'info' });
      return;
    }
    void apply([cur.id], patch, `确认「${cur.name}」`);
    setPos((p) => Math.min(queue.length - 1, p + 1));
  }, [cur, apply, queue.length]);

  const acceptFix = (f: BgFix, accept: boolean) => {
    if (!cur) return;
    const patch = accept ? fixPatch(f) : null;
    const rest = (cur.labels?.fixes ?? []).filter((x) => x !== f);
    void apply([cur.id], { ...(patch ?? {}), fixes: rest }, `${patch ? '接受' : '忽略'}建议「${cur.name}」`);
  };

  // ---- keyboard -----------------------------------------------------------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        return undoLast();
      }
      if (typing) {
        if (e.key === 'Enter' && t === titleInput.current) {
          e.preventDefault();
          titleInput.current!.blur();
        }
        if (e.key === 'Escape') (t as HTMLInputElement).blur();
        return;
      }
      if (e.key === 'Escape') {
        if (zoom) return setZoom(false);
        if (view === 'queue') return setView('grid');
        return setSel([]);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && view === 'grid') {
        e.preventDefault();
        return setSel(visible.map((b) => b.id));
      }
      if (view !== 'queue' || !cur || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[1-5]$/.test(e.key)) return setBands([cur.id], [BAND_KEYS[Number(e.key) - 1]!], { confirm: false });
      if (e.key === '0') return setBands([cur.id], [GENERIC_BAND], { confirm: false });
      if (e.key === '?' || e.key === '/') return setBands([cur.id], [], { confirm: false });
      if (e.key === 'Enter') {
        e.preventDefault();
        return confirmCurrent();
      }
      if (e.key === 'ArrowLeft') return setPos((p) => Math.max(0, p - 1));
      if (e.key === 'ArrowRight') return setPos((p) => Math.min(queue.length - 1, p + 1));
      if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        return titleInput.current?.focus();
      }
      if (e.key === ' ') {
        e.preventDefault();
        return setZoom((z) => !z);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) return <div className="wb"><p className="wb-empty"><b>读取标注失败</b>{error}</p></div>;
  if (!labels) return <div className="wb"><p className="wb-empty">正在读取标注…</p></div>;

  const allOn = (pred: (l: BgLabel) => boolean) => selected.length > 0 && selected.every((b) => b.labels && pred(b.labels));
  const chip = (key: string, label: React.ReactNode, color: string | null, on: boolean, run: (e: React.MouseEvent) => void, extra = '', testid?: string) => (
    <button key={key} type="button" className={`wb-chip ${extra} ${on ? 'on' : ''}`} style={color ? { ['--c' as string]: color } : undefined} disabled={selected.length === 0} onClick={run} data-testid={testid ?? `chip-${key}`} aria-pressed={on}>{label}</button>
  );
  const set = (patch: BgLabelPatch, desc: string) => void apply(sel, { ...patch, confidence: 'confirmed' }, `${desc}（${sel.length} 张）`);

  return (
    <div className="wb" data-testid="workbench">
      <header className="wb-top">
        <h1>背景标注工作台</h1>
        <nav className="wb-tabs">
          <button type="button" className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} data-testid="wb-tab-grid">网格</button>
          <button type="button" className={view === 'queue' ? 'on' : ''} onClick={() => openQueue()} data-testid="wb-tab-queue">待确认队列 <span className="sub">{items.filter((b) => reviewOf(b) !== 'confirmed' && !b.labels?.duplicateOf && b.labels?.category !== 'decor').length}</span></button>
        </nav>
        <div className="wb-progress" data-testid="wb-progress" title="已确认 / 总数">
          <div className="bar"><i style={{ width: `${items.length ? (confirmed / items.length) * 100 : 0}%` }} /></div>
          <span>已确认 <b data-testid="wb-confirmed">{confirmed}</b> / {items.length}</span>
        </div>
        <button type="button" className="wb-btn" onClick={undoLast} disabled={undo.length === 0} data-testid="wb-undo" title="Ctrl+Z">撤销{undo.length > 0 ? `（${undo.length}）` : ''}</button>
      </header>
      {noLibrary && (
        <div className="wb-banner" data-testid="wb-banner">
          素材库未找到，正在用预览图，导入素材后可看原图。<a href="/assets" data-testid="wb-import">导入素材</a>
        </div>
      )}

      {view === 'grid' && (
        <div className="wb-body">
          <div className="wb-main">
            <div className="wb-tools">
              <input type="search" placeholder="搜索标题 / 描述 / 标签 / 地点" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="wb-search" aria-label="搜索背景" />
              <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} data-testid="wb-group" aria-label="分组">
                <option value="place">按地点分组</option><option value="band">按乐队分组</option><option value="category">按类别分组</option><option value="review">按置信度分组</option>
              </select>
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} data-testid="wb-filter" aria-label="筛选">
                <option value="all">全部</option><option value="pending">只看待确认</option><option value="confirmed">只看已确认</option>
              </select>
              <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} aria-label="类别筛选">
                <option value="">所有类别</option>{BG_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
              <span className="wb-legend"><span><i style={{ background: REVIEW_COLOR.confirmed }} />已确认</span><span><i style={{ background: REVIEW_COLOR.likely }} />AI 推测</span><span><i style={{ background: REVIEW_COLOR.unknown }} />未知 / 有疑问</span></span>
              <span className="hint" data-testid="wb-count">共 {visible.length} 张</span>
            </div>
            <div className="wb-grid-wrap" ref={wrap} onMouseDown={onDown} data-testid="wb-grid">
              {groups.map(([name, g]) => (
                <details key={name} className="wb-group" open data-testid="wb-group-item">
                  <summary>{g.color && <span className="swatch" style={{ ['--c' as string]: g.color }} />}{name}<span className="n">{g.list.length}</span>
                    <button type="button" className="wb-btn" style={{ height: 22, fontSize: 11 }} onClick={(e) => { e.preventDefault(); setSel([...new Set([...sel, ...g.list.map((b) => b.id)])]); }}>选择本组</button>
                  </summary>
                  <div className="bgx-grid compact">
                    {g.list.map((b) => <BgCard key={b.id} bg={b} review selected={sel.includes(b.id)} onClick={(e) => click(e, b.id)} onDoubleClick={() => openQueue(b.id)} testid="wb-card" />)}
                  </div>
                </details>
              ))}
              {visible.length === 0 && <p className="wb-empty"><b>没有匹配的背景</b>换个关键词，或把筛选改回「全部」。</p>}
              {box && <div className="wb-marquee" style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
            </div>
          </div>
          <aside className="wb-panel" data-testid="wb-panel">
            <div className="wb-sel-note" data-testid="wb-selnote">
              {selected.length === 0 ? <>在左边点选卡片（<b>Ctrl</b> 多选，<b>Shift</b> 连选，或拖框框选），再点下面的芯片。双击一张进入大图审阅。</> : <>已选 <b>{selected.length}</b> 张：{selected.slice(0, 2).map((b) => b.name).join('、')}{selected.length > 2 ? '…' : ''}</>}
            </div>
            <div className="row-actions" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="wb-btn" disabled={selected.length === 0} onClick={() => { const p = placeOf(selected[0]!); setSel(items.filter((b) => placeOf(b) === p).map((b) => b.id)); }} data-testid="wb-same-place">选中同一地点全部变体</button>
              <button type="button" className="wb-btn" onClick={() => setSel(visible.map((b) => b.id))}>全选当前</button>
              <button type="button" className="wb-btn" onClick={() => setSel([])} disabled={sel.length === 0}>取消选择</button>
            </div>
            {selected.length === 1 && selected[0]!.labels ? (
              <DetailEditor key={`${selected[0]!.id}:${JSON.stringify(selected[0]!.labels)}`} bg={selected[0]!} places={places} onSave={(patch, desc) => void apply([selected[0]!.id], patch, desc)} />
            ) : (
              <>
            <section>
              <h3>乐队</h3>
              <div className="wb-chips" data-testid="chips-band">
                {BANDS.map((b) => chip(`band-${b.key}`, b.name, bandColor(b.key), allOn((l) => l.bands.includes(b.key)), (e) => setBands(sel, [b.key], { additive: e.ctrlKey || e.shiftKey })))}
                {chip('band-generic', '通用', bandColor(GENERIC_BAND), allOn((l) => l.bands.includes(GENERIC_BAND)), () => setBands(sel, [GENERIC_BAND]))}
                {chip('band-unknown', '？未知', null, allOn((l) => l.bands.length === 0), () => setBands(sel, []), 'plain')}
              </div>
              <p className="sub" style={{ margin: '6px 0 0' }}>按住 Ctrl 点击可给一张图加上第二个乐队。</p>
            </section>
            <section>
              <h3>主人 / 住户</h3>
              {BANDS.map((band) => (
                <div key={band.key} style={{ marginBottom: 6 }}>
                  <div className="wb-chips">
                    {CHARACTERS.filter((c) => c.band === band.key).map((c) => chip(`owner-${c.key}`, <><span className="av">{c.name.slice(0, 1)}</span>{c.name.slice(1)}</>, bandColor(c.band), allOn((l) => l.ownerKey === c.key), () => set({ owner: c.name, ownerKey: c.key, residents: [c.key], access: 'private' }, `主人 → ${c.name}`), 'person'))}
                  </div>
                </div>
              ))}
              {chip('owner-none', '无主人', null, allOn((l) => !l.owner), () => set({ owner: null, ownerKey: null, residents: [] }, '清除主人'), 'plain')}
            </section>
            <section>
              <h3>地点</h3>
              <div className="wb-chips" data-testid="chips-place">
                {places.slice(0, 40).map((p) => chip(`place-${p}`, p, null, allOn((l) => (l.placeName ?? l.location) === p), () => set({ placeName: p }, `地点 → ${p}`), 'plain'))}
                {newPlace === null ? <button type="button" className="wb-chip plain" disabled={selected.length === 0} onClick={() => setNewPlace('')} data-testid="chip-place-new">＋ 新地点…</button> : (
                  <input autoFocus className="wb-chip plain" placeholder="地点名，回车确认" value={newPlace} onChange={(e) => setNewPlace(e.target.value)} data-testid="place-input"
                    onKeyDown={(e) => { if (e.key === 'Enter' && newPlace.trim()) { set({ placeName: newPlace.trim() }, `新地点 ${newPlace.trim()}`); setNewPlace(null); } if (e.key === 'Escape') setNewPlace(null); }} onBlur={() => setNewPlace(null)} />
                )}
              </div>
            </section>
            <section>
              <h3>类别</h3>
              <div className="wb-chips">{BG_CATEGORIES.map((c) => chip(`cat-${c}`, CATEGORY_LABEL[c], CATEGORY_COLOR[c], allOn((l) => (l.category ?? 'scene') === c), () => set({ category: c }, `类别 → ${CATEGORY_LABEL[c]}`)))}</div>
            </section>
            <section>
              <h3>时段 · 室内外 · 舞台</h3>
              <div className="wb-chips">
                {(['day', 'dusk', 'night', 'unspecified'] as const).map((t) => chip(`time-${t}`, TIME_LABEL[t], null, allOn((l) => l.time === t), () => set({ time: t }, `时段 → ${TIME_LABEL[t]}`), 'plain'))}
              </div>
              <div className="wb-chips" style={{ marginTop: 6 }}>
                {(['indoor', 'outdoor', 'abstract', 'screen'] as const).map((t) => chip(`indoor-${t}`, INDOOR_LABEL[t], null, allOn((l) => l.indoor === t), () => set({ indoor: t }, `${INDOOR_LABEL[t]}`), 'plain'))}
                {chip('stage', '可作舞台', '#e6b450', allOn((l) => l.stage), () => set({ stage: !allOn((l) => l.stage) }, '舞台开关'))}
              </div>
            </section>
            <section>
              <button type="button" className="wb-btn good" disabled={selected.length === 0} onClick={() => void apply(sel, { confidence: 'confirmed' }, `确认 ${sel.length} 张`)} data-testid="wb-confirm-sel">把所选标为「已确认」</button>
            </section>
              </>
            )}
          </aside>
        </div>
      )}

      {view === 'queue' && (
        <div className="wbq" data-testid="wb-queue">
          {cur ? (
            <>
              <div className="wbq-image">
                <div className="wbq-frame" onClick={() => setZoom(true)}><BgThumb bg={cur} w={1024} /></div>
                <div className="wbq-nav">
                  <button type="button" className="wb-btn" onClick={() => setPos(Math.max(0, pos - 1))} disabled={pos === 0} data-testid="wbq-prev">← 上一张</button>
                  <span data-testid="wbq-pos">{pos + 1} / {queue.length}</span>
                  <span className="grow" />
                  <button type="button" className="wb-btn" onClick={() => setPos(Math.min(queue.length - 1, pos + 1))} disabled={pos >= queue.length - 1} data-testid="wbq-next">下一张 →</button>
                </div>
              </div>
              <div className="wbq-side" data-testid="wbq-side" data-bg-id={cur.id}>
                <span className="wbq-state" style={{ ['--rv' as string]: REVIEW_COLOR[reviewOf(cur)] }} data-testid="wbq-state" data-review={reviewOf(cur)}><i />{REVIEW_LABEL[reviewOf(cur)]}</span>
                <div className="title">
                  <input ref={titleInput} defaultValue={cur.name} key={`${cur.id}:${cur.labels?.title ?? ''}`} aria-label="标题" data-testid="wbq-title"
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== cur.name) void apply([cur.id], { title: v }, `改标题「${v}」`); }} />
                </div>
                <p className="desc" data-testid="wbq-desc">{cur.description}</p>
                <dl className="wbq-fields">
                  <dt>乐队</dt><dd>{(cur.labels?.bands ?? []).length === 0 ? '？未知' : cur.labels!.bands.map(bandNameOfKey).join(' / ')}{cur.labels?.exclusive ? '（专属）' : ''}</dd>
                  <dt>地点</dt><dd>{cur.labels?.placeName ?? cur.labels?.location ?? '—'}</dd>
                  <dt>主人</dt><dd>{cur.labels?.owner ?? '—'}</dd>
                  <dt>类别</dt><dd>{CATEGORY_LABEL[cur.labels?.category ?? 'scene']} · {TIME_LABEL[cur.labels?.time ?? 'unspecified']} · {INDOOR_LABEL[cur.labels?.indoor ?? 'indoor']}{cur.labels?.stage ? ' · 舞台' : ''}</dd>
                  <dt>依据</dt><dd style={{ color: 'var(--text-2)' }}>{cur.labels?.evidence}</dd>
                </dl>
                {(cur.labels?.fixes ?? []).map((f, i) => (
                  <div key={`${f.field}${i}`} className={`wbq-fix ${f.suggest ? '' : 'q'}`} data-testid={f.suggest ? 'wbq-fix' : 'wbq-question'}>
                    <span className="field">{f.suggest ? `建议修改 · ${f.field}` : `疑问 · ${f.field.replace(/[（(].*$/, '')}`}</span>
                    {f.suggest ? <div className="diff"><s>{f.current ?? '—'}</s> → <b>{f.suggest}</b></div> : <div className="diff">{f.question}</div>}
                    {f.reason && <div className="why">{f.reason}</div>}
                    <div className="acts">
                      {f.suggest && fixPatch(f) && <button type="button" className="wb-btn primary" onClick={() => acceptFix(f, true)} data-testid="wbq-accept">接受建议</button>}
                      <button type="button" className="wb-btn" onClick={() => acceptFix(f, false)} data-testid="wbq-reject">{f.suggest ? '拒绝' : '知道了'}</button>
                    </div>
                  </div>
                ))}
                <section>
                  <h3>乐队（数字键 1–5 / 0 通用 / ? 未知）</h3>
                  <div className="wb-chips">
                    {BANDS.map((b, i) => <button key={b.key} type="button" className={`wb-chip ${cur.labels?.bands.includes(b.key) ? 'on' : ''}`} style={{ ['--c' as string]: bandColor(b.key) }} onClick={() => setBands([cur.id], [b.key], { confirm: false })} data-testid={`wbq-band-${b.key}`}><kbd>{i + 1}</kbd>{b.name}</button>)}
                    <button type="button" className={`wb-chip ${cur.labels?.bands.includes(GENERIC_BAND) ? 'on' : ''}`} style={{ ['--c' as string]: bandColor(GENERIC_BAND) }} onClick={() => setBands([cur.id], [GENERIC_BAND], { confirm: false })} data-testid="wbq-band-generic"><kbd>0</kbd>通用</button>
                    <button type="button" className={`wb-chip plain ${(cur.labels?.bands ?? []).length === 0 ? 'on' : ''}`} onClick={() => setBands([cur.id], [], { confirm: false })} data-testid="wbq-band-unknown"><kbd>?</kbd>未知</button>
                  </div>
                </section>
                <section>
                  <h3>类别</h3>
                  <div className="wb-chips">{BG_CATEGORIES.map((c) => <button key={c} type="button" className={`wb-chip ${(cur.labels?.category ?? 'scene') === c ? 'on' : ''}`} style={{ ['--c' as string]: CATEGORY_COLOR[c] }} onClick={() => void apply([cur.id], { category: c }, `类别 → ${CATEGORY_LABEL[c]}`)}>{CATEGORY_LABEL[c]}</button>)}</div>
                </section>
                {cur.labels && (
                  <details className="wbq-detail" data-testid="wbq-detail">
                    <summary>详细编辑（标题 / 描述 / 地点 / 主人…）</summary>
                    <DetailEditor key={`${cur.id}:${JSON.stringify(cur.labels)}`} bg={cur} places={places} onSave={(patch, desc) => void apply([cur.id], patch, desc)} />
                  </details>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="wb-btn good" onClick={confirmCurrent} data-testid="wbq-confirm">Enter · 确认并下一张</button>
                  <button type="button" className="wb-btn" onClick={() => setPos(Math.min(queue.length - 1, pos + 1))}>跳过</button>
                </div>
              </div>
            </>
          ) : (
            <div className="wb-empty" style={{ gridColumn: '1 / -1' }}><b>待确认队列是空的</b>所有背景都已确认。<br /><button type="button" className="wb-btn" onClick={() => setView('grid')}>回到网格</button></div>
          )}
        </div>
      )}

      <footer className="wb-keys" data-testid="wb-keys">
        {view === 'queue'
          ? <><span><kbd>1</kbd>–<kbd>5</kbd> 选乐队</span><span><kbd>0</kbd> 通用</span><span><kbd>?</kbd> 未知</span><span><kbd>Enter</kbd> 确认并下一张</span><span><kbd>E</kbd> 改标题</span><span><kbd>←</kbd><kbd>→</kbd> 切换</span><span><kbd>Space</kbd> 放大</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销</span><span><kbd>Esc</kbd> 回网格</span></>
          : <><span>点选 / <kbd>Ctrl</kbd> 多选 / <kbd>Shift</kbd> 连选 / 拖框框选</span><span>单选一张即可在右侧详细编辑；双击进入大图审阅</span><span><kbd>Ctrl</kbd>+<kbd>A</kbd> 全选</span><span><kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销</span><span>改动立即保存到 asset-labels/backgrounds.json</span></>}
      </footer>
      {zoom && cur && <div className="wb-zoom" onClick={() => setZoom(false)} data-testid="wb-zoom"><BgThumb bg={cur} w={1024} /></div>}
      {toast && <div className={`wb-toast ${toast.kind}`} role="status" data-testid="wb-toast">{toast.text}</div>}
    </div>
  );
}
