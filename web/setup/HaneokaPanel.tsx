import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError, acceptSource, downloadManifest, getHaneokaList, getSource,
  type HaneokaList, type SourceInfo,
} from './setupApi';

const SHOW_LIMIT = 80;

export function HaneokaPanel({ onGoImport }: { onGoImport: () => void }) {
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const [list, setList] = useState<HaneokaList | null>(null);
  const [locale, setLocale] = useState('zh-CN');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [showLow, setShowLow] = useState(false);
  const [bgKind, setBgKind] = useState<'all' | 'story' | 'card'>('all');
  const [bgQuery, setBgQuery] = useState('');
  const [pickedM, setPickedM] = useState<Set<string>>(new Set());
  const [pickedB, setPickedB] = useState<Set<string>>(new Set());
  const [made, setMade] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSource().then(setInfo, (e: Error) => setErr(e.message));
  }, []);

  const load = async (refresh = false) => {
    setBusy(true);
    setErr(null);
    try {
      setList((await getHaneokaList(locale, refresh)).list);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'disclaimer_required') setInfo((i) => (i ? { ...i, accepted: false } : i));
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (info?.accepted) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.accepted, locale]);

  const onScroll = () => {
    const el = box.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) setAtEnd(true);
  };
  useEffect(() => {
    const el = box.current;
    if (el && el.scrollHeight <= el.clientHeight + 4) setAtEnd(true); // short text: nothing to scroll
  }, [info]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setter(n);
    setMade(false);
  };

  const visibleBgs = useMemo(() => {
    if (!list) return [];
    const q = bgQuery.trim().toLowerCase();
    return list.backgrounds.filter((b) => (bgKind === 'all' || b.kind === bgKind) && (!onlyMissing || !b.have) && (!q || `${b.id} ${b.name ?? ''} ${b.place ?? ''} ${b.band ?? ''}`.toLowerCase().includes(q)));
  }, [list, bgKind, onlyMissing, bgQuery]);

  if (!info) return <p className="hint">{err ?? '读取中…'}</p>;

  if (!info.accepted) {
    return (
      <div data-testid="disclaimer">
        <h4>使用前请阅读</h4>
        <div className="disclaimer-box" ref={box} onScroll={onScroll} tabIndex={0} data-testid="disclaimer-text">
          {info.disclaimer.map((p, i) => <p key={i}>{p}</p>)}
          <p className="hint">（滚动到底部后才能确认）</p>
        </div>
        <div className="row-actions">
          <button className="btn primary" disabled={!atEnd} onClick={() => void acceptSource(info.disclaimerVersion).then(() => setInfo({ ...info, accepted: true }), (e: Error) => setErr(e.message))} data-testid="disclaimer-accept">我已阅读并同意</button>
        </div>
        {err && <p className="bad">{err}</p>}
      </div>
    );
  }

  const selected = pickedM.size + pickedB.size;
  const selModels = list ? list.bands.flatMap((b) => b.characters.flatMap((c) => c.models.filter((m) => pickedM.has(m.id)).map((m) => ({ ...m, group: `${b.name} / ${c.name}` })))) : [];
  const selBgs = list ? list.backgrounds.filter((b) => pickedB.has(b.id)) : [];

  return (
    <div data-testid="haneoka-panel">
      <p className="hint">只读取站点公开的元数据，对比本地缺少哪些，生成清单。<b>不下载任何素材</b>；每项只链接到 Haneoka 的页面，请在页面上自行下载，再回到“本地导入”。</p>
      <div className="row-actions">
        <label>站点语言 <select value={locale} onChange={(e) => setLocale(e.target.value)} data-testid="hk-locale">{info.locales.map((l) => <option key={l}>{l}</option>)}</select></label>
        <label className="check"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />只显示本地没有的</label>
        <label className="check"><input type="checkbox" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} />显示低模（_low）</label>
        <button className="btn" disabled={busy} onClick={() => void load(true)}>重新读取</button>
      </div>
      {busy && <p className="hint">读取站点索引…</p>}
      {err && <p className="bad" data-testid="hk-error">{err}</p>}
      {list && (
        <>
          <p className="hint" data-testid="hk-counts">站点共 {list.counts.models} 个模型（本地缺 {list.counts.modelsMissing}）· {list.counts.backgrounds} 张背景（缺 {list.counts.backgroundsMissing}）· release {list.releaseId ?? '未知'} · 单个模型通常 5–50 MB，背景约 2 MB/张</p>
          <div className="hk-cols">
            <div className="hk-tree" data-testid="hk-models">
              <h4>模型</h4>
              {list.bands.map((b) => {
                const chars = b.characters.map((c) => ({ ...c, models: c.models.filter((m) => (!onlyMissing || !m.have) && (showLow || !m.low)) })).filter((c) => c.models.length > 0);
                if (chars.length === 0) return null;
                return (
                  <details key={b.key} open={b.key === 'mygo'}>
                    <summary>{b.name}</summary>
                    {chars.map((c) => (
                      <details key={c.key} className="hk-char">
                        <summary>{c.name}（{c.models.length}）</summary>
                        <ul>
                          {c.models.map((m) => (
                            <li key={m.id}><label className="check"><input type="checkbox" checked={pickedM.has(m.id)} onChange={() => toggle(pickedM, setPickedM, m.id)} data-testid={`pick-model-${m.id}`} /><span>{m.id}{m.have ? '（已有）' : ''}</span></label></li>
                          ))}
                        </ul>
                      </details>
                    ))}
                  </details>
                );
              })}
            </div>
            <div className="hk-tree" data-testid="hk-backgrounds">
              <h4>背景</h4>
              <div className="row-actions">
                <select value={bgKind} onChange={(e) => setBgKind(e.target.value as typeof bgKind)}><option value="all">全部</option><option value="story">剧情背景</option><option value="card">名片背景</option></select>
                <input className="text" type="search" placeholder="按 id / 地点 / 乐队筛选" value={bgQuery} onChange={(e) => setBgQuery(e.target.value)} data-testid="hk-bg-query" />
              </div>
              <ul>
                {visibleBgs.slice(0, SHOW_LIMIT).map((b) => (
                  <li key={b.id}><label className="check"><input type="checkbox" checked={pickedB.has(b.id)} onChange={() => toggle(pickedB, setPickedB, b.id)} data-testid={`pick-bg-${b.id}`} />
                    <span>{b.kind === 'card' ? `名片 ${b.id} ${b.name ?? ''}` : b.id}<span className="hint">{b.place ? ` · ${b.place}` : b.labelled ? '' : ' · 无标签'}{b.band ? ` · ${b.band}` : ''}</span></span></label></li>
                ))}
              </ul>
              {visibleBgs.length > SHOW_LIMIT && <p className="hint">仅显示前 {SHOW_LIMIT} 项（共 {visibleBgs.length}），请用上面的筛选缩小范围。</p>}
            </div>
          </div>
          <div className="row-actions">
            <button className="btn primary" disabled={selected === 0} onClick={() => setMade(true)} data-testid="hk-make">生成清单（{selected}）</button>
            <button className="btn" disabled={selected === 0} onClick={() => void downloadManifest({ models: [...pickedM], backgrounds: [...pickedB], format: 'md', locale })} data-testid="hk-export-md">导出 Markdown</button>
            <button className="btn" disabled={selected === 0} onClick={() => void downloadManifest({ models: [...pickedM], backgrounds: [...pickedB], format: 'csv', locale })} data-testid="hk-export-csv">导出 CSV</button>
          </div>
          {made && selected > 0 && (
            <div data-testid="hk-manifest">
              <h4>清单（{selected} 项）</h4>
              <table className="tbl">
                <thead><tr><th>类型</th><th>id</th><th>说明</th><th>站点页面</th></tr></thead>
                <tbody>
                  {selModels.map((m) => <tr key={m.id}><td>模型</td><td>{m.id}</td><td>{m.group} · 在查看器点 “Download model ZIP”</td><td><a href={m.url} target="_blank" rel="noreferrer noopener">在站点打开</a></td></tr>)}
                  {selBgs.map((b) => <tr key={b.id}><td>{b.kind === 'card' ? '名片背景' : '剧情背景'}</td><td>{b.id}</td><td>{b.kind === 'story' ? `在站点资源页搜索 ${b.id}，保存为 ${b.id}.png` : `保存为 ${b.id}.png`}</td><td><a href={b.url} target="_blank" rel="noreferrer noopener">在站点打开</a></td></tr>)}
                </tbody>
              </table>
              <p className="hint">下载由你在站点上自行完成（素材版权属权利人，请确认你有权使用）。下载好之后：<button className="linklike" onClick={onGoImport}>回到“本地导入”</button>。</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
