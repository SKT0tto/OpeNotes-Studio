import { useRef, useState } from 'react';
import {
  cancelImport, cancelJob, getImportTarget, replanImport, runImport, scanImport, setImportTarget, uploadImport, waitForJob,
  type ImportPlan, type ImportResult, type ImportTarget, type JobState,
} from './setupApi';
import { useEffect } from 'react';

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;
const STATUS: Record<string, string> = { new: '新增', duplicate: '已存在（相同）', conflict: '已存在（不同）', error: '错误', unrecognized: '无法识别' };

export function ImportPanel({ onChanged }: { onChanged: () => void }) {
  const [path, setPath] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [ids, setIds] = useState<Record<string, string>>({});
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [prog, setProg] = useState<JobState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [target, setTarget] = useState<ImportTarget | null>(null);
  const [newTarget, setNewTarget] = useState('');
  const [targetMsg, setTargetMsg] = useState<string | null>(null);
  const zip = useRef<HTMLInputElement>(null);
  useEffect(() => {
    getImportTarget().then(setTarget, () => {});
  }, []);

  /** Start a job (the callback returns its id), show its progress, resolve with the final state. */
  const guard = async (label: string, start: () => Promise<string>, done: (j: JobState) => void) => {
    setBusy(label);
    setErr(null);
    setProg(null);
    try {
      const id = await start();
      setJobId(id);
      done(await waitForJob(id, setProg));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      setJobId(null);
    }
  };
  const adopt = (p: ImportPlan) => {
    setPlan(p);
    setResult(null);
  };
  const importable = plan ? plan.models.filter((m) => m.status === 'new' || (overwrite && m.status === 'conflict')).length + plan.backgrounds.filter((b) => b.status === 'new' || (overwrite && b.status === 'conflict')).length : 0;
  const count = (s: string) => (plan ? plan.models.filter((m) => m.status === s).length + plan.backgrounds.filter((b) => b.status === s).length : 0);

  return (
    <div className="import-panel" data-testid="import-panel">
      <section>
        <h4>选择素材</h4>
        <p className="hint">选择你已经从合法渠道取得的素材：文件夹或 .zip。程序只读取它们，规范化后写入素材库的副本，不会改动你的原文件。</p>
        <div className="row-actions">
          <input className="text grow" placeholder="文件夹或 .zip 的绝对路径，例如 D:\Downloads\haneoka" value={path} onChange={(e) => setPath(e.target.value)} data-testid="import-path" />
          <button className="btn primary" disabled={!path.trim() || busy !== null} onClick={() => void guard('scan', () => scanImport(path.trim()), (j) => adopt(j.plan!))} data-testid="import-scan">扫描</button>
          <button className="btn" disabled={busy !== null} onClick={() => zip.current?.click()} data-testid="import-zip-btn">上传 .zip…</button>
          <input ref={zip} type="file" accept=".zip" hidden data-testid="import-zip" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void guard('upload', () => uploadImport(f), (j) => adopt(j.plan!)); }} />
        </div>
        {busy && (
          <div data-testid="import-busy">
            <p className="hint">
              {prog ? `${prog.phase}：${prog.done}${prog.total ? ` / ${prog.total}` : ''}${prog.bytes ? ` · 已解压 ${(prog.bytes / 1024 ** 2).toFixed(0)} MB` : ''}` : busy === 'upload' ? '上传中…' : '准备中…'}
              （大包会花几分钟：解压、校验、写入）
            </p>
            {prog && prog.total > 0 && <progress value={prog.done} max={prog.total} style={{ width: '100%' }} />}
            {jobId && <button className="btn" onClick={() => void cancelJob(jobId)} data-testid="import-cancel">取消</button>}
          </div>
        )}
        {err && <p className="bad" data-testid="import-error">{err}</p>}
      </section>

      {plan && !result && (
        <section data-testid="import-plan">
          <h4>导入预览 <span className="hint">{plan.source}</span></h4>
          <p data-testid="import-summary">
            模型 {plan.models.length}（新增 {plan.models.filter((m) => m.status === 'new').length}）· 背景 {plan.backgrounds.length}（新增 {plan.backgrounds.filter((b) => b.status === 'new').length}）·
            动作 {plan.models.reduce((n, m) => n + m.motions, 0)} · 表情 {plan.models.reduce((n, m) => n + m.expressions, 0)} · 将写入 {plan.fileCount} 个文件 / {mb(plan.totalBytes)}
          </p>
          <p className="hint">相同 {count('duplicate')} · 内容不同 {count('conflict')} · 错误 {count('error')} · 无法识别 {count('unrecognized')}</p>
          {plan.pack && (
            <p className={plan.pack.problems.length ? 'bad' : 'ok'} data-testid="plan-pack">
              素材包描述文件（{plan.pack.generatedAt.slice(0, 10)}）：模型 {plan.pack.counts.models} · 背景 {plan.pack.counts.backgrounds} · 媒体 {plan.pack.counts.media} ·
              {plan.pack.listed ? ` 已逐文件校验 SHA-256：${plan.pack.verified}/${plan.pack.listed}` : ' 未附文件清单'}
              {plan.pack.problems.length > 0 && `；发现 ${plan.pack.problems.length} 个问题，已禁止导入（见下方错误清单）`}
            </p>
          )}
          {plan.media && <p className="hint" data-testid="plan-media">媒体文件 {plan.media.files}（新增 {plan.media.new}，相同 {plan.media.duplicate}，不同 {plan.media.conflict}）{plan.manifest ? ` · manifest.json：${plan.manifest}` : ''}</p>}
          {plan.warnings.map((w) => <p key={w} className="bad">{w}</p>)}
          {plan.models.length > 0 && (
            <table className="tbl" data-testid="plan-models">
              <thead><tr><th>模型 id</th><th>状态</th><th>动作</th><th>表情</th><th>纹理</th><th>大小</th><th>备注</th></tr></thead>
              <tbody>
                {plan.models.map((m) => (
                  <tr key={m.src} className={m.status}>
                    <td>{m.idGuessed ? <input className="text" value={ids[m.src] ?? m.id} onChange={(e) => setIds({ ...ids, [m.src]: e.target.value })} aria-label={`id ${m.src}`} /> : m.id}</td>
                    <td>{STATUS[m.status]}</td><td>{m.motions}</td><td>{m.expressions}</td><td>{m.textures}</td><td>{mb(m.bytes)}</td>
                    <td className="hint">{m.normalized ? '已规范化 ' : ''}{[...m.errors, ...m.warnings].join('；')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {plan.backgrounds.length > 0 && (
            <table className="tbl" data-testid="plan-backgrounds">
              <thead><tr><th>背景 id</th><th>状态</th><th>尺寸</th><th>大小</th><th>标签</th><th>备注</th></tr></thead>
              <tbody>
                {plan.backgrounds.map((b) => (
                  <tr key={b.src} className={b.status}>
                    <td>{b.status === 'unrecognized' ? <input className="text" placeholder="adv_bkg_stage_000001" value={ids[b.src] ?? ''} onChange={(e) => setIds({ ...ids, [b.src]: e.target.value })} aria-label={`id ${b.src}`} /> : b.id}</td>
                    <td>{STATUS[b.status]}</td><td>{b.width ? `${b.width}×${b.height}` : '—'}</td><td>{mb(b.bytes)}</td>
                    <td>{b.id ? (b.labelled ? '已有标签' : '无标签（按“未知”处理）') : '—'}</td><td className="hint">{b.message ?? b.src}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(plan.skipped.length > 0 || plan.errors.length > 0) && (
            <details data-testid="plan-issues"><summary>跳过 {plan.skipped.length} · 错误 {plan.errors.length}</summary>
              <ul className="hint">{plan.errors.map((e) => <li key={e.path} className="bad">{e.path}：{e.message}</li>)}{plan.skipped.map((s) => <li key={s.path}>{s.path}：{s.reason}</li>)}</ul>
            </details>
          )}
          <div className="row-actions">
            {Object.values(ids).some((v) => v.trim()) && <button className="btn" disabled={busy !== null} onClick={() => void guard('scan', () => replanImport(plan.planId, Object.fromEntries(Object.entries(ids).filter(([, v]) => v.trim()))), (j) => adopt(j.plan!))} data-testid="import-replan">应用 id 并重新分析</button>}
            <label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />覆盖“已存在但内容不同”的项</label>
            <button className="btn primary" disabled={(importable === 0 && !plan.media?.new && plan.manifest !== 'new') || busy !== null || (plan.pack?.problems.length ?? 0) > 0} onClick={() => void guard('run', () => runImport(plan.planId, Object.fromEntries(Object.entries(ids).filter(([, v]) => v.trim())), overwrite), (j) => { setResult(j.result!); onChanged(); })} data-testid="import-run">导入 {importable} 项</button>
            <button className="btn" onClick={() => { void cancelImport(plan.planId); setPlan(null); }}>取消</button>
          </div>
        </section>
      )}

      {result && (
        <section data-testid="import-report">
          <h4 className="ok">导入完成</h4>
          <p data-testid="report-summary">模型 {result.report.totals.models} · 背景 {result.report.totals.backgrounds} · 媒体 {result.report.totals.media} · 动作 {result.report.totals.motions} · 表情 {result.report.totals.expressions} · {result.report.files} 个文件 / {mb(result.report.bytes)}</p>
          {result.unlabelledBackgrounds.length > 0 && <p className="hint">{result.unlabelledBackgrounds.length} 张新背景没有标签，会按“未知”处理（可在资源浏览器里标注）。</p>}
          {result.report.skipped.length > 0 && <details><summary>跳过 {result.report.skipped.length} 项</summary><ul className="hint">{result.report.skipped.map((s, i) => <li key={i}>{s.id}：{s.reason}</li>)}</ul></details>}
          {result.report.errors.length > 0 && <ul className="bad">{result.report.errors.map((e) => <li key={e.id}>{e.id}：{e.message}</li>)}</ul>}
          <div className="row-actions">
            <a className="btn primary" href="/assets" data-testid="open-assets">在资源浏览器中查看</a>
            <button className="btn" onClick={() => { setPlan(null); setResult(null); setPath(''); }}>继续导入其他素材</button>
          </div>
        </section>
      )}

      <details className="target">
        <summary>素材库位置{target ? `：${target.assetRoot}` : ''}</summary>
        {target && (
          <div>
            <p className="hint">{target.writable ? '该目录可写，导入的素材会写到这里。' : '该目录不可写，请换一个目录。'}{target.fromEnv ? ' 注意：环境变量 ASSET_ROOT 已设置，它优先于 studio.config.json。' : ''}</p>
            <div className="row-actions">
              <input className="text grow" placeholder="新的素材库绝对路径" value={newTarget} onChange={(e) => setNewTarget(e.target.value)} data-testid="target-path" />
              <button className="btn" disabled={!newTarget.trim()} onClick={() => void setImportTarget(newTarget.trim()).then((r) => setTargetMsg(r.restartRequired ? '已写入 studio.config.json。请重启服务端（关闭后再 npm run dev）使其生效。' : '已保存'), (e: Error) => setTargetMsg(e.message))}>保存位置</button>
            </div>
            {targetMsg && <p className="hint" data-testid="target-msg">{targetMsg}</p>}
          </div>
        )}
      </details>
    </div>
  );
}
