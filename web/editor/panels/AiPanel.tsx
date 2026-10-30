/**
 * 「AI」: the one AI panel, chat first. A header row, ONE scrolling stream (your messages, the AI's generation cards and change cards, in the order
 * they happened) and a composer at the bottom that never scrolls away (context, suggestion chips, the input, 「生成 ▾」, 发送). Generating is an
 * action next to the input: the popover sets what and how, and the result arrives in the stream as a card with the same verbs as every other
 * card (应用全部 / 应用所选 / 拒绝 / 撤销这次 / 换一版 / 微调). The engines are unchanged: generation is `directorRun.ts`, the assistant is
 * `agentStore.ts`; they share the selection, the AI settings, the memory switch and this stream.
 */
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useMemories } from '../../memoryApi';
import { useAgent } from '../../store/agentStore';
import { useAiFlow } from '../../store/aiFlow';
import { useProject } from '../../store/projectStore';
import { useUi } from '../../store/uiStore';
import { SettingsDialog } from '../dialogs/SettingsDialog';
import { useCatalog } from '../useCatalog';
import { ChatTurn } from './AgentPanel';
import { AiComposer } from './ai/AiComposer';
import { noAi, useAiSettings } from './ai/aiSettings';
import { GenerateTurn } from './ai/GenerateCard';
import { OnboardTurn } from './ai/OnboardCard';
import type { GenTurn } from './ai/genTurn';
import { continuityOf, useDirectorRun, type CameraGenerationRequest, type DirectorEnv, type Engine } from './directorRun';
import { EXPERIMENTAL_TIP, MemoryManager } from './MemoryPanel';

interface Item { order: number; key: string; node: 'chat' | 'generate' | 'onboard'; id: number }

export function AiPanel({ visible = true, onFocusBeat, cameraRequest = null }: { visible?: boolean; onFocusBeat: (sceneId: string, beatId: string | undefined) => void; cameraRequest?: CameraGenerationRequest | null }) {
  // dockview keeps a panel's React tree alive while its tab is behind another one: nothing is rendered (or recomputed on every edit, like the
  // continuity check) until the tab is in front. Everything that matters survives in the stores: the run, the options, the draft, the pictures.
  if (!visible) return null;
  return <AiPanelBody onFocusBeat={onFocusBeat} cameraRequest={cameraRequest} />;
}

function AiPanelBody({ onFocusBeat, cameraRequest }: { onFocusBeat: (sceneId: string, beatId: string | undefined) => void; cameraRequest: CameraGenerationRequest | null }) {
  const project = useProject((s) => s.project)!;
  const catalog = useCatalog();
  const hoverBeat = useUi((s) => s.hoverBeat);
  const runs = useAgent((s) => s.runs);
  const memoryView = useAgent((s) => s.memoryView);
  const snapshot = useAgent((s) => s.snapshot);
  const turns = useDirectorRun((s) => s.turns);
  const entries = useAiFlow((s) => s.entries);
  const popoverOpen = useAiFlow((s) => s.popoverOpen);
  const continuityOpen = useAiFlow((s) => s.continuityOpen);
  const aiState = useAiSettings();
  const { settings, loading, error } = aiState;
  const mem = useMemories();
  const [showSettings, setShowSettings] = useState(false);
  const [menu, setMenu] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const a = useAgent.getState();

  useEffect(() => { void useAiSettings.getState().load(); }, []);
  useEffect(() => { void useMemories.getState().load(project.id); }, [project.id]);
  const configured = settings?.status.configured === true;
  const provider = settings?.status.provider;
  const env: DirectorEnv = useMemo(() => ({ configured, provider, catalog }), [configured, provider, catalog]);
  const setPopoverOpen = useCallback((open: boolean) => useAiFlow.getState().setPopoverOpen(open), []);

  // A camera regeneration request (the travel notice, 重导镜头): runs once, with the controls it needs, when the settings are known.
  const receiveCameraRequest = useEffectEvent((request: CameraGenerationRequest) => {
    if (!request.consume()) return;
    const store = useDirectorRun.getState();
    store.setControls({ target: 'scene', scope: 'camera', preview: true, overwriteUser: false, onlyBeat: false });
    if (error || !settings) return;
    const current = useProject.getState().project;
    if (current?.id !== request.projectId || !request.sceneIds.every((id) => current.scenes.some((s) => s.id === id))) return;
    const runEngine: Engine = settings.status.configured ? 'ai' : 'rule';
    store.setControls({ engine: runEngine });
    const [only] = request.sceneIds;
    void store.run(false, { ...(request.sceneIds.length === 1 && only ? { sceneId: only } : { sceneIds: request.sceneIds }), scope: 'camera', preview: true, overwriteUser: false, onlyBeat: false, engine: runEngine }, env);
  });
  useEffect(() => {
    if (!cameraRequest || loading) return;
    // Dispatch the user command after the panel/settings commit; navigation cancels it.
    const timer = window.setTimeout(() => receiveCameraRequest(cameraRequest), 0);
    return () => window.clearTimeout(timer);
  }, [cameraRequest, loading]);
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

  // the stream: assistant turns, generation turns and the first-run dialog's cards, in the order they happened
  const items = useMemo<Item[]>(() => [
    ...runs.map((r) => ({ order: r.order, key: `c${r.id}`, node: 'chat' as const, id: r.id })),
    ...turns.map((t) => ({ order: t.order, key: `g${t.id}`, node: 'generate' as const, id: t.id })),
    ...entries.map((e) => ({ order: e.order, key: `o${e.id}`, node: 'onboard' as const, id: e.id })),
  ].sort((x, y) => x.order - y.order), [runs, turns, entries]);
  const last = runs.at(-1);
  const lastTurn = turns.at(-1);
  const tailKey = `${items.length}:${last?.progress.length ?? 0}:${last?.status ?? ''}:${lastTurn?.status ?? ''}:${Object.keys(lastTurn?.progress ?? {}).length}:${Object.keys(lastTurn?.cards ?? {}).length}`;
  // follow the stream: a generation card is shown from its top (its head and its buttons matter, not its last diff line), anything else from its end
  const flow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const turnEls = flow.current?.querySelectorAll<HTMLElement>('[data-testid="ai-turn"]');
    const lastEl = turnEls?.[turnEls.length - 1];
    if (lastEl?.dataset.kind === 'generate' && lastTurn?.status !== 'running') lastEl.scrollIntoView?.({ block: 'start' });
    else end.current?.scrollIntoView?.({ block: 'end' });
  }, [tailKey, memoryView, lastTurn?.status]);

  // 「微调」: select that scene, put 「第N场：」 in the input and focus it; nothing is sent
  const refine = (sceneId: string) => {
    onFocusBeat(sceneId, undefined);
    const no = project.scenes.findIndex((s) => s.id === sceneId) + 1;
    useAgent.getState().setDraft(`第${no}场：`);
    useAgent.getState().focusInput();
  };
  // a typed command that was routed to generation by mistake: drop that turn and send the words to the assistant
  const routeUndo = (turn: GenTurn) => {
    const text = turn.routed ?? turn.userText;
    useDirectorRun.getState().discard(turn.id);
    void useAgent.getState().send(text);
  };
  const clearAll = () => {
    useAgent.getState().cancel();
    useDirectorRun.getState().reset();
    useAgent.setState({ runs: [], snapshot: null, running: false });
    useAiFlow.setState({ entries: [] });
  };

  const warnings = useMemo(() => (continuityOpen ? continuityOf(project, catalog) : []), [continuityOpen, project, catalog]);
  const memCount = mem.enabled ? mem.memories.filter((m) => m.enabled).length : 0;
  const without = noAi(aiState);
  const hasText = !!project.source.text;

  return (
    <div className="ai-merged" data-testid="ai-merged-panel">
      <div className="agent-panel ai-panel-root" data-testid="agent-panel" data-hover-beat={hoverBeat ?? undefined}>
        <div className="ai-head">
          <strong className="ai-head-title">AI</strong>
          <span className="grow" />
          <button className={`btn-s${memoryView ? ' on' : ''}`} data-testid="agent-memory" title={mem.enabled ? `长期记忆（${EXPERIMENTAL_TIP}）` : '长期记忆已关闭'} onClick={() => a.setMemoryView(!memoryView)}>{memoryView ? '返回对话' : '记忆'}{!memoryView && memCount > 0 ? ` ${memCount}` : ''}</button>
          <button className="btn-s" data-testid="ai-gear" title="AI 设置" aria-label="AI 设置" onClick={() => setShowSettings(true)}>⚙</button>
          <span className="ai-menu-wrap">
            <button className="btn-s" data-testid="ai-menu" aria-label="更多" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>⋯</button>
            {menu && (
              <div className="ai-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <button role="menuitem" className="btn-s" data-testid="ai-continuity-toggle" onClick={() => { useAiFlow.getState().setContinuityOpen(!continuityOpen); setMenu(false); }}>{continuityOpen ? '收起连续性检查' : '检查连续性'}</button>
                <button role="menuitem" className="btn-s" data-testid="agent-restore" disabled={!snapshot} onClick={() => { a.restoreSnapshot(); setMenu(false); }}>恢复到 AI 开始前</button>
                <button role="menuitem" className="btn-s" data-testid="ai-clear" onClick={() => { clearAll(); setMenu(false); }}>清空对话</button>
              </div>
            )}
          </span>
        </div>
        {loading && <p className="hint ai-banner" data-testid="ai-settings-loading">正在读取 AI 设置…</p>}
        {error && (
          <div className="bad ai-banner" data-testid="ai-settings-error">
            读取 AI 设置失败，尚未开始生成。{error}{' '}
            <button className="btn-s" onClick={() => void useAiSettings.getState().load()} data-testid="ai-settings-retry">重试读取设置</button>
          </div>
        )}
        {without && (
          <p className="warn ai-banner" data-testid="ai-noai-banner">
            未配置 AI：可以用「生成 ▾ → 规则生成（非 AI）」；用一句话修改需要 AI 模型{' '}
            <button className="btn-s" onClick={() => setShowSettings(true)} data-testid="ai-banner-settings">设置</button>
          </p>
        )}
        {memoryView && <div className="ai-stream"><MemoryManager projectId={project.id} /></div>}
        <div ref={flow} className="agent-flow ai-stream" data-testid="agent-flow" hidden={memoryView}>
          {continuityOpen && project.scenes.length > 0 && (
            <details open data-testid="ai-continuity" className="ai-continuity-block">
              <summary>{warnings.length === 0 ? '连续性检查：未发现问题' : `连续性检查：${warnings.length} 条提示（点击定位）`}</summary>
              <ul className="ai-warn ai-continuity">
                {warnings.map((w, i) => (
                  <li key={i} onClick={() => useProject.getState().select({ sceneId: w.sceneId, ...(w.beatId ? { beatId: w.beatId } : {}) })} data-testid="ai-cont-item">{w.message}</li>
                ))}
              </ul>
            </details>
          )}
          {items.length === 0 && (
            <p className="hint ai-empty" data-testid="ai-empty">
              {hasText ? '用一句话指挥 AI：“第二场多用双人，少点特写”“这一句加回忆效果”“让爱音在这里进场”。点输入框旁的「生成 ▾」，让 AI（或规则生成）重新生成场景的演出。每次修改先给你看变更，可勾选应用，Ctrl+Z 一步撤销。'
                : '用一句话指挥 AI：“第二场多用双人，少点特写”“这一句加回忆效果”。这个项目没有原文（不是由小说创建的），所以不能整场生成，但仍可以用一句话修改。每次修改先给你看变更，Ctrl+Z 一步撤销。'}
            </p>
          )}
          {items.map((it) => {
            if (it.node === 'chat') {
              const r = runs.find((x) => x.id === it.id);
              return r ? <ChatTurn key={it.key} run={r} project={project} onFocus={onFocusBeat} /> : null;
            }
            if (it.node === 'generate') {
              const t = turns.find((x) => x.id === it.id);
              return t ? <GenerateTurn key={it.key} turn={t} env={env} onRefine={refine} onRouteUndo={routeUndo} onOpenSettings={() => setShowSettings(true)} /> : null;
            }
            const e = entries.find((x) => x.id === it.id);
            return e ? <OnboardTurn key={it.key} entry={e} env={env} /> : null;
          })}
          <div ref={end} />
        </div>
        <AiComposer env={env} popoverOpen={popoverOpen} setPopoverOpen={setPopoverOpen} onOpenSettings={() => setShowSettings(true)} />
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onChanged={(s) => useAiSettings.getState().set(s)} />}
    </div>
  );
}
