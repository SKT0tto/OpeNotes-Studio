import { useEffect, useRef, useState } from 'react';
import { ProjectSchema, type Project } from '@shared/schema/project';
import demoJson from '../../tests/fixtures/demo-project.json';
import type { Health } from '../api';
import { loadProject } from '../projectsApi';
import { AspectBox } from '../ui/AspectBox';
import { usePlayerHost } from './usePlayerHost';

/** Window shapes: the editor's 16:9, and the original game's wide frame (reference frames are 1920x890). */
const ASPECTS = [['16:9', 16 / 9], ['宽画幅 2.16:1', 1920 / 890]] as const;

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

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
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Reset, then fetch: the project is server state keyed by id.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProject(null);
    setLoadError(null);
    fetchProject(projectId).then(setProject, (e: Error) => setLoadError(e.message));
  }, [projectId]);

  const { hostRef: host, playerRef, status, error, ready, playing, info, toggle, advance, seek, auto, setAuto } = usePlayerHost(health, project, projectId, aspect);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement && e.target.type !== 'range') && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        advance();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [advance]);

  const err = loadError ?? error;
  return (
    <div className="play" ref={root} data-testid="play-page" style={{ ['--aspect' as string]: aspect }}>
      <AspectBox className="play-viewport" frameClassName="play-frame" frameTestId="stage-frame" aspect={aspect}>
        <div className="play-stage" ref={host} onClick={advance} data-testid="play-stage" />
      </AspectBox>
      <p className="dim" data-testid="play-status">{err ? '' : project ? status : '读取项目…'}</p>
      {err && <p className="bad" data-testid="play-error">{err}</p>}
      <div className="play-controls">
        <button onClick={toggle} disabled={!ready} data-testid="play-toggle">{playing ? '暂停' : '播放'}</button>
        <input
          type="range"
          className="seek"
          min={0}
          max={Math.max(1, Math.round(info.duration * 100))}
          value={Math.round(info.t * 100)}
          disabled={!ready}
          onChange={(e) => seek(Number(e.target.value) / 100)}
          data-testid="play-seek"
        />
        <span className="time" data-testid="play-time">{fmt(info.t)} / {fmt(info.duration)}</span>
        <label>
          速度{' '}
          <select value={rate} onChange={(e) => { setRate(Number(e.target.value)); if (playerRef.current) playerRef.current.rate = Number(e.target.value); }} data-testid="play-rate">
            {[0.25, 0.5, 1, 2, 4].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-testid="play-auto" />
          自动推进
        </label>
        <button onClick={advance} disabled={!ready} data-testid="play-next">下一句 / 显示全文</button>
        <label>
          画幅{' '}
          <select value={aspect} onChange={(e) => setAspect(Number(e.target.value))} data-testid="play-aspect">
            {ASPECTS.map(([l, v]) => <option key={l} value={v}>{l}</option>)}
          </select>
        </label>
        <button onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen?.(); }} data-testid="play-fullscreen">全屏</button>
      </div>
      <div className="play-scenes">
        {project?.scenes.map((s, i) => (
          <button key={s.id} disabled={!ready} onClick={() => seek((info.sceneStarts[i] ?? 0) + 0.01)} data-testid={`play-scene-${s.id}`}>
            {i + 1}. {s.title}
          </button>
        ))}
        <span className="dim" data-testid="play-where">场景 {info.scene}（{info.sceneTitle}）{info.beat && ` · ${info.beat}`}</span>
      </div>
    </div>
  );
}
