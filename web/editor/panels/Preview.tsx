/** Centre: the live preview (same Stage / Player as the play page) with direct-manipulation tools and the transport bar. */
import { useRef } from 'react';
import type { CompactCatalog } from '@shared/schema/assets';
import type { Project } from '@shared/schema/project';
import type { usePlayerHost } from '../../play/usePlayerHost';
import { useProject } from '../../store/projectStore';
import { useUi } from '../../store/uiStore';
import { AspectBox } from '../../ui/AspectBox';
import { StageOverlay } from '../stageTools/StageOverlay';
import { useRenderState } from '../useRenderState';
import { ActorControls } from './ActorFields';

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
/** The editor always previews in the project's frame, 16:9. */
const EDITOR_ASPECT = 16 / 9;
type Host = ReturnType<typeof usePlayerHost>;

const OVERLAYS: Array<['safe' | 'thirds' | 'eyeLine', string, string]> = [
  ['safe', '安全区', '动作安全区 93% / 标题安全区 90%'],
  ['thirds', '三分线', '三分构图线'],
  ['eyeLine', '眼线带', '原作 SR 眼线带 0.36–0.45H'],
];

export function Preview({ host, project, catalog }: { host: Host; project: Project; catalog: CompactCatalog | null }) {
  const { ready, playing, info, toggle, seek, advance, playerRef, hostRef, error, status, compiled } = host;
  const empty = project.scenes.length === 0;
  const tool = useUi((s) => s.tool);
  const overlays = useUi((s) => s.overlays);
  const ref = useUi((s) => s.ref);
  const set = useUi((s) => s.set);
  const rate = useUi((s) => s.rate);
  const file = useRef<HTMLInputElement>(null);
  const selection = useProject((s) => s.selection);
  const { state } = useRenderState(playerRef, ready);
  const scene = state ? project.scenes.find((s) => s.id === state.sceneId) : undefined;
  const castId = selection.castId && scene?.wardrobe[selection.castId] ? selection.castId : null;

  return (
    <div className="preview" data-testid="preview">
      <div className="tools" data-testid="preview-tools">
        <span className="seg" role="group" aria-label="工具">
          <button className={tool === 'select' ? 'on' : ''} aria-pressed={tool === 'select'} onClick={() => set({ tool: 'select' })} data-testid="tool-select" title="选择 / 拖动角色（V）">选择</button>
          <button className={tool === 'camera' ? 'on' : ''} aria-pressed={tool === 'camera'} onClick={() => set({ tool: 'camera' })} data-testid="tool-camera" title="拖动平移 / 滚轮缩放镜头（C）">相机</button>
        </span>
        <span className="sep" />
        {OVERLAYS.map(([k, label, tip]) => (
          <button key={k} className={`btn-s${overlays[k] ? ' on' : ''}`} aria-pressed={overlays[k]} title={tip} data-testid={`overlay-${k}`} onClick={() => set({ overlays: { ...overlays, [k]: !overlays[k] } })}>{label}</button>
        ))}
        <button className={`btn-s${ref ? ' on' : ''}`} title="载入一张参考图叠在画面上（对齐构图）" data-testid="overlay-ref" onClick={() => file.current?.click()}>参考帧…</button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          data-testid="ref-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            if (ref) URL.revokeObjectURL(ref.url);
            set({ ref: { url: URL.createObjectURL(f), opacity: 0.5, diff: false }, overlays: { ...overlays, ref: true } });
          }}
        />
        <span className="grow" />
        <span className="dim tools-hint" title="在画面上直接编辑">拖动人物：站位或画面位置（见画面提示）· Alt+滚轮：纵深 · 刻度盘：朝向</span>
        {ref && (
          <>
            <label className="inline">透明度<input type="range" min={0} max={1} step={0.05} value={ref.opacity} data-testid="ref-opacity" onChange={(e) => set({ ref: { ...ref, opacity: Number(e.target.value) } })} /></label>
            <button className={`btn-s${ref.diff ? ' on' : ''}`} aria-pressed={ref.diff} data-testid="ref-diff" onClick={() => set({ ref: { ...ref, diff: !ref.diff } })}>差值</button>
            <button className={`btn-s${overlays.ref ? ' on' : ''}`} aria-pressed={overlays.ref} data-testid="ref-toggle" onClick={() => set({ overlays: { ...overlays, ref: !overlays.ref } })}>显示</button>
            <button className="btn-s" data-testid="ref-clear" onClick={() => { URL.revokeObjectURL(ref.url); set({ ref: null }); }}>移除</button>
          </>
        )}
      </div>
      <AspectBox className="viewport" frameClassName="stage-frame" frameTestId="stage-frame" aspect={EDITOR_ASPECT}>
        <div className="play-stage" ref={hostRef} data-testid="play-stage" />
        {ready && !empty && <StageOverlay host={host} project={project} compiled={compiled} />}
        {empty && <p className="overlay-msg" data-testid="preview-empty">这个项目还没有场景。在左侧“剧本”里点“添加场景”开始，或基于示例创建。</p>}
        {error && <p className="overlay-msg bad" data-testid="play-error">{error}</p>}
      </AspectBox>
      {castId && scene && !playing && (
        <div className="quickbar" data-testid="quickbar">
          <strong>{project.cast.find((c) => c.id === castId)?.displayName ?? castId}</strong>
          <span className="dim">@ {fmt(info.t)}</span>
          <ActorControls ctx={{ project, scene, castId, t: state?.t ?? info.t, state, catalog }} compact />
        </div>
      )}
      <div className="transport">
        <button className="btn primary" disabled={!ready} onClick={toggle} data-testid="play-toggle" title="播放 / 暂停（空格）">{playing ? '❚❚ 暂停' : '▶ 播放'}</button>
        <button className="btn" disabled={!ready} onClick={advance} data-testid="play-next" title="跳到下一句（↓）">下一句 ⏭</button>
        <span className="tc" data-testid="play-time">{fmt(info.t)}</span>
        <input type="range" className="seek" min={0} max={Math.max(1, Math.round(info.duration * 100))} value={Math.round(info.t * 100)} disabled={!ready} onChange={(e) => seek(Number(e.target.value) / 100)} data-testid="play-seek" />
        <span className="tc dim" data-testid="play-duration">{fmt(info.duration)}</span>
        <label className="inline">速度
          <select value={rate} onChange={(e) => { set({ rate: Number(e.target.value) }); if (playerRef.current) playerRef.current.rate = Number(e.target.value); }} data-testid="play-rate">
            {[0.25, 0.5, 1, 2, 4].map((r) => <option key={r} value={r}>{r}×</option>)}
          </select>
        </label>
        <span className="dim" data-testid="play-status">{error ? '' : status}</span>
      </div>
    </div>
  );
}
