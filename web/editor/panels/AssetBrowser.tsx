import { useEffect, useMemo, useState } from 'react';
import { costumeLabelZh } from '@shared/catalog/labels';
import { CATEGORY_LABEL, reviewOf, searchBackgrounds } from '@shared/catalog/bgUi';
import { distinct } from '@shared/catalog/search';
import { bgCategoryOf } from '@shared/director/bgCategory';
import type { BgCategory } from '@shared/schema/assetLabels';
import type { BackgroundEntry, CharacterEntry, CompactCatalog, CompactModel, ModelEntry } from '@shared/schema/assets';
import { fetchCatalog, fetchModel } from '../../api';
import { deleteUploadedBackground, getBackgroundUsage } from '../../setup/setupApi';
import { deleteBgWarning, isUserBg } from '@shared/catalog/uploadBg';
import { BgDropOverlay, BgUploadButton, BgUploadStatus, useBgDrop, useBgUpload } from '../bg/BgUpload';
import { reloadCatalog } from '../useCatalog';
import { BgCard } from '../bg/BgCard';
import { useShowDecor } from '../bg/useShowDecor';

type Tab = 'characters' | 'backgrounds' | 'audio';
const PAGE = 60;

export function AssetBrowser() {
  const [catalog, setCatalog] = useState<CompactCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('characters');

  useEffect(() => {
    fetchCatalog().then(setCatalog, (e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="empty bad">素材索引失败：{error}</p>;
  if (!catalog) return <p className="empty">正在索引素材（首次全量索引可能需要数十秒）…</p>;

  const tabs: Array<[Tab, string, number]> = [
    ['characters', '角色 / 服装', catalog.models.length],
    ['backgrounds', '背景', catalog.backgrounds.length],
    ['audio', '音频', catalog.audio.length],
  ];
  return (
    <section className="browser" data-testid="asset-browser">
      <nav className="tabs" role="tablist">
        {tabs.map(([key, label, n]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label} <span className="count">{n}</span>
          </button>
        ))}
      </nav>
      {tab === 'characters' && <CharactersTab catalog={catalog} />}
      {tab === 'backgrounds' && <BackgroundsTab catalog={catalog} reload={() => fetchCatalog().then(setCatalog, () => {})} />}
      {tab === 'audio' && <AudioTab catalog={catalog} />}
    </section>
  );
}

function CharactersTab({ catalog }: { catalog: CompactCatalog }) {
  const [showLow, setShowLow] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);

  const visibleModels = useMemo(
    () => catalog.models.filter((m) => showLow || m.quality !== 'low'),
    [catalog.models, showLow],
  );
  const byChar = useMemo(() => {
    const map = new Map<string, CompactModel[]>();
    for (const m of visibleModels) (map.get(m.characterKey) ?? map.set(m.characterKey, []).get(m.characterKey)!).push(m);
    return map;
  }, [visibleModels]);

  const groups = useMemo(() => {
    const out: Array<{ band: string; members: CharacterEntry[] }> = [];
    const chars = catalog.characters.filter((c) => byChar.has(c.key));
    for (const band of catalog.bands) {
      const members = chars.filter((c) => c.bandKey === band.key);
      if (members.length) out.push({ band: band.name, members });
    }
    const rest = chars.filter((c) => !catalog.bands.some((b) => b.key === c.bandKey));
    for (const name of distinct(rest.map((c) => c.bandName))) out.push({ band: name, members: rest.filter((c) => c.bandName === name) });
    return out;
  }, [catalog, byChar]);

  const activeKey = selectedKey && byChar.has(selectedKey) ? selectedKey : (groups[0]?.members[0]?.key ?? null);
  const active = catalog.characters.find((c) => c.key === activeKey);
  const models = (activeKey && byChar.get(activeKey)) || [];

  return (
    <div className="split">
      <aside className="sidebar" data-testid="character-list">
        <label className="check">
          <input type="checkbox" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} /> 显示低画质（_low）
        </label>
        {groups.map((g) => (
          <div key={g.band} className="group">
            <h3>{g.band}</h3>
            {g.members.map((c) => (
              <button
                key={c.key}
                data-testid="character-item"
                className={c.key === activeKey ? 'char active' : 'char'}
                onClick={() => { setSelectedKey(c.key); setModelId(null); }}
              >
                <i className="swatch" style={{ background: c.color ?? '#556' }} />
                <span className="cname">{c.name}</span>
                <span className="count">{byChar.get(c.key)?.length}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <div className="content">
        {active && (
          <h2 className="heading">
            {active.name}
            <small>{[active.bandName, active.role, active.key].filter(Boolean).join(' · ')}</small>
          </h2>
        )}
        <div className="cards" data-testid="model-cards">
          {models.map((m) => (
            <ModelCard key={m.id} model={m} selected={m.id === modelId} onSelect={() => setModelId(m.id === modelId ? null : m.id)} />
          ))}
        </div>
        {modelId && <ModelDetail id={modelId} />}
      </div>
    </div>
  );
}

function ModelCard({ model: m, selected, onSelect }: { model: CompactModel; selected: boolean; onSelect: () => void }) {
  return (
    <button className={selected ? 'card active' : 'card'} data-testid="model-card" data-model-id={m.id} onClick={onSelect}>
      <div className="thumb">
        {m.preview ? <img src={m.preview} loading="lazy" decoding="async" alt={m.id} /> : <span className="nopreview">无预览</span>}
      </div>
      <div className="meta">
        <div className="mid">{m.id}</div>
        <div className="label">{costumeLabelZh(m.costumeInfo, m.costume)}</div>
        <div className="badges">
          <span className={m.mode === 'live' ? 'badge live' : 'badge'}>{m.mode === 'live' ? 'live 演奏' : 'adv'}</span>
          {m.quality === 'low' && <span className="badge warn">low</span>}
          {!m.hasPhysics && <span className="badge">无物理</span>}
          <span className="badge">{m.motionCount} 动作</span>
          <span className="badge">{m.expressionCount} 表情</span>
        </div>
      </div>
    </button>
  );
}

function ModelDetail({ id }: { id: string }) {
  const [state, setState] = useState<{ id: string; model?: ModelEntry; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetchModel(id).then(
      (model) => live && setState({ id, model }),
      (e: Error) => live && setState({ id, error: e.message }),
    );
    return () => { live = false; };
  }, [id]);

  if (!state || state.id !== id) return <div className="detail">加载 {id}…</div>;
  if (state.error || !state.model) return <div className="detail bad">{state.error}</div>;
  const m = state.model;
  const families = new Map<string, string[]>();
  for (const mo of m.motions) {
    const list = families.get(mo.family) ?? [];
    list.push(mo.side ?? '·');
    families.set(mo.family, list);
  }
  return (
    <div className="detail" data-testid="model-detail">
      <h3>{m.id}</h3>
      <p className="hint">
        {m.motions.length} 动作（{families.size} 家族）· {m.expressions.length} 表情 · {m.textureCount} 纹理
        {m.missingFiles.length > 0 && <span className="bad"> · 缺失文件 {m.missingFiles.length}</span>}
      </p>
      <h4>动作</h4>
      <div className="chips">
        {[...families].map(([fam, sides]) => (
          <span key={fam} className="chip" title={m.motions.filter((x) => x.family === fam).map((x) => x.name).join('\n')}>
            {fam}
            {sides.some((s) => s !== '·') && <em>{sides.join('')}</em>}
          </span>
        ))}
      </div>
      <h4>表情</h4>
      {m.expressions.length === 0 ? (
        <p className="hint">该模型没有表情。</p>
      ) : (
        <div className="chips">
          {m.expressions.map((e) => <span key={e.name} className="chip">{e.name}</span>)}
        </div>
      )}
    </div>
  );
}

function BackgroundsTab({ catalog, reload }: { catalog: CompactCatalog; reload: () => Promise<unknown> }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<'' | BgCategory>('');
  const [setting, setSetting] = useState('');
  const [time, setTime] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [band, setBand] = useState('');
  const [place, setPlace] = useState('');
  const [conf, setConf] = useState('');
  const [onlyStage, setOnlyStage] = useState(false);
  const [onlyUnknown, setOnlyUnknown] = useState(false);
  const [showDecor, setShowDecor] = useShowDecor();
  const [unfoldAll, setUnfoldAll] = useState(false);
  const [unfolded, setUnfolded] = useState<string[]>([]);
  const [fresh, setFresh] = useState<string[]>([]);
  const up = useBgUpload((ids) => {
    // show the new pictures: clear filters, pin them first
    setQuery(''); setCat(''); setSetting(''); setTime(''); setBand(''); setPlace(''); setConf(''); setOnlyStage(false); setOnlyUnknown(false); setLimit(PAGE);
    setFresh((f) => [...new Set([...ids, ...f])]);
    void Promise.all([reload(), reloadCatalog()]);
  });
  const drop = useBgDrop((fs) => void up.upload(fs));
  const remove = async (b: BackgroundEntry) => {
    try {
      // tell the user which projects still use the picture before it goes
      const usage = await getBackgroundUsage(b.id).catch(() => null);
      const warn = usage ? deleteBgWarning(usage.projects) : '删除这张上传的背景？无法确认是否有项目正在使用它，已使用它的项目会显示为缺失背景，且无法撤销。';
      if (!window.confirm(warn)) return;
      await deleteUploadedBackground(b.id);
      setFresh((f) => f.filter((x) => x !== b.id));
      await Promise.all([reload(), reloadCatalog()]);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const places = useMemo(() => distinct(catalog.backgrounds.map((b) => b.labels?.placeName ?? b.labels?.location ?? null)), [catalog.backgrounds]);
  const copiesOf = useMemo(() => {
    const m = new Map<string, BackgroundEntry[]>();
    for (const b of catalog.backgrounds) {
      const d = b.labels?.duplicateOf;
      if (d) m.set(d, [...(m.get(d) ?? []), b]);
    }
    return m;
  }, [catalog.backgrounds]);
  const base = useMemo(
    () => searchBackgrounds(catalog.backgrounds, query).filter((b) => {
      const l = b.labels;
      const c = bgCategoryOf(b);
      if (c === 'decor' && !showDecor && cat !== 'decor') return false;
      if (cat && c !== cat) return false;
      if (setting && b.setting !== setting) return false;
      if (time && b.time !== time) return false;
      if (band === '__unknown') { if (l && l.bands.length > 0) return false; } else if (band && !(l?.bands.includes(band))) return false;
      if (place && (l?.placeName ?? l?.location) !== place) return false;
      if (conf && l?.confidence !== conf) return false;
      if (onlyStage && !l?.stage) return false;
      if (onlyUnknown && reviewOf(b) === 'confirmed') return false;
      return true;
    }),
    [catalog.backgrounds, query, cat, setting, time, band, place, conf, onlyStage, onlyUnknown, showDecor],
  );
  // a duplicate copy is folded behind its master ("同一画面 ×N") unless unfolded; a copy whose master is filtered out is shown on its own
  const hits = useMemo(() => {
    const ids = new Set(base.map((b) => b.id));
    const out: BackgroundEntry[] = [];
    for (const b of base) {
      const master = b.labels?.duplicateOf;
      if (master && ids.has(master) && !unfoldAll && !unfolded.includes(master)) continue;
      out.push(b);
    }
    return fresh.length === 0 ? out : [...out.filter((b) => fresh.includes(b.id)).sort((a, b) => fresh.indexOf(a.id) - fresh.indexOf(b.id)), ...out.filter((b) => !fresh.includes(b.id))];
  }, [base, unfoldAll, unfolded, fresh]);
  const reset = (fn: (v: string) => void) => (e: { target: { value: string } }) => { fn(e.target.value); setLimit(PAGE); };
  const chips = <T extends string>(label: string, value: T | '', set: (v: T | '') => void, options: Array<[T, string]>, testid: string) => (
    <div className="bgx-chiprow" role="group" aria-label={label} data-testid={testid}>
      <span className="bgx-chiplabel">{label}</span>
      <button type="button" className={`bgx-chip ${value === '' ? 'on' : ''}`} onClick={() => { set(''); setLimit(PAGE); }}>全部</button>
      {options.map(([k, text]) => (
        <button key={k} type="button" className={`bgx-chip ${value === k ? 'on' : ''}`} onClick={() => { set(value === k ? '' : k); setLimit(PAGE); }} data-chip={k}>{text}</button>
      ))}
    </div>
  );
  const catOptions: Array<[BgCategory, string]> = [['scene', CATEGORY_LABEL.scene], ['insert', CATEGORY_LABEL.insert], ['event', CATEGORY_LABEL.event], ...(showDecor ? ([['decor', CATEGORY_LABEL.decor]] as Array<[BgCategory, string]>) : [])];
  const timeOptions = distinct(catalog.backgrounds.map((b) => b.time)).map((t) => [t, t] as [string, string]);
  return (
    <div className="content full bgx-dropzone" {...drop.handlers}>
      <BgDropOverlay show={drop.dragging} />
      <div className="filters bgx-filters">
        <BgUploadButton up={up} />
        <input type="search" placeholder="搜索标题 / 描述 / 标签 / 地点，多个词用空格（如 夜 卧室）" value={query} onChange={reset(setQuery)} aria-label="搜索背景" data-testid="bg-search" />
        <label className="sel"><input type="checkbox" checked={showDecor} onChange={(e) => { setShowDecor(e.target.checked); setLimit(PAGE); }} data-testid="bg-show-decor" />显示装饰素材</label>
        <label className="sel"><input type="checkbox" checked={unfoldAll} onChange={(e) => setUnfoldAll(e.target.checked)} data-testid="bg-unfold" />展开重复素材</label>
        <span className="hint" data-testid="bg-count">命中 {hits.length} / {catalog.backgrounds.length}</span>
      </div>
      <BgUploadStatus up={up} />
      <div className="bgx-filterbox">
        {chips('类别', cat, setCat, catOptions, 'bg-chips-category')}
        {chips('时段', time, setTime, timeOptions, 'bg-chips-time')}
        {chips('室内外', setting, setSetting, distinct(catalog.backgrounds.map((b) => b.setting)).map((t) => [t, t] as [string, string]), 'bg-chips-setting')}
        <div className="bgx-chiprow">
          <label className="sel">乐队
            <select value={band} onChange={reset(setBand)} data-testid="bg-filter-band">
              <option value="">全部</option>
              <option value="generic">通用</option>
              {catalog.bands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
              <option value="__unknown">未知</option>
            </select>
          </label>
          <label className="sel">地点
            <select value={place} onChange={reset(setPlace)} aria-label="地点"><option value="">全部</option>{places.map((o) => <option key={o} value={o}>{o}</option>)}</select>
          </label>
          <label className="sel">置信度
            <select value={conf} onChange={reset(setConf)} data-testid="bg-filter-conf"><option value="">全部</option><option value="confirmed">已确认</option><option value="likely">推测</option><option value="unknown">待确认</option></select>
          </label>
          <label className="sel"><input type="checkbox" checked={onlyStage} onChange={(e) => { setOnlyStage(e.target.checked); setLimit(PAGE); }} data-testid="bg-filter-stage" />仅舞台</label>
          <label className="sel"><input type="checkbox" checked={onlyUnknown} onChange={(e) => { setOnlyUnknown(e.target.checked); setLimit(PAGE); }} data-testid="bg-filter-unknown" />仅待确认</label>
        </div>
      </div>
      <div className="bgx-grid browser" data-testid="bg-cards">
        {hits.slice(0, limit).map((b) => {
          const copies = copiesOf.get(b.id) ?? [];
          const shownCopies = unfoldAll || unfolded.includes(b.id);
          return (
            <BgCard
              key={b.id} bg={b} copies={copies.length} className={fresh.includes(b.id) ? 'uploaded' : ''}
              {...(copies.length > 0 && !unfoldAll ? { onCopies: () => setUnfolded(shownCopies ? unfolded.filter((x) => x !== b.id) : [...unfolded, b.id]) } : {})}
            >
              {isUserBg(b.id) && <button type="button" className="btn bgx-del" onClick={(e) => { e.stopPropagation(); void remove(b); }} data-testid="bg-delete">删除</button>}
            </BgCard>
          );
        })}
      </div>
      {hits.length > limit && (
        <button className="more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {hits.length - limit} 张）</button>
      )}
      {hits.length === 0 && <p className="empty">没有匹配的背景。</p>}
    </div>
  );
}

function AudioTab({ catalog }: { catalog: CompactCatalog }) {
  if (catalog.audio.length === 0) {
    return <p className="empty">没有音频。素材库 media/ 为空；可通过 AUDIO_ROOTS 配置外部音频目录。</p>;
  }
  return (
    <div className="content full">
      <ul className="audio-list" data-testid="audio-list">
        {catalog.audio.map((a) => (
          <li key={a.id} data-testid="audio-item">
            <div>
              <strong>{a.name}</strong>
              <span className="hint"> {a.source === 'media' ? '素材库' : '用户导入'} · {a.ext} · {(a.bytes / 1048576).toFixed(1)} MB</span>
            </div>
            <audio controls preload="none" src={a.url} />
          </li>
        ))}
      </ul>
    </div>
  );
}
