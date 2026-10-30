/**
 * The 「生成」 section of the AI panel (the former 「AI 导演」 panel): generate / regenerate scenes, whole scenes or one scope; every
 * proposal is shown as a diff against the current scene and accepted or rejected per scope (one undo step each); progress, cancel, the
 * run log and the continuity check of the whole project. The run state is in `directorRun.ts` (a store), so this section can be
 * collapsed, scrolled away or unmounted (another dock tab in front) while a run goes on.
 */
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { SCOPE_LABEL, SCOPE_NAMES, type ScopeName } from '@shared/director/scope';
import type { PublicLlmSettings } from '@shared/schema/settings';
import { fetchLlmSettings } from '../../llmApi';
import { useAgent } from '../../store/agentStore';
import { useProject } from '../../store/projectStore';
import { SettingsDialog } from '../dialogs/SettingsDialog';
import { useCatalog } from '../useCatalog';
import { AiResultCard } from './AiResultCard';
import { continuityOf, useDirectorRun, usesRule, type CameraGenerationRequest, type DirectorEnv, type Engine } from './directorRun';
import { DirectorMemoryLine } from './MemoryPanel';

export function DirectorSection({ cameraRequest = null, onFocusBeat }: { cameraRequest?: CameraGenerationRequest | null; onFocusBeat: (sceneId: string, beatId: string | undefined) => void }) {
  const project = useProject((s) => s.project)!;
  const catalog = useCatalog();
  const d = useDirectorRun();
  const [settings, setSettings] = useState<PublicLlmSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const loadSettings = useCallback(() => {
    return fetchLlmSettings().then(setSettings, (e: Error) => {
      setSettings(null);
      setSettingsError(e.message);
    }).finally(() => setSettingsLoading(false));
  }, []);
  useEffect(() => { void loadSettings(); }, [loadSettings]);
  const reload = () => {
    setSettingsLoading(true);
    setSettingsError(null);
    void loadSettings();
  };

  const configured = settings?.status.configured === true;
  const env: DirectorEnv = { configured, provider: settings?.status.provider, catalog };
  const open = d.generateOpen ?? !!project.source.text;

  // A camera regeneration request (the travel notice, 重导镜头): runs once, with the controls it needs, when the settings are known.
  const receiveCameraRequest = useEffectEvent((request: CameraGenerationRequest) => {
    if (!request.consume()) return;
    const store = useDirectorRun.getState();
    store.setControls({ scope: 'camera', preview: true, overwriteUser: false, onlyBeat: false });
    store.setGenerateOpen(true);
    if (settingsError || !settings) return;
    const snapshot = useProject.getState().project;
    if (snapshot?.id !== request.projectId || !request.sceneIds.every((id) => snapshot.scenes.some((s) => s.id === id))) return;
    const runEngine: Engine = settings.status.configured ? 'ai' : 'rule';
    store.setControls({ engine: runEngine });
    const [only] = request.sceneIds;
    void store.run(false, { ...(request.sceneIds.length === 1 && only ? { sceneId: only } : { sceneIds: request.sceneIds }), scope: 'camera', preview: true, overwriteUser: false, onlyBeat: false, engine: runEngine }, env);
  });
  useEffect(() => {
    if (!cameraRequest || settingsLoading) return;
    // Dispatch the user command after the panel/settings commit; navigation cancels it.
    const timer = window.setTimeout(() => receiveCameraRequest(cameraRequest), 0);
    return () => window.clearTimeout(timer);
  }, [cameraRequest, settingsLoading]);
  // Leaving the panel (closed, or another tab in front) cancels a request that has not run yet, so that coming back never replays it. The
  // cancel is deferred one tick and undone by a re-mount: React's strict mode mounts, unmounts and re-mounts every component once.
  const latestRequest = useRef(cameraRequest);
  useEffect(() => { latestRequest.current = cameraRequest; });
  const cancelTimer = useRef<number | null>(null);
  useEffect(() => {
    if (cancelTimer.current !== null) {
      window.clearTimeout(cancelTimer.current);
      cancelTimer.current = null;
    }
    return () => {
      cancelTimer.current = window.setTimeout(() => void latestRequest.current?.consume(), 0);
    };
  }, []);

  const cardList = Object.values(d.cards);
  const pending = cardList.filter((c) => c.state === 'pending' && c.result.applied).length;
  const finished = Object.values(d.progress).filter((p) => p.state !== 'start').length;
  const summary = d.busy ? `生成中 ${finished} / ${d.total}` : pending > 0 ? `${pending} 个场景的结果待接受` : d.error ? '出错了，展开查看' : '';

  return (
    <section className="ai-gen" data-testid="ai-generate-section" data-open={open ? '1' : '0'}>
      <div className="ai-gen-head">
        <button className="ai-gen-toggle" aria-expanded={open} onClick={() => d.setGenerateOpen(!open)} data-testid="ai-generate-toggle" title="生成：让 AI 导演（或规则导演）重新生成场景的演出，先预览差异再接受">
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> 生成
        </button>
        <span className={`hint ai-gen-summary${d.error && !d.busy ? ' bad' : ''}`} data-testid="ai-generate-summary">{summary}</span>
        <span className="grow" />
        {d.busy && !open && <button className="btn danger" onClick={() => d.cancel()} data-testid="ai-cancel-collapsed">取消</button>}
      </div>
      {open && (
        <div className="ai-gen-body">
          <DirectorBody
            env={env} settings={settings} settingsLoading={settingsLoading} settingsError={settingsError}
            onReload={reload} onOpenSettings={() => setShowSettings(true)} onFocusBeat={onFocusBeat}
          />
        </div>
      )}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onChanged={setSettings} />}
    </section>
  );
}

function DirectorBody({ env, settings, settingsLoading, settingsError, onReload, onOpenSettings, onFocusBeat }: {
  env: DirectorEnv;
  settings: PublicLlmSettings | null;
  settingsLoading: boolean;
  settingsError: string | null;
  onReload: () => void;
  onOpenSettings: () => void;
  onFocusBeat: (sceneId: string, beatId: string | undefined) => void;
}) {
  const project = useProject((s) => s.project)!;
  const selection = useProject((s) => s.selection);
  const catalog = useCatalog();
  const d = useDirectorRun();
  const { engine, scope, onlyBeat, overwriteUser, preview, useMem } = d.controls;
  const scene = project.scenes.find((s) => s.id === selection.sceneId) ?? project.scenes[0];
  const useRule = usesRule(engine, env.configured);
  const canGenerate = !d.busy && !settingsLoading && !settingsError && !!project.source.text && project.scenes.length > 0;
  const regen = scene && scene.beats.some((b) => b.meta.source !== 'rule');
  const cards = Object.values(d.cards);
  const pending = cards.filter((c) => c.state === 'pending' && c.result.applied);
  const warnings = useMemo(() => continuityOf(project, catalog), [project, catalog]);
  const finished = Object.values(d.progress).filter((p) => p.state !== 'start').length;
  const refine = (sceneId: string) => {
    // open the assistant on that scene: it is selected, the input is focused, nothing is sent
    onFocusBeat(sceneId, undefined);
    useAgent.getState().focusInput();
  };

  return (
    <div className="ai-panel" data-testid="ai-panel">
      {settingsLoading && <p className="hint" data-testid="ai-settings-loading">正在读取 AI 设置…</p>}
      {settingsError && (
        <div className="bad" data-testid="ai-settings-error">
          <p>读取 AI 设置失败，尚未开始生成。{settingsError}</p>
          <button className="btn" onClick={onReload} data-testid="ai-settings-retry">重试读取设置</button>
        </div>
      )}
      {settings && (
        <p className={settings.status.verified === 'ok' ? 'ok' : env.configured && settings.status.verified !== 'failed' ? 'hint' : 'warn'} data-testid="ai-status">
          {settings.status.message}
          {' '}<button className="btn-s" onClick={onOpenSettings} data-testid="ai-open-settings">AI 设置</button>
        </p>
      )}
      {!project.source.text && <p className="hint" data-testid="ai-no-source">这个项目没有原文（不是由 AI 拆解创建的），不能用 AI 导演。请在项目列表里用「AI 拆解」创建项目。</p>}
      <div className="ai-controls">
        <label className="srow"><span>引擎</span>
          <select value={useRule ? 'rule' : 'ai'} onChange={(e) => d.setControls({ engine: e.target.value as Engine })} data-testid="ai-engine">
            <option value="ai" disabled={!env.configured}>AI 模型{env.configured ? '' : '（未配置）'}</option>
            <option value="rule">规则导演（非 AI，无需 key）</option>
          </select>
        </label>
        <label className="srow"><span>范围</span>
          <select value={scope} onChange={(e) => d.setControls({ scope: e.target.value as ScopeName })} data-testid="ai-scope">
            {SCOPE_NAMES.map((n) => <option key={n} value={n}>{SCOPE_LABEL[n]}</option>)}
          </select>
        </label>
        <label className="chk"><input type="checkbox" checked={onlyBeat} disabled={!selection.beatId} onChange={(e) => d.setControls({ onlyBeat: e.target.checked })} data-testid="ai-only-beat" /> 只重做选中的台词</label>
        <label className="chk"><input type="checkbox" checked={overwriteUser} onChange={(e) => d.setControls({ overwriteUser: e.target.checked })} data-testid="ai-overwrite" /> 也覆盖我手改过的内容（锁定的永不覆盖）</label>
        <label className="chk"><input type="checkbox" checked={preview} onChange={(e) => d.setControls({ preview: e.target.checked })} data-testid="ai-preview" /> 先预览差异，再逐项接受 / 拒绝</label>
        {!useRule && <DirectorMemoryLine projectId={project.id} on={useMem} setOn={(on) => d.setControls({ useMem: on })} disabled={d.busy} />}
        <div className="ai-buttons">
          <button className="btn primary" disabled={!canGenerate || !scene} onClick={() => void d.run(false, {}, env)} data-testid="ai-regen-scene" title={regen ? '同一场景、同一范围、输入没变时，直接用上次的结果（缓存，不再调用模型）；想要不同的结果请点「换一版」' : undefined}>
            {regen ? '重新生成' : '生成演出'}：{scene?.title ?? '—'}
          </button>
          {!useRule && (
            <button className="btn" disabled={!canGenerate || !scene} onClick={() => void d.run(false, { refresh: true }, env)} data-testid="ai-regen-fresh" title="忽略缓存，向模型重新要一个结果（会再调用一次模型）">换一版</button>
          )}
          <button className="btn" disabled={!canGenerate} onClick={() => void d.run(true, {}, env)} data-testid="ai-gen-all">生成全部场景演出</button>
          {d.busy && <button className="btn danger" onClick={() => d.cancel()} data-testid="ai-cancel">取消</button>}
        </div>
        {!useRule && cards.some((c) => c.result.cached) && <p className="hint" data-testid="ai-fresh-hint">这次用的是上次的结果（输入没变，没有再调用模型）。想要不同的，点「换一版」。</p>}
        {useRule && <p className="hint" data-testid="ai-rule-hint">规则导演：对白按引号识别、说话人按名字匹配、镜头按固定节奏，产物标注为「规则」，不是 AI。</p>}
      </div>
      {d.busy && d.total > 0 && (
        <div data-testid="ai-meter">
          <div className="ai-meter"><i style={{ width: `${Math.round((finished / d.total) * 100)}%` }} /></div>
          <span className="hint">{finished} / {d.total} 个场景</span>
        </div>
      )}
      {Object.keys(d.progress).length > 0 && (
        <ul className="ai-progress" data-testid="ai-progress">
          {Object.values(d.progress).map((p) => (
            <li key={p.sceneId} className={p.state === 'error' ? 'bad' : p.state === 'done' ? 'ok' : ''} data-state={p.state}>
              {p.state === 'start' ? '生成中…' : p.state === 'done' ? `完成${p.cached ? '（缓存）' : ''}` : `失败：${p.message}`} · {p.title}
            </li>
          ))}
        </ul>
      )}
      {d.busy && Object.keys(d.progress).length === 0 && <p className="hint">请求中…（每个场景只调用一次模型）</p>}
      {d.error && <pre className="bad ai-error" data-testid="ai-error">{d.error}</pre>}
      {pending.length > 1 && (
        <div className="ai-batchbar" data-testid="ai-batchbar">
          <button className="btn primary" onClick={() => d.acceptAll()} data-testid="ai-accept-batch">接受全部 {pending.length} 个场景</button>
          <button className="btn" onClick={() => d.rejectAll()}>全部拒绝</button>
        </div>
      )}
      <ul className="ai-results">
        {cards.map((c) => (
          <AiResultCard key={c.sceneId} card={c} onToggle={(s) => d.toggleScope(c.sceneId, s)} onAccept={(all) => d.accept(c.sceneId, all)} onReject={() => d.reject(c.sceneId)} onRefine={() => refine(c.sceneId)} />
        ))}
      </ul>
      {project.scenes.length > 0 && (
        <details open={warnings.length > 0} data-testid="ai-continuity">
          <summary>{warnings.length === 0 ? '连续性检查：未发现问题' : `连续性检查：${warnings.length} 条提示（点击定位）`}</summary>
          <ul className="ai-warn ai-continuity">
            {warnings.map((w, i) => (
              <li key={i} onClick={() => useProject.getState().select({ sceneId: w.sceneId, ...(w.beatId ? { beatId: w.beatId } : {}) })} data-testid="ai-cont-item">{w.message}</li>
            ))}
          </ul>
        </details>
      )}
      {d.log.length > 0 && (
        <details>
          <summary>运行记录（{d.log.length}）</summary>
          <ul className="ai-log" data-testid="ai-log">
            {d.log.map((l, i) => <li key={i} className={l.kind === 'error' ? 'bad' : ''}>{new Date(l.at).toLocaleTimeString()} {l.text}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

