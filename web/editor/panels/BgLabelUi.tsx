import { useMemo, useState } from 'react';
import { bandText } from '@shared/director/bandFit';
import { BG_ACCESS, GENERIC_BAND, type BgLabel, type BgLabelPatch } from '@shared/schema/assetLabels';
import type { BackgroundEntry, CompactCatalog } from '@shared/schema/assets';
import { patchLabels, putLabel } from '../../labelsApi';

export const CONF_LABEL: Record<string, string> = { confirmed: '已确认', likely: '推测', unknown: '待确认' };
export const ACCESS_LABEL: Record<string, string> = { public: '公共', school: '学校', band: '乐队据点', private: '私宅', abstract: '插入/装饰' };

export const bandNameOf = (catalog: CompactCatalog) => (k: string) => catalog.bands.find((b) => b.key === k)?.name ?? k;

/** Badges shown on a background card. */
export function LabelBadges({ label, catalog }: { label: BgLabel | undefined; catalog: CompactCatalog }) {
  if (!label) return <span className="badge">未标注</span>;
  const unknown = label.bands.length === 0;
  return (
    <>
      <span className={`badge ${unknown ? 'warn' : ''}`} data-testid="bg-band" title={label.evidence}>{unknown ? '？乐队未知' : bandText(label, bandNameOf(catalog))}</span>
      {(label.placeName ?? label.location) && <span className="badge" data-testid="bg-place">{label.placeName ?? label.location}</span>}
      {label.owner && <span className="badge" data-testid="bg-owner">主人 {label.owner.split('（')[0]}</span>}
      {label.stage && <span className="badge live" data-testid="bg-stage">舞台</span>}
      <span className={`badge ${label.confidence === 'confirmed' ? '' : 'warn'}`} data-testid="bg-conf">{CONF_LABEL[label.confidence]}</span>
    </>
  );
}

/** Single / batch label editor. Only the touched fields are sent (PATCH merge); one undo step per save. */
export function LabelEditor({ catalog, selected, onChanged }: { catalog: CompactCatalog; selected: BackgroundEntry[]; onChanged: () => Promise<void> }) {
  const [patch, setPatch] = useState<BgLabelPatch>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<BgLabel[][]>([]);
  const first = selected[0]?.labels;
  const val = <K extends keyof BgLabelPatch>(k: K): BgLabelPatch[K] => (k in patch ? patch[k] : (first?.[k as keyof BgLabel] as BgLabelPatch[K]));
  const set = (p: BgLabelPatch) => setPatch((s) => ({ ...s, ...p }));
  const bands = (val('bands') as string[] | undefined) ?? [];
  const toggleBand = (k: string) => {
    if (k === GENERIC_BAND) return set({ bands: bands.includes(k) ? [] : [GENERIC_BAND] });
    const rest = bands.filter((b) => b !== GENERIC_BAND);
    set({ bands: rest.includes(k) ? rest.filter((b) => b !== k) : [...rest, k] });
  };
  const dirty = Object.keys(patch).length > 0;
  const ids = useMemo(() => selected.map((b) => b.id), [selected]);
  const complete = selected.every((b) => b.labels);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(async () => {
    const before = selected.flatMap((b) => (b.labels ? [{ ...b.labels, __id: b.id } as BgLabel & { __id: string }] : []));
    await patchLabels(ids, { ...patch, confidence: patch.confidence ?? 'confirmed' });
    setUndo((u) => [...u, before]);
    setPatch({});
  });
  const undoLast = () => run(async () => {
    const last = undo.at(-1);
    if (!last) return;
    for (const l of last) await putLabel((l as BgLabel & { __id: string }).__id, l);
    setUndo((u) => u.slice(0, -1));
  });

  return (
    <div className="label-editor" data-testid="label-editor">
      <strong>标注 {selected.length === 1 ? `#${selected[0]!.id}` : `${selected.length} 张`}</strong>
      <div className="chips" role="group" aria-label="可用乐队">
        <label className="chip"><input type="checkbox" checked={bands.includes(GENERIC_BAND)} onChange={() => toggleBand(GENERIC_BAND)} data-testid="le-band-generic" />通用</label>
        {catalog.bands.map((b) => (
          <label key={b.key} className="chip"><input type="checkbox" checked={bands.includes(b.key)} onChange={() => toggleBand(b.key)} data-testid={`le-band-${b.key}`} />{b.name}</label>
        ))}
        <span className="hint">{bands.length === 0 ? '未选 = 未知' : ''}</span>
      </div>
      <label className="sel"><input type="checkbox" checked={!!val('exclusive')} onChange={(e) => set({ exclusive: e.target.checked })} />专属（其他乐队不可用）</label>
      <label className="sel"><input type="checkbox" checked={!!val('stage')} onChange={(e) => set({ stage: e.target.checked })} data-testid="le-stage" />可作正式演出舞台</label>
      <label className="sel">范围
        <select value={(val('access') as string | undefined) ?? ''} onChange={(e) => set({ access: e.target.value as BgLabel['access'] })} data-testid="le-access">
          {!first && <option value="">—</option>}
          {BG_ACCESS.map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
        </select>
      </label>
      <label className="sel">置信度
        <select value={(val('confidence') as string | undefined) ?? 'confirmed'} onChange={(e) => set({ confidence: e.target.value as BgLabel['confidence'] })} data-testid="le-conf">
          {Object.entries(CONF_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="sel">地点 <input className="text" value={(val('placeName') as string | null | undefined) ?? ''} onChange={(e) => set({ placeName: e.target.value || null })} /></label>
      <label className="sel">依据 <input className="text" value={(val('evidence') as string | undefined) ?? ''} onChange={(e) => set({ evidence: e.target.value })} /></label>
      <div className="row-actions">
        <button className="btn primary" disabled={busy || !dirty || !complete} onClick={() => void save()} data-testid="le-save">保存到 {selected.length} 张</button>
        <button className="btn" disabled={busy || !dirty} onClick={() => setPatch({})}>重置</button>
        <button className="btn" disabled={busy || undo.length === 0} onClick={() => void undoLast()} data-testid="le-undo">撤销上次保存</button>
      </div>
      {error && <p className="bad" data-testid="le-error">{error}</p>}
    </div>
  );
}
