/** The editing workspace: top bar, left panel (script / assets), live preview or storyboard, inspector, the AI panel (one conversation: generation + changes), timeline, status bar. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { newProjectId } from '@shared/project/blank';
import type { Project } from '@shared/schema/project';
import type { Health } from '../api';
import { usePlayerHost } from '../play/usePlayerHost';
import { createProject } from '../projectsApi';
import { useProject } from '../store/projectStore';
import { useUi } from '../store/uiStore';
import { CameraSystemSwitch } from './CameraSystemSwitch';
import { downloadProject } from './io';
import { AssetBrowser } from './panels/AssetBrowser';
import { SettingsDialog } from './dialogs/SettingsDialog';
import { AiPanel } from './panels/AiPanel';
import { useDirectorRun, type CameraGenerationRequest } from './panels/directorRun';
import { useAgent } from '../store/agentStore';
import { useAiFlow } from '../store/aiFlow';
import { Inspector } from './panels/Inspector';
import { Outline } from './panels/Outline';
import { Preview } from './panels/Preview';
import { Storyboard } from './storyboard/Storyboard';
import { Timeline } from './timeline/Timeline';
import { Dock, type DockController } from './dock/Dock';
import { LayoutMenu } from './dock/LayoutMenu';
import { type PanelId } from './dock/layoutModel';
import { Modal } from './ui';
import { useCatalog } from './useCatalog';
import { useRenderState } from './useRenderState';
import { SHORTCUTS, useShortcuts } from './useShortcuts';

const AGENT_OPEN_KEY = 'studio.agent.open';
const readAgentOpen = (): boolean => {
  try { return localStorage.getItem(AGENT_OPEN_KEY) === '1'; } catch { return false; }
};
const writeAgentOpen = (on: boolean): void => {
  try { localStorage.setItem(AGENT_OPEN_KEY, on ? '1' : '0'); } catch { /* storage may be blocked; the state just is not remembered */ }
};
const SAVE_TEXT = { saved: '已保存', dirty: '有未保存的更改', saving: '保存中…', error: '保存失败' } as const;

/** What the preview plays: the project without the tracks that are muted (or all but the soloed ones). The project itself is untouched. */
function previewOf(project: Project, muted: string[], solo: string[]): Project {
  if (muted.length === 0 && solo.length === 0) return project;
  const keep = (id: string) => (solo.length > 0 ? solo.includes(id) : !muted.includes(id));
  return { ...project, scenes: project.scenes.map((s) => ({ ...s, tracks: s.tracks.filter((t) => keep(t.id)) })) };
}

export function Workspace({ health, onExit }: { health: Health; onExit: () => void }) {
  const project = useProject((s) => s.project)!;
  const { saveState, saveError, canUndo, canRedo, undoLabel, redoLabel, etag } = useProject();
  const selection = useProject((s) => s.selection);
  const centerView = useUi((s) => s.centerView);
  const muted = useUi((s) => s.muted);
  const solo = useUi((s) => s.solo);
  const toast = useUi((s) => s.toast);
  const helpOpen = useUi((s) => s.helpOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const presentingRef = useRef(false);
  const keySel = useUi((s) => s.keySel);
  const catalog = useCatalog();
  const preview = useMemo(() => previewOf(project, muted, solo), [project, muted, solo]);
  const host = usePlayerHost(health, preview, project.id);
  const { state } = useRenderState(host.playerRef, host.ready);
  const [dock, setDock] = useState<DockController | null>(null);
  const [present, setPresent] = useState<ReadonlySet<PanelId>>(() => new Set());
  // Which panels are on screen (the front tab of their group), as opposed to present: the AI panel can sit behind the inspector's tab.
  const [shown, setShown] = useState<ReadonlySet<PanelId>>(() => new Set());
  const onVisible = useCallback((id: PanelId, visible: boolean) => {
    setShown((cur) => {
      if (cur.has(id) === visible) return cur;
      const next = new Set(cur);
      if (visible) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [wantAgent] = useState(readAgentOpen);
  const agentOpen = shown.has('agent');
  const leftOpen = present.has('sidebar');
  const setAgentOpen = (on: boolean) => {
    if (on) dock?.show('agent'); // brings the tab to the front, or adds the panel when it was closed
    else dock?.hide('agent');
  };
  // The 「AI」 button: not in front -> bring it to the front (adding it when it was closed); in front -> back to the tab that was in front of
  // it in its group. It never closes the panel and never changes the layout.
  const toggleAgent = () => {
    if (!agentOpen) {
      setAgentOpen(true);
      useAgent.getState().focusInput();
    } else if (!dock?.back('agent')) useAgent.getState().focusInput();
  };
  // The stage's DOM host belongs to the workspace, not to a dock panel: the Pixi application is built once and survives every layout change.
  const [stageHost] = useState(() => {
    const d = document.createElement('div');
    d.className = 'center-pane';
    return d;
  });
  const onCenter = useCallback((id: 'stage' | 'storyboard') => {
    const next = id === 'stage' ? 'preview' : 'storyboard';
    if (useUi.getState().centerView !== next) useUi.getState().set({ centerView: next });
  }, []);
  // The assistant's open flag is remembered on its own too (older versions and the tests read it).
  useEffect(() => {
    if (dock) writeAgentOpen(agentOpen);
  }, [dock, agentOpen]);
  // The 预览 / 分镜 buttons activate the matching dock tab (adding the storyboard if it was closed); closing the storyboard returns to the preview.
  useEffect(() => {
    if (!dock) return;
    const want = centerView === 'storyboard' ? 'storyboard' : 'stage';
    if (!dock.has(want)) dock.show(want);
    else dock.activate(want);
  }, [dock, centerView]);
  useEffect(() => {
    if (dock && centerView === 'storyboard' && !present.has('storyboard')) useUi.getState().set({ centerView: 'preview' });
  }, [dock, present, centerView]);
  // The first-run dialog handed its cards over: the AI panel comes to the front so that they are the first thing in the editor.
  const reveal = useAiFlow((s) => s.reveal);
  useEffect(() => {
    if (!dock || !reveal) return;
    dock.show('agent');
    dock.activate('agent');
    useAiFlow.getState().clearReveal();
  }, [dock, reveal]);
  const [tab, setTab] = useState<'script' | 'assets'>('script');
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraRequest, setCameraRequest] = useState<CameraGenerationRequest | null>(null);
  const aiBusy = useDirectorRun((s) => s.busy);
  // The director's run state and the assistant's conversation belong to the open project; leaving it (or the editor) ends a running generation.
  useEffect(() => {
    useDirectorRun.getState().bindProject(project.id);
    useAgent.getState().bindProject(project.id);
    useAiFlow.getState().bind(project.id);
    return () => {
      useDirectorRun.getState().unbind();
      useAiFlow.getState().unbind();
    };
  }, [project.id]);
  const regenerateCamera = (sceneIds: string[]) => {
    if (aiBusy || cameraRequest) return;
    const snapshot = useProject.getState().project;
    if (!snapshot?.source.text || sceneIds.length === 0 || !sceneIds.every((id) => snapshot.scenes.some((s) => s.id === id))) return;
    let consumed = false;
    const request: CameraGenerationRequest = {
      projectId: snapshot.id, sceneIds,
      consume: () => {
        if (consumed) return false;
        consumed = true;
        setCameraRequest((current) => current === request ? null : current);
        return true;
      },
    };
    setCameraRequest(request);
    // the AI panel runs the request once the AI settings are known
    dock?.show('agent');
  };
  // The travel notice belongs to one explicit switch; never carry it across mounts or projects.
  useEffect(() => {
    useUi.getState().set({ travelNotice: null });
    return () => useUi.getState().set({ travelNotice: null });
  }, [project.id]);
  useShortcuts(host, project.settings.fps);
  // Ctrl+K: open the AI assistant panel and focus its input; pressed again while the assistant's input has the focus, it closes the panel (the selection stays as it is).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (agentOpen && (document.activeElement as HTMLElement | null)?.dataset.testid === 'agent-input') {
          setAgentOpen(false);
          (document.activeElement as HTMLElement | null)?.blur?.();
          return;
        }
        setAgentOpen(true);
        useAgent.getState().focusInput();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const focusBeat = (sceneId: string, beatId: string | undefined) => {
    useProject.getState().select({ sceneId, beatId: beatId ?? null });
    useUi.getState().set({ cards: [] });
    const sc = host.playerRef.current?.compiled.scenes.find((s) => s.id === sceneId);
    const t = beatId ? (sc?.beats.find((b) => b.id === beatId)?.start ?? -1) + 0.01 : sc ? sc.start + 0.01 : undefined;
    if (t !== undefined && t > 0) host.seek(t);
  };

  // The inspector follows the playhead.
  const sceneIndex = host.info.scene;
  const beatId = host.info.beat;
  useEffect(() => {
    if (!host.ready || !sceneIndex) return;
    const sc = useProject.getState().project?.scenes.find((s) => s.id === sceneIndex);
    if (sc) useProject.getState().select({ sceneId: sc.id, ...(beatId ? { beatId } : {}) });
  }, [host.ready, sceneIndex, beatId]);
  // Key selection belongs to one scene.
  useEffect(() => {
    useUi.getState().set({ keySel: [] });
  }, [selection.sceneId]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (useProject.getState().saveState !== 'saved') e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const saveCopy = async () => {
    const copy = structuredClone(project);
    copy.id = newProjectId();
    copy.title = `${project.title} 副本`;
    try {
      const r = await createProject(copy);
      useProject.getState().open(r.project, r.etag);
      history.replaceState(null, '', `/editor/${r.project.id}`);
      setNotice(`已另存为 “${copy.title}”`);
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const presentProject = async () => {
    if (presentingRef.current || useProject.getState().saveState === 'saving') return;
    presentingRef.current = true;
    setPresenting(true);
    try {
      if (!await useProject.getState().save()) return;
      // An edit made while the request was in flight must not play an older saved version.
      const latest = useProject.getState();
      if (latest.project?.id !== project.id || latest.saveState !== 'saved') {
        setNotice('保存期间内容发生变化，请再次点击放映。');
        return;
      }
      location.assign(`/play/${encodeURIComponent(project.id)}`);
    } finally {
      presentingRef.current = false;
      setPresenting(false);
    }
  };

  const total = useMemo(() => project.scenes.reduce((n, s) => n + s.beats.length, 0), [project.scenes]);
  const problems = host.reloadError ?? saveError;
  const set = useUi.getState().set;

  const renderPanel = (id: PanelId, visible: boolean): ReactNode => {
    switch (id) {
      case 'sidebar':
        return (
          <div className="ws-left" data-testid="left-panel">
            <nav className="tabs">
              <button className={tab === 'script' ? 'active' : ''} onClick={() => setTab('script')} data-testid="tab-script">剧本</button>
              <button className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')} data-testid="tab-assets">素材</button>
            </nav>
            <div className="panel-scroll">{tab === 'script' ? <Outline seek={host.seek} playerRef={host.playerRef} compiled={host.compiled} catalog={catalog} /> : <AssetBrowser />}</div>
          </div>
        );
      case 'storyboard':
        return <div className="sb-dock"><Storyboard project={project} host={host} active={visible} /></div>;
      case 'agent':
        return (
          <div className="ws-agent" data-testid="agent-dock">
            <div className="panel-scroll"><AiPanel visible={visible} onFocusBeat={focusBeat} cameraRequest={cameraRequest} /></div>
          </div>
        );
      case 'inspector':
        return (
          <div className="ws-right" data-testid="right-panel">
            <div className="panel-scroll"><Inspector catalog={catalog} compiled={host.compiled} state={state} t={state?.t ?? host.info.t} /></div>
          </div>
        );
      case 'timeline':
        return (
          <section className="ws-bottom" data-testid="bottom-panel">
            <Timeline project={project} host={host} catalog={catalog} />
          </section>
        );
      default:
        return null; // the stage is attached by the dock itself
    }
  };

  return (
    <div className="ws" data-testid="workspace">
      <header className="ws-top">
        <button className="btn" onClick={onExit} data-testid="btn-projects" title="返回项目列表">‹ 项目</button>
        <button className="btn primary" disabled={presenting || saveState === 'saving'} onClick={() => void presentProject()} data-testid="btn-present" title="保存当前项目并进入播放器">{presenting ? '准备放映…' : '▶ 放映'}</button>
        <span className="ws-title" data-testid="ws-title" title={project.id}>{project.title}</span>
        <span className={`save-state s-${saveState}`} data-testid="save-state" title={saveError ?? ''}>{etag === null && saveState !== 'saving' ? '尚未保存' : SAVE_TEXT[saveState]}</span>
        <span className="sep" />
        <button className="btn" disabled={!canUndo} onClick={() => useProject.getState().undo()} data-testid="btn-undo" title={undoLabel ? `撤销：${undoLabel}（Ctrl+Z）` : '没有可撤销的操作'}>↶ 撤销</button>
        <button className="btn" disabled={!canRedo} onClick={() => useProject.getState().redo()} data-testid="btn-redo" title={redoLabel ? `重做：${redoLabel}（Ctrl+Shift+Z）` : '没有可重做的操作'}>↷ 重做</button>
        <span className="sep" />
        <span className="seg view-tabs" role="tablist" aria-label="中央视图">
          <button role="tab" aria-selected={centerView === 'preview'} className={centerView === 'preview' ? 'on' : ''} onClick={() => set({ centerView: 'preview' })} data-testid="view-preview">预览</button>
          <button role="tab" aria-selected={centerView === 'storyboard'} className={centerView === 'storyboard' ? 'on' : ''} onClick={() => set({ centerView: 'storyboard' })} data-testid="view-storyboard">分镜</button>
        </span>
        <span className="sep" />
        <CameraSystemSwitch project={project} onRegenerate={regenerateCamera} regenerationBusy={aiBusy || cameraRequest !== null} />
        <span className="sep" />
        <button className="btn primary" disabled={saveState === 'saving'} onClick={() => void useProject.getState().save()} data-testid="btn-save" title="保存（Ctrl+S）">保存</button>
        <button className="btn" onClick={() => void saveCopy()} data-testid="btn-save-copy">另存为副本</button>
        <button className="btn" disabled={!catalog} onClick={() => catalog && downloadProject(project, catalog.version)} data-testid="btn-export">导出</button>
        <span className="grow" />
        {notice && <span className="notice" data-testid="notice">{notice}</span>}
        <button className="btn" onClick={() => setSettingsOpen(true)} data-testid="btn-settings">AI 设置</button>
        <button className="btn" onClick={() => set({ helpOpen: true })} data-testid="btn-help" title="快捷键（?）">？ 快捷键</button>
        <button className={`btn toggle${agentOpen ? ' on' : ''}`} onClick={toggleAgent} aria-pressed={agentOpen} data-testid="btn-agent" title="AI 面板（Ctrl+K）：对话、生成、修改">AI</button>
        <button className={`btn toggle${leftOpen ? ' on' : ''}`} onClick={() => dock?.toggle('sidebar')} aria-pressed={leftOpen} title="左栏">▌◧</button>
        <button className={`btn toggle${present.has('inspector') ? ' on' : ''}`} onClick={() => dock?.toggle('inspector')} aria-pressed={present.has('inspector')} title="检查器">◨▐</button>
        <LayoutMenu dock={dock} present={present} />
      </header>

      <div className="ws-mid">
        <Dock render={renderPanel} stageHost={stageHost} agentWanted={wantAgent} onController={setDock} onPresent={setPresent} onVisible={onVisible} onCenter={onCenter} />
      </div>
      {createPortal(<Preview host={host} project={project} catalog={catalog} />, stageHost)}
      <footer className="ws-status">
        <span>{project.scenes.length} 个场景 · {total} 句</span>
        <span>选中：{selection.sceneId ?? '—'}{selection.beatId ? ` / ${selection.beatId}` : ''}{selection.castId ? ` / ${selection.castId}` : ''}{keySel.length > 0 ? ` · ${keySel.length} 个关键帧` : ''}</span>
        {(muted.length > 0 || solo.length > 0) && <span className="warn" data-testid="mute-note">预览中有静音 / 独奏的轨道（不影响项目）</span>}
        <span className="grow" />
        {toast && (
          <span className={`toast ${toast.tone}`} role="status" data-testid="toast">
            {toast.text}
            {toast.action && <button className="toast-act" data-testid="toast-action" onClick={() => { toast.action!.run(); useUi.getState().set({ toast: null }); }}>{toast.action.label}</button>}
          </span>
        )}
        {problems && <span className="bad" data-testid="problem">⚠ {problems}</span>}
        <span>{host.ready ? '预览就绪' : host.status}</span>
      </footer>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {helpOpen && (
        <Modal title="快捷键" onClose={() => set({ helpOpen: false })} testid="help-sheet">
          <table className="keys-table"><tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
          <p className="hint">在预览里：自动取景中的主角，拖动调整本镜画面位置，Shift+拖动修改站位；其他人物则拖动修改站位，Shift+拖动调整画面位置。运镜系统使用紧凑舞台，精细构图可用本镜偏移。Alt+滚轮调整纵深；头顶刻度盘调整朝向（Alt 调整视线）；相机工具下拖动 / 滚轮调整取景。</p>
        </Modal>
      )}
    </div>
  );
}
