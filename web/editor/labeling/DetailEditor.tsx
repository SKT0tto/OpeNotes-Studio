/**
 * Per-background detail editor of the labelling workbench: title, description, place (+ sub-area), residents (searchable across all bands), bands, access,
 * category, time, indoor/outdoor, stage, tags. Only the fields the user touched are written; saving marks the label confirmed / source user.
 * Ctrl+Enter saves, Esc discards the draft.
 */
import { useMemo, useState } from 'react';
import { CATEGORY_LABEL, INDOOR_LABEL, TIME_LABEL, bandColor } from '@shared/catalog/bgUi';
import { homePatch, homeTitle, searchCharacters } from '@shared/catalog/bgHome';
import { BG_ACCESS, BG_CATEGORIES, GENERIC_BAND, type BgLabel, type BgLabelPatch } from '@shared/schema/assetLabels';
import type { BackgroundEntry } from '@shared/schema/assets';
import { BANDS, CHARACTERS, bandNameOfKey } from '../bg/BgCard';

const ACCESS_LABEL: Record<string, string> = { public: '公共', school: '学校', band: '乐队', private: '私人', abstract: '抽象' };

interface Draft {
  title: string; description: string; placeName: string; bands: string[]; residents: string[]; access: BgLabel['access']; category: NonNullable<BgLabel['category']>;
  time: BgLabel['time']; indoor: BgLabel['indoor']; stage: boolean; exclusive: boolean; tags: string[];
}
const draftOf = (b: BackgroundEntry): Draft => {
  const l = b.labels!;
  return {
    title: l.title ?? b.name, description: l.description ?? b.description ?? '', placeName: l.placeName ?? l.location ?? '', bands: l.bands,
    residents: l.residents ?? (l.ownerKey ? [l.ownerKey] : []), access: l.access, category: l.category ?? 'scene', time: l.time, indoor: l.indoor, stage: l.stage,
    exclusive: l.exclusive, tags: l.tags ?? [],
  };
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const nameOf = (k: string) => CHARACTERS.find((c) => c.key === k)?.name ?? k;

/** The label patch holding only the fields that differ from the saved label. */
function draftPatch(base: Draft, d: Draft, bg: BackgroundEntry): BgLabelPatch {
  const p: BgLabelPatch = {};
  if (d.title.trim() && d.title.trim() !== base.title) p.title = d.title.trim();
  if (d.description !== base.description) p.description = d.description;
  if (d.placeName.trim() !== base.placeName) p.placeName = d.placeName.trim() || null;
  if (!same(d.bands, base.bands)) p.bands = d.bands;
  if (!same(d.residents, base.residents)) {
    p.residents = d.residents;
    const first = d.residents[0];
    p.ownerKey = first ?? null;
    p.owner = first ? nameOf(first) : null;
  }
  if (d.access !== base.access) p.access = d.access;
  if (d.category !== base.category) p.category = d.category;
  if (d.time !== base.time) p.time = d.time;
  if (d.indoor !== base.indoor) p.indoor = d.indoor;
  if (d.stage !== base.stage) p.stage = d.stage;
  if (d.exclusive !== base.exclusive) p.exclusive = d.exclusive;
  if (!same(d.tags, base.tags)) p.tags = d.tags;
  if (Object.keys(p).length > 0) p.confidence = (p.bands ?? bg.labels!.bands).length > 0 ? 'confirmed' : bg.labels!.confidence;
  return p;
}

export function DetailEditor({ bg, places, onSave }: { bg: BackgroundEntry; places: string[]; onSave: (patch: BgLabelPatch, desc: string) => void }) {
  const base = useMemo(() => draftOf(bg), [bg]);
  const [d, setD] = useState<Draft>(base);
  const [area, setArea] = useState('');
  const [q, setQ] = useState('');
  const [tagIn, setTagIn] = useState('');
  const [homeFor, setHomeFor] = useState(false);
  const patch = draftPatch(base, d, bg);
  const dirty = Object.keys(patch).length > 0;
  const upd = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const found = searchCharacters(CHARACTERS, q, bandNameOfKey).filter((c) => !d.residents.includes(c.key)).slice(0, 8);

  const save = () => {
    if (dirty) onSave(patch, `编辑「${bg.name}」`);
  };
  const setHome = (key: string) => {
    const c = CHARACTERS.find((x) => x.key === key)!;
    const h = homePatch(c, area, d.time);
    upd({ title: h.title!, placeName: h.placeName!, bands: h.bands!, residents: h.residents!, access: 'private', exclusive: true });
    setHomeFor(false);
    setQ('');
  };
  const addTag = () => {
    const t = tagIn.trim();
    if (t && !d.tags.includes(t)) upd({ tags: [...d.tags, t] });
    setTagIn('');
  };
  const toggleBand = (k: string) => upd({ bands: d.bands.includes(k) ? d.bands.filter((x) => x !== k) : k === GENERIC_BAND ? [GENERIC_BAND] : [...d.bands.filter((x) => x !== GENERIC_BAND), k] });
  const field = (label: string, body: React.ReactNode) => <label className="wbd-field"><span>{label}</span>{body}</label>;
  const pick = <T extends string>(items: readonly T[], label: (t: T) => string, cur: T, set: (t: T) => void, id: string) => (
    <div className="wb-chips">{items.map((t) => <button key={t} type="button" className={`wb-chip plain ${cur === t ? 'on' : ''}`} onClick={() => set(t)} aria-pressed={cur === t} data-testid={`wbd-${id}-${t}`}>{label(t)}</button>)}</div>
  );

  return (
    <div className="wbd" data-testid="wbd" onKeyDown={(e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { setD(base); setArea(''); setQ(''); }
    }}>
      <div className="wbd-head">
        <h2>详细编辑</h2>
        <span className={`wbd-state ${dirty ? 'dirty' : ''}`} data-testid="wbd-state">{dirty ? '● 有未保存的修改' : '已保存'}</span>
      </div>
      {field('标题', <input value={d.title} onChange={(e) => upd({ title: e.target.value })} data-testid="wbd-title" />)}
      {field('描述', <textarea rows={4} value={d.description} onChange={(e) => upd({ description: e.target.value })} data-testid="wbd-desc" />)}
      {field('地点', <input list="wbd-places" value={d.placeName} onChange={(e) => upd({ placeName: e.target.value })} data-testid="wbd-place" placeholder="例如 三角初华家" />)}
      <datalist id="wbd-places">{places.map((p) => <option key={p} value={p} />)}</datalist>
      {field('房间 / 区域', (
        <span className="wbd-row">
          <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="可选，例如 阁楼" data-testid="wbd-area" />
          <button type="button" className="wb-btn" onClick={() => upd({ title: homeTitle(d.placeName.trim().replace(/家$/, ''), area, d.time) })} disabled={!d.placeName.trim()} data-testid="wbd-title-suggest" title="用 地点 + 区域 + 时段 生成标题">生成标题</button>
        </span>
      ))}
      <section>
        <h3>主人 / 住户</h3>
        <div className="wb-chips" data-testid="wbd-residents">
          {d.residents.length === 0 && <span className="sub">无主人</span>}
          {d.residents.map((k) => <button key={k} type="button" className="wb-chip person on" style={{ ['--c' as string]: bandColor(CHARACTERS.find((c) => c.key === k)?.band) }} onClick={() => upd({ residents: d.residents.filter((x) => x !== k) })} title="点击移除" data-testid={`wbd-res-${k}`}><span className="av">{nameOf(k).slice(0, 1)}</span>{nameOf(k)} ×</button>)}
          {d.residents.length > 0 && <button type="button" className="wb-chip plain" onClick={() => upd({ residents: [] })} data-testid="wbd-no-owner">无主人</button>}
        </div>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索角色：初华 / Uika / 乐队名" aria-label="搜索角色" data-testid="wbd-char-search" />
        {found.length > 0 && (
          <div className="wb-chips" style={{ marginTop: 6 }} data-testid="wbd-char-results">
            {found.map((c) => (
              <span key={c.key} style={{ display: 'inline-flex', gap: 3 }}>
                <button type="button" className="wb-chip person" style={{ ['--c' as string]: bandColor(c.band) }} onClick={() => { upd({ residents: [...d.residents, c.key] }); setQ(''); }} data-testid={`wbd-add-${c.key}`}><span className="av">{c.name.slice(0, 1)}</span>{c.name}</button>
                <button type="button" className="wb-chip plain" onClick={() => setHome(c.key)} title="设为他的家" data-testid={`wbd-home-${c.key}`}>设为家</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <button type="button" className="wb-btn" onClick={() => setHomeFor((v) => !v)} data-testid="wbd-sethome">设为某人的家…</button>
          {homeFor && <span className="sub" style={{ marginLeft: 6 }}>在上面的搜索框找到角色，点「设为家」</span>}
        </div>
      </section>
      <section>
        <h3>乐队</h3>
        <div className="wb-chips" data-testid="wbd-bands">
          {BANDS.map((b) => <button key={b.key} type="button" className={`wb-chip ${d.bands.includes(b.key) ? 'on' : ''}`} style={{ ['--c' as string]: bandColor(b.key) }} onClick={() => toggleBand(b.key)} aria-pressed={d.bands.includes(b.key)} data-testid={`wbd-band-${b.key}`}>{b.name}</button>)}
          <button type="button" className={`wb-chip ${d.bands.includes(GENERIC_BAND) ? 'on' : ''}`} style={{ ['--c' as string]: bandColor(GENERIC_BAND) }} onClick={() => toggleBand(GENERIC_BAND)} data-testid="wbd-band-generic">通用</button>
          <button type="button" className={`wb-chip plain ${d.bands.length === 0 ? 'on' : ''}`} onClick={() => upd({ bands: [] })} data-testid="wbd-band-unknown">？未知</button>
        </div>
      </section>
      <section>
        <h3>访问</h3>
        {pick(BG_ACCESS, (t) => ACCESS_LABEL[t] ?? t, d.access, (access) => upd({ access }), 'access')}
        <label className="wbd-check"><input type="checkbox" checked={d.exclusive} onChange={(e) => upd({ exclusive: e.target.checked })} data-testid="wbd-exclusive" /> 专属（只有上面的乐队能用作主场）</label>
      </section>
      <section><h3>类别</h3>{pick(BG_CATEGORIES, (t) => CATEGORY_LABEL[t], d.category, (category) => upd({ category }), 'cat')}</section>
      <section><h3>时段</h3>{pick(['day', 'dusk', 'night', 'unspecified'] as const, (t) => TIME_LABEL[t]!, d.time, (time) => upd({ time }), 'time')}</section>
      <section>
        <h3>室内外 · 舞台</h3>
        {pick(['indoor', 'outdoor', 'abstract', 'screen'] as const, (t) => INDOOR_LABEL[t]!, d.indoor, (indoor) => upd({ indoor }), 'indoor')}
        <label className="wbd-check"><input type="checkbox" checked={d.stage} onChange={(e) => upd({ stage: e.target.checked })} data-testid="wbd-stage" /> 可作舞台</label>
      </section>
      <section>
        <h3>标签</h3>
        <div className="wb-chips">{d.tags.map((t) => <button key={t} type="button" className="wb-chip plain" onClick={() => upd({ tags: d.tags.filter((x) => x !== t) })} title="点击移除">{t} ×</button>)}</div>
        <input value={tagIn} onChange={(e) => setTagIn(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); addTag(); } }} placeholder="输入标签，回车添加" data-testid="wbd-tag-input" style={{ marginTop: 6 }} />
      </section>
      <p className="sub" style={{ margin: 0 }}>保存后这张图标为「已确认」（来源：你）。<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 保存，<kbd>Esc</kbd> 放弃修改。</p>
      <div className="wbd-actions">
        <button type="button" className="wb-btn primary" disabled={!dirty} onClick={save} data-testid="wbd-save">保存</button>
        <button type="button" className="wb-btn" disabled={!dirty} onClick={() => { setD(base); setArea(''); }} data-testid="wbd-cancel">放弃修改</button>
      </div>
    </div>
  );
}
