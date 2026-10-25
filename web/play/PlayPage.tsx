import { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectSchema, type Project } from '@shared/schema/project';
import demoJson from '../../tests/fixtures/demo-project.json';
import type { Health } from '../api';
import { loadProject } from '../projectsApi';
import { AspectBox } from '../ui/AspectBox';
import { PlaySeek, PlayTime } from './PlayClock';
import { usePlayerHost } from './usePlayerHost';

/** Window shapes: the editor's 16:9, and the original game's wide frame (reference frames are 1920x890). */
const ASPECTS = [['16:9', 16 / 9], ['宽画幅 2.16:1', 1920 / 890]] as const;

/** `/play/demo` is the bundled example; any other id is read from the project store. */
async function fetchProject(id: string): Promise<Project> {
  if (id === 'demo') return ProjectSchema.parse(demoJson);
  return (await loadProject(id)).project;
}

export function PlayPage({ health, projectId }: { health: Health; projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [aspect, setAspect] = useState<number>(16 / 9);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyboardFocus = useRef(false);

  useEffect(() => {
    // Reset, then fetch: the project is server state keyed by id.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProject(null);
    setLoadError(null);
    let cancelled = false;
    fetchProject(projectId).then((p) => { if (!cancelled) setProject(p); }, (e: Error) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [projectId]);

  const { hostRef: host, playerRef, status, error, ready, playing, info, toggle, advance, seek, auto, setAuto } = usePlayerHost(health, project, projectId, aspect);

  const revealControls = useCallback(() => {
    clearTimeout(idleTimer.current);
    setControlsVisible(true);
    if (fullscreen && playing) {
      idleTimer.current = setTimeout(() => {
        // Keyboard users keep the controls while operating them; pointer clicks do not pin the toolbar open.
        if (keyboardFocus.current && root.current?.querySelector('.play-chrome:focus-within')) return;
        setControlsVisible(false);
      }, 2600);
    }
  }, [fullscreen, playing]);

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, []);

  useEffect(() => {
    // Fullscreen / playback transitions reset the idle clock; paused controls always remain visible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    revealControls();
    return () => clearTimeout(idleTimer.current);
  }, [revealControls]);

  useEffect(() => {
    if (ready && playerRef.current) playerRef.current.rate = rate;
  }, [ready, playerRef, rate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      keyboardFocus.current = true;
      revealControls();
      if (e.key === 'Escape' && document.fullscreenElement === root.current) {
        // Also covers browsers that deliver Escape to the page before handling native fullscreen.
        void document.exitFullscreen().catch(() => {});
      }
      const target = e.target instanceof Element ? e.target : null;
      if (e.code === 'Space' && !target?.closest('input, select, textarea, button, a, [contenteditable="true"]')) {
        e.preventDefault();
        advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance, revealControls]);

  const toggleFullscreen = async () => {
    setFullscreenError(null);
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen();
      else setFullscreenError('当前浏览器不支持全屏。');
    } catch {
      setFullscreenError('无法进入全屏，请重试或检查浏览器设置。');
    }
  };

  const err = loadError ?? error;
  return (
    <div className={`play${fullscreen ? ' is-fullscreen' : ''}${controlsVisible ? '' : ' controls-hidden'}`} ref={root} data-testid="play-page"
      onPointerMove={revealControls} onPointerDown={() => { keyboardFocus.current = false; revealControls(); }}
      onFocusCapture={revealControls} onBlurCapture={revealControls}>
      <header className="play-header play-chrome">
        <a className="play-back" href={projectId === 'demo' ? '/' : `/editor/${encodeURIComponent(projectId)}`} data-testid="play-back">‹ {projectId === 'demo' ? '项目列表' : '返回编辑器'}</a>
        <div className="play-heading">
          <span className="play-eyebrow">{projectId === 'demo' ? '示例放映' : '项目放映'}</span>
          <h1>{project?.title ?? '读取项目…'}</h1>
        </div>
        <span className="play-status" data-testid="play-status" role="status">{err ? '' : project ? status : '读取项目…'}</span>
      </header>
      <AspectBox className="play-viewport" frameClassName="play-frame" frameTestId="stage-frame" aspect={aspect}>
        <div className="play-stage" ref={host} onClick={advance} data-testid="play-stage" aria-label="放映画面，空格或点击推进台词" />
      </AspectBox>
      {err && <p className="play-error" role="alert" data-testid="play-error">{err}</p>}
      <footer className="play-deck play-chrome" data-testid="play-deck">
        <div className="play-progress">
          <PlaySeek playerRef={playerRef} ready={ready} duration={info.duration} onSeek={seek} testId="play-seek" />
          <PlayTime playerRef={playerRef} ready={ready} duration={info.duration} withDuration className="play-time" testId="play-time" />
        </div>
        <div className="play-controls">
          <button className="play-primary" onClick={toggle} disabled={!ready} data-testid="play-toggle">{playing ? 'Ⅱ 暂停' : '▶ 播放'}</button>
          <button onClick={advance} disabled={!ready} data-testid="play-next" title="推进台词或显示全文（空格）">下一句 <span aria-hidden="true">›</span></button>
          <label className="play-auto"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-testid="play-auto" />自动推进</label>
          <span className="play-control-spacer" />
          <label>速度<select value={rate} onChange={(e) => setRate(Number(e.target.value))} data-testid="play-rate">
            {[0.25, 0.5, 1, 2, 4].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select></label>
          <label>画幅<select value={aspect} onChange={(e) => setAspect(Number(e.target.value))} data-testid="play-aspect">
            {ASPECTS.map(([l, v]) => <option key={l} value={v}>{l}</option>)}
          </select></label>
          <button onClick={() => void toggleFullscreen()} aria-pressed={fullscreen} data-testid="play-fullscreen">{fullscreen ? '退出全屏' : '全屏'}</button>
        </div>
        <div className="play-scene-row">
          <nav className="play-scenes" aria-label="切换场景">
            {project?.scenes.map((s, i) => (
              <button key={s.id} disabled={!ready} aria-current={info.scene === s.id ? 'true' : undefined} onClick={() => seek((info.sceneStarts[i] ?? 0) + 0.01)} data-testid={`play-scene-${s.id}`} title={s.title}>
                <span>{String(i + 1).padStart(2, '0')}</span> {s.title}
              </button>
            ))}
          </nav>
          <span className="play-where" data-testid="play-where" title={info.sceneTitle}>{info.sceneTitle || '等待场景'}{info.beat && ` · ${info.beat}`}</span>
        </div>
        {fullscreenError && <p className="play-fullscreen-error" role="alert">{fullscreenError}</p>}
      </footer>
    </div>
  );
}
