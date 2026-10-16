/** The editing workspace: top bar, left panel (script / assets), live preview or storyboard, inspector, timeline, status bar. */
import { useEffect, useMemo, useState } from 'react';
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
import { AiPanel, type CameraGenerationRequest } from './panels/AiPanel';
import { Inspector } from './panels/Inspector';
import { Outline } from './panels/Outline';
import { Preview } from './panels/Preview';
import { Storyboard } from './storyboard/Storyboard';
import { Timeline } from './timeline/Timeline';
import { Modal, Splitter, usePanelSize } from './ui';
import { useCatalog } from './useCatalog';
import { useRenderState } from './useRenderState';
import { SHORTCUTS, useShortcuts } from './useShortcuts';

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
  const keySel = useUi((s) => s.keySel);
  const catalog = useCatalog();
  const preview = useMemo(() => previewOf(project, muted, solo), [project, muted, solo]);
  const host = usePlayerHost(health, preview, project.id);
  const { state } = useRenderState(host.playerRef, host.ready);
  const [leftW, setLeftW] = usePanelSize('left', 320, 220, 640);
  const [rightW, setRightW] = usePanelSize('right', 340, 260, 560);
  const [bottomH, setBottomH] = usePanelSize('bottom2', 290, 120, 560);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [tab, setTab] = useState<'script' | 'assets' | 'ai'>('script');
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraRequest, setCameraRequest] = useState<CameraGenerationRequest | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const selectTab = (next: typeof tab) => {
    cameraRequest?.consume();
    setTab(next);
  };
  const regenerateCamera = (sceneId: string) => {
    if (aiBusy || cameraRequest) return;
    const snapshot = useProject.getState().project;
    if (!snapshot?.source.text || !snapshot.scenes.some((s) => s.id === sceneId)) return;
    let consumed = false;
    const request: CameraGenerationRequest = {
      projectId: snapshot.id, sceneId,
      consume: () => {
        if (consumed) return false;
        consumed = true;
        setCameraRequest((current) => current === request ? null : current);
        return true;
      },
    };
    setCameraRequest(request);
    setLeftOpen(true);
    setTab('ai');
  };
  useShortcuts(host, project.settings.fps);

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

  const total = useMemo(() => project.scenes.reduce((n, s) => n + s.beats.length, 0), [project.scenes]);
  const problems = host.reloadError ?? saveError;
  const set = useUi.getState().set;

  return (
    <div className="ws" data-testid="workspace">
      <header className="ws-top">
        <button className="btn" onClick={onExit} data-testid="btn-projects" title="返回项目列表">‹ 项目</button>
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
        <button className={`btn toggle${leftOpen ? ' on' : ''}`} onClick={() => { if (leftOpen) cameraRequest?.consume(); setLeftOpen(!leftOpen); }} aria-pressed={leftOpen} title="左栏">▌◧</button>
        <button className={`btn toggle${rightOpen ? ' on' : ''}`} onClick={() => setRightOpen(!rightOpen)} aria-pressed={rightOpen} title="检查器">◨▐</button>
      </header>

      <div className="ws-mid">
        {leftOpen && (
          <>
            <aside className="ws-left" style={{ width: leftW }} data-testid="left-panel">
              <nav className="tabs">
                <button className={tab === 'script' ? 'active' : ''} onClick={() => selectTab('script')} data-testid="tab-script">剧本</button>
                <button className={tab === 'assets' ? 'active' : ''} onClick={() => selectTab('assets')} data-testid="tab-assets">素材</button>
                <button className={tab === 'ai' ? 'active' : ''} onClick={() => selectTab('ai')} data-testid="tab-ai">AI 导演</button>
              </nav>
              <div className="panel-scroll">{tab === 'script' ? <Outline seek={host.seek} playerRef={host.playerRef} compiled={host.compiled} catalog={catalog} /> : tab === 'ai' ? <AiPanel cameraRequest={cameraRequest} onBusyChange={setAiBusy} /> : <AssetBrowser />}</div>
            </aside>
            <Splitter axis="x" label="调整左栏宽度" onDelta={(d) => setLeftW(leftW + d)} />
          </>
        )}
        <main className="ws-center">
          <div className={`center-pane${centerView === 'storyboard' ? ' behind' : ''}`} aria-hidden={centerView === 'storyboard'}>
            <Preview host={host} project={project} catalog={catalog} />
          </div>
          {centerView === 'storyboard' && <Storyboard project={project} host={host} active />}
        </main>
        {rightOpen && (
          <>
            <Splitter axis="x" label="调整检查器宽度" onDelta={(d) => setRightW(rightW - d)} />
            <aside className="ws-right" style={{ width: rightW }} data-testid="right-panel">
              <div className="panel-title">检查器</div>
              <div className="panel-scroll"><Inspector catalog={catalog} compiled={host.compiled} state={state} t={state?.t ?? host.info.t} /></div>
            </aside>
          </>
        )}
      </div>

      <Splitter axis="y" label="调整底部高度" onDelta={(d) => setBottomH(bottomH - d)} />
      <section className="ws-bottom" style={{ height: bottomH }} data-testid="bottom-panel">
        <Timeline project={project} host={host} catalog={catalog} />
      </section>
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
