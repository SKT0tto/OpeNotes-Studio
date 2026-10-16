/** The camera system switch of the top toolbar: 经典 | 运镜, the project's camera system, one click, undoable. */
import { scenesNeedingTravelDirection } from '@shared/director/travelDirection';
import { cameraSystemOf, type CameraSystem, type Project } from '@shared/schema/project';
import { useProject } from '../store/projectStore';
import { useUi } from '../store/uiStore';
import { Modal } from './ui';
import { openTravelNoticeIfNeeded } from './travelNotice';

const LABEL: Record<CameraSystem, string> = { classic: '经典', travel: '运镜' };
const TITLE: Record<CameraSystem, string> = {
  classic: '硬切为主（millsage 式），静帧与旧版完全相同',
  travel: '按叙事意图决定推拉、横移或硬切；未设置意图时按镜头结构推断，切换不会重新设计分镜',
};

export function CameraSystemSwitch({ project, onRegenerate, regenerationBusy }: { project: Project; onRegenerate: (sceneIds: string[]) => void; regenerationBusy: boolean }) {
  const noticeOpen = useUi((u) => u.travelNotice?.projectId === project.id);
  const setNoticeOpen = (open: boolean) => useUi.getState().set({ travelNotice: open ? { projectId: project.id } : null });
  const needing = scenesNeedingTravelDirection(project);
  const selected = useProject((s) => s.selection.sceneId);
  const current: CameraSystem = project.settings.cameraSystem ?? 'classic';
  const differing = project.scenes.filter((s) => cameraSystemOf(project, s) !== current).length;
  const scene = project.scenes.find((s) => s.id === selected);
  const sceneSystem = scene ? cameraSystemOf(project, scene) : current;
  const generationScene = scene ?? project.scenes[0];
  const generationDisabled = !project.source.text ? '这个项目没有原文，不能重新生成镜头。'
    : !generationScene ? '这个项目没有场景，不能重新生成镜头。'
      : regenerationBusy ? '正在生成，请等待当前请求完成。' : '';
  const choose = (next: CameraSystem) => {
    if (next === current) return;
    useProject.getState().applyEdit((d) => {
      if (next === 'travel') d.settings.cameraSystem = 'travel';
      else delete d.settings.cameraSystem;
    }, '切换镜头系统');
    if (next === 'travel') openTravelNoticeIfNeeded(null);
  };
  const note = differing > 0 ? `（${differing} 个场景单独设置）` : '';
  return (
    <>
      <span className="seg cam-system" role="radiogroup" aria-label="镜头系统" data-testid="cam-system" data-system={current}>
        {(['classic', 'travel'] as const).map((k) => (
          <button key={k} role="radio" aria-checked={current === k} className={current === k ? 'on' : ''} title={`${TITLE[k]}${note}`} data-testid={`cam-system-${k}`} onClick={() => choose(k)}>
            {LABEL[k]}
          </button>
        ))}
      </span>
      {noticeOpen && (
        <Modal title="已切换到运镜模式" onClose={() => setNoticeOpen(false)} testid="camera-travel-notice">
          <p>现有分镜会按运镜规则播放，台词、景别和焦点保留。切换不会重新设计分镜；未设置「叙事意图」的旧分镜会按镜头结构推断。</p>
          {project.source.text ? (
            <p>可重新生成本场景或全部尚未设计运镜的场景的镜头，也可在右侧「镜头」面板手动设置「叙事意图」。生成后先预览差异，接受后才应用；未配置 AI 时使用规则导演（非 AI）。</p>
          ) : (
            <p>这个项目没有原文，不能直接使用 AI 导演。可在右侧「镜头」面板手动设置「叙事意图」。</p>
          )}
          {project.scenes.some((s) => s.cameraSystem && s.cameraSystem !== 'inherit') && (
            <p className="hint">单独设置了镜头系统的场景仍遵循场景设置。</p>
          )}
          {generationScene && <p className="hint">本场景：{generationScene.title}</p>}
          {generationDisabled && <p className="hint" data-testid="camera-travel-regenerate-reason">{generationDisabled}</p>}
          <div className="modal-actions">
            <button className="btn primary" disabled={!!generationDisabled} title={generationDisabled || '生成本场景镜头并预览差异'} onClick={() => {
              if (!generationScene || generationDisabled) return;
              setNoticeOpen(false);
              onRegenerate([generationScene.id]);
            }} data-testid="camera-travel-regenerate">重新生成本场景镜头</button>
            {needing.length > 0 && (
              <button className="btn primary" disabled={!!generationDisabled} title={generationDisabled || `依次为 ${needing.length} 个尚未设计运镜的场景生成镜头并预览差异`} onClick={() => {
                if (generationDisabled) return;
                setNoticeOpen(false);
                onRegenerate(needing.map((s) => s.id));
              }} data-testid="camera-travel-regenerate-all">重新生成全部场景镜头（{needing.length} 场）</button>
            )}
            <button className="btn" onClick={() => setNoticeOpen(false)} data-testid="camera-travel-notice-dismiss">知道了</button>
          </div>
        </Modal>
      )}
      {scene && sceneSystem !== current && (
        <button className="chip pick on cam-override" data-testid="cam-system-scene-override" title="本场景单独设置了镜头系统，点击到场景页修改" onClick={() => useUi.getState().set({ inspectorTab: 'scene' })}>
          本场景：{LABEL[sceneSystem]}
        </button>
      )}
    </>
  );
}
