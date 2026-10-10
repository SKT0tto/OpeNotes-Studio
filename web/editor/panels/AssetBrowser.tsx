import { useEffect, useMemo, useState } from 'react';
import { costumeLabelZh } from '@shared/catalog/labels';
import { distinct, filterBackgrounds } from '@shared/catalog/search';
import type { CharacterEntry, CompactCatalog, CompactModel, ModelEntry } from '@shared/schema/assets';
import { fetchCatalog, fetchModel } from '../../api';
import { resetCatalogCache } from '../useCatalog';
import { LabelBadges, LabelEditor } from './BgLabelUi';

type Tab = 'characters' | 'backgrounds' | 'audio';
const KIND_LABEL: Record<string, string> = { scene: '场景', insert: '插图', decorative: '装饰' };
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
      {tab === 'backgrounds' && <BackgroundsTab catalog={catalog} onChanged={async () => { resetCatalogCache(); setCatalog(await fetchCatalog()); }} />}
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

function BackgroundsTab({ catalog, onChanged }: { catalog: CompactCatalog; onChanged: () => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [setting, setSetting] = useState('');
  const [time, setTime] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [band, setBand] = useState('');
  const [place, setPlace] = useState('');
  const [conf, setConf] = useState('');
  const [onlyStage, setOnlyStage] = useState(false);
  const [onlyUnknown, setOnlyUnknown] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);

  const places = useMemo(() => distinct(catalog.backgrounds.map((b) => b.labels?.placeName ?? b.labels?.location ?? null)), [catalog.backgrounds]);
  const kinds = useMemo(() => distinct(catalog.backgrounds.map((b) => b.kind)), [catalog.backgrounds]);
  const settings = useMemo(() => distinct(catalog.backgrounds.map((b) => b.setting)), [catalog.backgrounds]);
  const times = useMemo(() => distinct(catalog.backgrounds.map((b) => b.time)), [catalog.backgrounds]);
  const hits = useMemo(
    () => filterBackgrounds(catalog.backgrounds, { query, kind, setting, time }).filter((b) => {
      const l = b.labels;
      if (band === '__unknown') { if (l && l.bands.length > 0) return false; } else if (band && !(l?.bands.includes(band))) return false;
      if (place && (l?.placeName ?? l?.location) !== place) return false;
      if (conf && l?.confidence !== conf) return false;
      if (onlyStage && !l?.stage) return false;
      if (onlyUnknown && !(l?.confidence === 'unknown' || (l && l.bands.length === 0))) return false;
      return true;
    }),
    [catalog.backgrounds, query, kind, setting, time, band, place, conf, onlyStage, onlyUnknown],
  );
  const selected = useMemo(() => catalog.backgrounds.filter((b) => sel.includes(b.id)), [catalog.backgrounds, sel]);
  const click = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor) {
      const ids = hits.map((b) => b.id);
      const [a, z] = [ids.indexOf(anchor), ids.indexOf(id)];
      if (a >= 0 && z >= 0) return setSel([...new Set([...sel, ...ids.slice(Math.min(a, z), Math.max(a, z) + 1)])]);
    }
    setAnchor(id);
    if (e.ctrlKey || e.metaKey) setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
    else setSel(sel.length === 1 && sel[0] === id ? [] : [id]);
  };
  const samePlace = () => {
    const p = selected[0]?.labels?.placeName ?? selected[0]?.labels?.location;
    if (p) setSel(catalog.backgrounds.filter((b) => (b.labels?.placeName ?? b.labels?.location) === p).map((b) => b.id));
  };

  const reset = (fn: (v: string) => void) => (e: { target: { value: string } }) => { fn(e.target.value); setLimit(PAGE); };
  return (
    <div className="content full">
      <div className="filters">
        <input type="search" placeholder="搜索名称 / 别名 / 描述，多个词用空格（如 RiNG 夜间）" value={query} onChange={reset(setQuery)} aria-label="搜索背景" />
        <Select label="类型" value={kind} onChange={reset(setKind)} options={kinds} render={(k) => KIND_LABEL[k] ?? k} />
        <Select label="场所" value={setting} onChange={reset(setSetting)} options={settings} />
        <Select label="时间" value={time} onChange={reset(setTime)} options={times} />
        <label className="sel">乐队
          <select value={band} onChange={reset(setBand)} data-testid="bg-filter-band">
            <option value="">全部</option>
            <option value="generic">通用</option>
            {catalog.bands.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
            <option value="__unknown">未知</option>
          </select>
        </label>
        <Select label="地点" value={place} onChange={reset(setPlace)} options={places} />
        <label className="sel">置信度
          <select value={conf} onChange={reset(setConf)} data-testid="bg-filter-conf"><option value="">全部</option><option value="confirmed">已确认</option><option value="likely">推测</option><option value="unknown">待确认</option></select>
        </label>
        <label className="sel"><input type="checkbox" checked={onlyStage} onChange={(e) => { setOnlyStage(e.target.checked); setLimit(PAGE); }} data-testid="bg-filter-stage" />仅舞台</label>
        <label className="sel"><input type="checkbox" checked={onlyUnknown} onChange={(e) => { setOnlyUnknown(e.target.checked); setLimit(PAGE); }} data-testid="bg-filter-unknown" />仅未知/待确认</label>
        <span className="hint" data-testid="bg-count">命中 {hits.length} / {catalog.backgrounds.length}</span>
      </div>
      {selected.length > 0 && (
        <div className="label-bar">
          <LabelEditor key={sel.join(',')} catalog={catalog} selected={selected} onChanged={onChanged} />
          <div className="row-actions">
            <button className="btn" onClick={samePlace} data-testid="le-same-place">选中同一地点的全部变体</button>
            <button className="btn" onClick={() => setSel(hits.map((b) => b.id))} data-testid="le-select-hits">选中全部命中（{hits.length}）</button>
            <button className="btn" onClick={() => setSel([])}>取消选择</button>
          </div>
        </div>
      )}
      <div className="cards bg" data-testid="bg-cards">
        {hits.slice(0, limit).map((b) => (
          <figure key={b.id} className={`card bgcard${sel.includes(b.id) ? ' selected' : ''}`} data-testid="bg-card" data-bg-id={b.id} data-selected={sel.includes(b.id)} title={b.description ?? undefined} onClick={(e) => click(e, b.id)}>
            <div className="thumb wide"><img src={b.url} loading="lazy" decoding="async" alt={b.name} /></div>
            <figcaption className="meta">
              <div className="mid">{b.name}</div>
              <div className="label">#{b.id} · {b.width}×{b.height}</div>
              <div className="badges">
                {b.kind && <span className="badge">{KIND_LABEL[b.kind] ?? b.kind}</span>}
                {b.setting && <span className="badge">{b.setting}</span>}
                {b.time && <span className="badge">{b.time}</span>}
                <LabelBadges label={b.labels} catalog={catalog} />
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
      {hits.length > limit && (
        <button className="more" onClick={() => setLimit(limit + PAGE)}>显示更多（还有 {hits.length - limit} 张）</button>
      )}
      {hits.length === 0 && <p className="empty">没有匹配的背景。</p>}
    </div>
  );
}

function Select(props: {
  label: string; value: string; options: string[]; onChange: (e: { target: { value: string } }) => void; render?: (v: string) => string;
}) {
  return (
    <label className="sel">
      {props.label}
      <select value={props.value} onChange={props.onChange}>
        <option value="">全部</option>
        {props.options.map((o) => <option key={o} value={o}>{props.render?.(o) ?? o}</option>)}
      </select>
    </label>
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
