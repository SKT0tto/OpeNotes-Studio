/** First-run wizard: Cubism Core -> asset import -> AI key. Each step shows its own status. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadCubismCore } from '../engine/cubismCore';
import { fetchLlmSettings } from '../llmApi';
import type { PublicLlmSettings } from '@shared/schema/settings';
import { GUIDE_URL } from '@shared/meta';
import { SettingsDialog } from '../editor/dialogs/SettingsDialog';
import { Modal } from '../editor/ui';
import type { Health } from '../api';
import { HaneokaPanel } from './HaneokaPanel';
import { ImportPanel } from './ImportPanel';
import { acceptCoreLicense, fetchOfficialCore, getCoreState, resetCore, uploadCore, type CoreState } from './setupApi';

export type CoreProbe = { state: 'checking' } | { state: 'ok'; mocVersion: number } | { state: 'bad'; message: string };

/** Really loads the configured Core in this page and reports whether it supports moc3 v5. */
export function useCoreProbe(url: string, nonce = 0): CoreProbe {
  const [probe, setProbe] = useState<CoreProbe>({ state: 'checking' });
  useEffect(() => {
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProbe({ state: 'checking' });
    loadCubismCore(url).then(
      () => {
        const core = (window as unknown as { Live2DCubismCore?: { Version: { csmGetLatestMocVersion(): number } } }).Live2DCubismCore;
        if (live) setProbe({ state: 'ok', mocVersion: core?.Version.csmGetLatestMocVersion() ?? 0 });
      },
      (e: Error) => live && setProbe({ state: 'bad', message: e.message }),
    );
    return () => {
      live = false;
    };
  }, [url, nonce]);
  return probe;
}

const Badge = ({ ok }: { ok: boolean | null }) => <span className={`step-badge ${ok === null ? '' : ok ? 'ok' : 'warn'}`}>{ok === null ? '检查中' : ok ? '已就绪' : '待处理'}</span>;

function CoreStep({ coreUrl, probe, onChanged }: { coreUrl: string; probe: CoreProbe; onChanged: () => void }) {
  const [st, setSt] = useState<CoreState | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    getCoreState().then((s) => {
      setSt(s);
      setAgree(s.licenseAccepted);
    }, (e: Error) => setErr(e.message));
  }, []);

  /** Install, then prove the new copy loads and supports moc3 v5; otherwise go back to the previous URL. */
  const run = async (fn: () => Promise<CoreState>) => {
    setBusy(true);
    setErr(null);
    try {
      if (!st?.licenseAccepted) await acceptCoreLicense();
      const next = await fn();
      setSt(next);
      const ok = await loadCubismCore(next.cubismCoreUrl).then(() => true, (e: Error) => {
        setErr(e.message);
        return false;
      });
      if (!ok) setSt(await resetCore());
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="step-core-body">
      <p className={probe.state === 'ok' ? 'ok' : probe.state === 'bad' ? 'bad' : 'hint'} data-testid="core-status">
        {probe.state === 'checking' ? '正在加载 Cubism Core…' : probe.state === 'ok' ? `Cubism Core 已加载（支持 moc3 v${probe.mocVersion}）· 来源：${st?.local ? '本地副本 vendor/' : coreUrl}` : probe.message}
      </p>
      <p className="hint">Cubism Core 是 Live2D 公司的专有组件，本项目不包含它。默认直接从 Live2D 官方地址加载；离线或官方 CDN 打不开时，可以在这里保存一份到本机（vendor/，已 gitignore）。</p>
      <label className="check" data-testid="core-agree">
        <input type="checkbox" checked={agree} disabled={st?.licenseAccepted} onChange={(e) => setAgree(e.target.checked)} />
        <span>我已阅读并同意 <a href={st?.licenseUrl} target="_blank" rel="noreferrer noopener">Live2D 专有软件许可协议</a></span>
      </label>
      <div className="row-actions">
        <button className="btn primary" disabled={!agree || busy || !st} onClick={() => void run(fetchOfficialCore)} data-testid="core-fetch">从 Live2D 官方获取并保存到本地</button>
        <button className="btn" disabled={!agree || busy || !st} onClick={() => file.current?.click()} data-testid="core-pick">选择本地的官方文件…</button>
        <input ref={file} type="file" accept=".js" hidden data-testid="core-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void run(() => uploadCore(f)); }} />
        <a className="btn" href={st?.downloadPageUrl} target="_blank" rel="noreferrer noopener">打开官方 SDK 下载页</a>
        {st?.local && <button className="btn" disabled={busy} onClick={() => void resetCore().then((s) => { setSt(s); onChanged(); })}>改回官方地址</button>}
      </div>
      <p className="hint">选择文件时，请使用从 Live2D 官网下载的 Cubism SDK for Web 里的 <code>live2dcubismcore.min.js</code>。程序只检查文件头与版本入口，不内置任何哈希或第三方地址。</p>
      {err && <p className="bad" data-testid="core-error">{err}</p>}
    </div>
  );
}

function AiStep({ llm, onOpen }: { llm: PublicLlmSettings | null | undefined; onOpen: () => void }) {
  return (
    <div data-testid="step-ai-body">
      <p className={llm?.status.configured ? 'ok' : 'hint'}>
        {llm === undefined ? '检查中…' : llm?.status.configured ? `已配置：${llm.status.provider === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${llm.status.model ?? ''}` : '尚未配置。可以填入自己的 API key，或本地 LM Studio 地址；也可以跳过，使用“规则生成（非 AI）”。'}
      </p>
      <button className="btn primary" onClick={onOpen} data-testid="wizard-open-ai">打开 AI 设置</button>
      <p className="hint">Key 只保存在本机 data/settings.local.json，不会上传、不会入库。</p>
    </div>
  );
}

export function SetupWizard({ health, onChanged, onClose, initialStep = 0, standalone = false }: {
  health: Health; onChanged: () => void; onClose?: () => void; initialStep?: number; standalone?: boolean;
}) {
  const [step, setStep] = useState(initialStep);
  const [nonce, setNonce] = useState(0);
  const [llm, setLlm] = useState<PublicLlmSettings | null | undefined>(undefined);
  const [aiOpen, setAiOpen] = useState(false);
  const probe = useCoreProbe(health.cubismCoreUrl, nonce);
  useEffect(() => {
    fetchLlmSettings().then(setLlm, () => setLlm(null));
  }, [aiOpen]);

  const coreOk = probe.state === 'checking' ? null : probe.state === 'ok';
  const a = health.assetRoot;
  const steps = [
    { title: '1  Cubism Core', ok: coreOk },
    { title: '2  导入素材', ok: a.ok ? a.models > 0 : false },
    { title: '3  AI（可选）', ok: llm === undefined ? null : Boolean(llm?.status.configured) },
  ];
  const changed = useCallback(() => {
    setNonce((n) => n + 1);
    onChanged();
  }, [onChanged]);

  const body = (
    <div className="wizard" data-testid="setup-wizard">
      <ol className="wizard-steps">
        {steps.map((s, i) => (
          <li key={s.title}>
            <button className={i === step ? 'active' : ''} onClick={() => setStep(i)} data-testid={`wizard-step-${i}`}>
              <span>{s.title}</span><Badge ok={s.ok} />
            </button>
          </li>
        ))}
      </ol>
      <div className="wizard-body">
        {step === 0 && <CoreStep coreUrl={health.cubismCoreUrl} probe={probe} onChanged={changed} />}
        {step === 1 && <AssetsStep health={health} onChanged={changed} />}
        {step === 2 && <AiStep llm={llm} onOpen={() => setAiOpen(true)} />}
        <div className="row-actions wizard-nav">
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>上一步</button>}
          {step < 2 && <button className="btn" onClick={() => setStep(step + 1)} data-testid="wizard-next">下一步</button>}
          {a.ok && onClose && <button className="btn primary" onClick={onClose} data-testid="wizard-done">完成</button>}
          <a className="hint" href={GUIDE_URL} target="_blank" rel="noreferrer noopener">完整教程</a>
        </div>
      </div>
      {aiOpen && <SettingsDialog onClose={() => setAiOpen(false)} />}
    </div>
  );
  if (standalone) return body;
  return <Modal title="配置向导" onClose={onClose ?? (() => {})} wide testid="wizard-modal">{body}</Modal>;
}

function AssetsStep({ health, onChanged }: { health: Health; onChanged: () => void }) {
  const [tab, setTab] = useState<'import' | 'list'>('import');
  const a = health.assetRoot;
  return (
    <div data-testid="step-assets-body">
      <p className={a.ok && a.models > 0 ? 'ok' : 'hint'} data-testid="assets-status">
        {a.ok ? `素材库：${a.models} 个模型目录 · ${a.backgrounds} 张背景（${a.path}）` : `素材库还是空的（${a.path}）。选择你已经拥有的素材文件夹或 zip 导入即可。`}
      </p>
      <div className="seg" role="tablist">
        <button role="tab" className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')} data-testid="tab-import">本地导入</button>
        <button role="tab" className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')} data-testid="tab-haneoka">素材清单（Haneoka，仅清单）</button>
      </div>
      {tab === 'import' ? <ImportPanel onChanged={onChanged} /> : <HaneokaPanel onGoImport={() => setTab('import')} />}
    </div>
  );
}
