/**
 * Direct manipulation on the preview. A transparent SVG over the stage (viewBox = stage pixels):
 *  - drag a person: slot / depth (Shift: offset inside the shot); wheel over a person: depth
 *  - the dial above the selected person's head: head yaw (Alt: gaze)
 *  - the ring on the head: gaze direction
 *  - camera tool: drag = pan, wheel = zoom (the framing of the current line becomes hand-made); Alt-drag = background framing
 * All of it writes ordinary keys / fields through the editor actions (one undo step per gesture).
 */
import { useEffect, useRef } from 'react';
import { placeActor } from '@shared/staging/ground';
import { bgZoom, clampCamera, viewWorldHeight } from '@shared/staging/world';
import type { Project } from '@shared/schema/project';
import type { CompiledProject } from '@shared/timeline/types';
import type { Pt } from '@shared/staging/world';
import type { usePlayerHost } from '../../play/usePlayerHost';
import { clearManualCamera, editShot, placeActorAt, positionAt, selectActor, setManualCamera, setSlotDepth, writeKey } from '../../store/actions';
import { useProject } from '../../store/projectStore';
import { notify, useUi } from '../../store/uiStore';
import { useRenderState } from '../useRenderState';
import { beatAtTime, cameraOfBeat } from './camera';

const W = 1280;
const H = 720;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

type Host = ReturnType<typeof usePlayerHost>;
type Drag =
  | { kind: 'move'; castId: string; start: Pt; feet0: Pt; s0: number; t: number }
  | { kind: 'offset'; castId: string; start: Pt; s0: number; beatId: string; x0: number; y0: number }
  | { kind: 'yaw'; castId: string; cx: number; half: number; t: number }
  | { kind: 'gaze'; castId: string; c: Pt; w: number; h: number; t: number }
  | { kind: 'pan'; start: Pt; s0: number; pose: { x: number; y: number; zoom: number; bgZoom?: number; roll?: number }; beatId: string }
  | { kind: 'bg'; start: Pt; s0: number; ox: number; oy: number };

export function StageOverlay({ host, project, compiled }: { host: Host; project: Project; compiled: CompiledProject | null }) {
  const { state, geo } = useRenderState(host.playerRef, host.ready);
  const selection = useProject((s) => s.selection);
  const tool = useUi((s) => s.tool);
  const overlays = useUi((s) => s.overlays);
  const ref = useUi((s) => s.ref);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const sealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef({ state, geo, project, compiled, tool, sceneId: '' });
  useEffect(() => {
    live.current = { state, geo, project, compiled, tool, sceneId: state?.sceneId ?? '' };
  });

  const toStage = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const seal = () => useProject.getState().seal();

  // Wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const L = live.current;
      const st = L.state;
      const player = host.playerRef.current;
      if (!st || !player || player.isPlaying) return;
      const r = el.getBoundingClientRect();
      const pt = { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
      const scene = L.project.scenes.find((s) => s.id === st.sceneId);
      if (L.tool === 'camera') {
        e.preventDefault();
        const beatId = beatAtTime(L.compiled, scene, st.sceneId, st.t);
        const base = beatId ? cameraOfBeat(L.compiled, scene, st.sceneId, beatId) : null;
        const bg = player.stageBgGetter();
        if (!beatId) {
          notify('这是空镜头（建立镜头），没有可编辑的取景；请移到有台词的句子再用相机工具');
          return;
        }
        if (!base || !bg || !scene) return;
        const zoom = clamp(base.pose.zoom * Math.exp(-e.deltaY * 0.0012), 1, 14);
        const fr = scene.background.framing;
        const c = clampCamera(bg, { ...base.pose, zoom }, fr);
        setManualCamera(st.sceneId, beatId, c, '缩放镜头取景', 'zoom');
        clearTimeout(sealTimer.current);
        sealTimer.current = setTimeout(seal, 400);
        return;
      }
      // A bare wheel never edits the project (it scrolls the page); Alt + wheel over a person changes the depth.
      if (!e.altKey) return;
      const hit = [...L.geo].reverse().find((g) => pt.x >= g.body.x && pt.x <= g.body.x + g.body.w && pt.y >= g.body.y && pt.y <= g.body.y + g.body.h);
      if (!hit || !scene) return;
      e.preventDefault();
      const pos = positionAt(L.project, st.sceneId, hit.castId, st.t);
      if (!pos) return;
      const nd = clamp(pos.depth + (e.deltaY > 0 ? 0.04 : -0.04), 0, 1);
      if (setSlotDepth(st.sceneId, hit.castId, { slot: pos.slot, depth: nd }, st.t) === 'ok') notify(`纵深 ${pos.depth.toFixed(2)} → ${nd.toFixed(2)}`, 'info');
      clearTimeout(sealTimer.current);
      sealTimer.current = setTimeout(seal, 400);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [host.playerRef, host.ready]);

  const player = host.playerRef.current;
  const scene = state ? project.scenes.find((s) => s.id === state.sceneId) : undefined;
  const beatId = state && scene ? beatAtTime(compiled, scene, state.sceneId, state.t) : null;

  const begin = (d: Drag, e: React.PointerEvent) => {
    // close the undo group of a wheel gesture that is still waiting for its timer, so it cannot cut this drag in two
    clearTimeout(sealTimer.current);
    seal();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = d;
  };

  const isComposed = (castId: string): boolean => {
    if (!scene || !beatId) return false;
    if (cameraOfBeat(compiled, scene, scene.id, beatId)?.manual) return false;
    const cb = compiled?.scenes.find((s) => s.id === scene.id)?.beats.find((b) => b.id === beatId);
    return !!cb && cb.focus.includes(castId);
  };

  const startActor = (e: React.PointerEvent, castId: string) => {
    if (!state || !player || !scene || tool !== 'select') return;
    selectActor(castId);
    const a = state.actors.find((x) => x.castId === castId);
    const bg = player.stageBgGetter();
    const cal = a ? player.calibration(a.modelId) : null;
    const pos = positionAt(project, scene.id, castId, state.t);
    if (!a || !bg || !cal || !pos || player.isPlaying) return;
    const s0 = (H / viewWorldHeight(bg)) * state.camera.zoom;
    const start = toStage(e);
    // In an automatic shot the camera follows the blocking, so a slot drag would barely move the person on screen:
    // a plain drag of a person who is part of the framing sets the on-screen arrangement (shot offsets) instead;
    // Shift always switches to the other of the two (here: the blocking, which lets the camera follow).
    const composed = isComposed(castId);
    if (beatId && (composed ? !e.shiftKey : e.shiftKey)) {
      const b = scene.beats.find((x) => x.id === beatId);
      const off = b?.shot.offsets?.[castId] ?? { x: 0, y: 0 };
      begin({ kind: 'offset', castId, start, s0, beatId, x0: off.x, y0: off.y }, e);
      return;
    }
    begin({ kind: 'move', castId, start, feet0: placeActor(cal, pos, bg).feet, s0, t: state.t }, e);
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !state || !scene || !player) return;
    const pt = toStage(e);
    const bg = player.stageBgGetter();
    if (!bg) return;
    if (d.kind === 'move') {
      placeActorAt(scene.id, d.castId, { x: d.feet0.x + (pt.x - d.start.x) / d.s0, y: d.feet0.y + (pt.y - d.start.y) / d.s0 }, bg, d.t);
    } else if (d.kind === 'offset') {
      const Hw = viewWorldHeight(bg);
      editShot(scene.id, d.beatId, '调整镜头内人物偏移', (shot) => {
        shot.offsets ??= {};
        shot.offsets[d.castId] = { x: r2(d.x0 + (pt.x - d.start.x) / d.s0 / Hw), y: r2(d.y0 + (pt.y - d.start.y) / d.s0 / Hw) };
      }, `off.${d.castId}`);
    } else if (d.kind === 'yaw') {
      const v = r2(clamp((pt.x - d.cx) / d.half, -1, 1));
      if (e.altKey) {
        writeKey(scene.id, { kind: 'actor', castId: d.castId }, 'gaze', { x: v, y: 0 }, d.t, { label: '拖动视线', coalesce: `gaze.${d.castId}`, duration: 0 });
      } else {
        writeKey(scene.id, { kind: 'actor', castId: d.castId }, 'head', { mode: 'angle', yaw: v }, d.t, { label: '拖动头部朝向', coalesce: `head.${d.castId}`, duration: 0 });
      }
    } else if (d.kind === 'gaze') {
      writeKey(scene.id, { kind: 'actor', castId: d.castId }, 'gaze', { x: r2(clamp((pt.x - d.c.x) / d.w, -1, 1)), y: r2(clamp(-(pt.y - d.c.y) / d.h, -1, 1)) }, d.t, { label: '拖动视线', coalesce: `gaze.${d.castId}`, duration: 0 });
    } else if (d.kind === 'pan') {
      const fr = scene.background.framing;
      const c = clampCamera(bg, { x: d.pose.x - (pt.x - d.start.x) / d.s0, y: d.pose.y - (pt.y - d.start.y) / d.s0, zoom: d.pose.zoom, ...(d.pose.bgZoom !== undefined ? { bgZoom: d.pose.bgZoom } : {}), ...(d.pose.roll ? { roll: d.pose.roll } : {}) }, fr);
      setManualCamera(scene.id, d.beatId, c, '拖动镜头取景', 'pan');
    } else {
      useProject.getState().applyEdit((p) => {
        const f = p.scenes.find((s) => s.id === scene.id)?.background.framing;
        if (!f) return;
        f.offsetX = Math.round(d.ox - (pt.x - d.start.x) / d.s0);
        f.offsetY = Math.round(d.oy - (pt.y - d.start.y) / d.s0);
      }, '拖动背景取景', { coalesce: `bg.${scene.id}` });
    }
  };
  const onUp = () => {
    drag.current = null;
    seal();
  };

  const startBackground = (e: React.PointerEvent) => {
    if (!state || !scene || !player) return;
    const bg = player.stageBgGetter();
    if (!bg || player.isPlaying) return;
    const start = toStage(e);
    if (tool === 'camera') {
      if (!beatId) {
        notify('这是空镜头（建立镜头），没有可编辑的取景；请移到有台词的句子再用相机工具');
        return;
      }
      const base = cameraOfBeat(compiled, scene, scene.id, beatId);
      if (!base) return;
      if (e.altKey) {
        const fr = scene.background.framing;
        begin({ kind: 'bg', start, s0: (H / viewWorldHeight(bg)) * bgZoom(base.pose.zoom, fr, base.pose.bgZoom), ox: fr.offsetX, oy: fr.offsetY }, e);
      } else {
        begin({ kind: 'pan', start, s0: (H / viewWorldHeight(bg)) * base.pose.zoom, pose: base.pose, beatId }, e);
      }
    } else {
      useProject.getState().select({ castId: null });
    }
  };

  const sel = geo.find((g) => g.castId === selection.castId);
  const selState = state?.actors.find((a) => a.castId === selection.castId);
  const half = sel ? Math.max(70, sel.head.w * 0.9) : 70;
  const dialY = sel ? Math.max(18, sel.head.y - 26) : 0;
  const manual = beatId && scene ? cameraOfBeat(compiled, scene, scene.id, beatId)?.manual : false;
  const selComposed = !!selection.castId && isComposed(selection.castId);

  return (
    <>
      {overlays.ref && ref && <img className="ref-img" src={ref.url} alt="" style={{ opacity: ref.opacity, mixBlendMode: ref.diff ? 'difference' : 'normal' }} data-testid="ref-image" />}
      <svg ref={svg} className={`stage-overlay tool-${tool}`} viewBox={`0 0 ${W} ${H}`} data-testid="stage-overlay" onPointerDown={startBackground} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {overlays.safe && (
          <>
            <rect className="guide" x={W * 0.035} y={H * 0.035} width={W * 0.93} height={H * 0.93} />
            <rect className="guide dash" x={W * 0.05} y={H * 0.05} width={W * 0.9} height={H * 0.9} />
          </>
        )}
        {overlays.thirds && (
          <>
            {[1, 2].map((i) => <line key={`v${i}`} className="guide" x1={(W * i) / 3} y1={0} x2={(W * i) / 3} y2={H} />)}
            {[1, 2].map((i) => <line key={`h${i}`} className="guide" x1={0} y1={(H * i) / 3} x2={W} y2={(H * i) / 3} />)}
          </>
        )}
        {overlays.eyeLine && <rect className="eyeband" x={0} y={H * 0.36} width={W} height={H * 0.09} />}

        {tool === 'select' &&
          geo.map((g) => {
            // only the part of the body that is on screen can be grabbed
            const x0 = clamp(g.body.x, 0, W);
            const y0 = clamp(g.body.y, 0, H);
            const x1 = clamp(g.body.x + g.body.w, 0, W);
            const y1 = clamp(g.body.y + g.body.h, 0, H);
            return (
              <rect
                key={g.castId}
                className={`actor-hit${g.castId === selection.castId ? ' sel' : ''}`}
                data-testid={`actor-hit-${g.castId}`}
                x={x0}
                y={y0}
                width={Math.max(0, x1 - x0)}
                height={Math.max(0, y1 - y0)}
                onPointerDown={(e) => startActor(e, g.castId)}
              />
            );
          })}

        {tool === 'select' && sel && selState && (
          <g className="handles">
            <rect className="head-box" x={sel.head.x} y={sel.head.y} width={sel.head.w} height={sel.head.h} />
            <line className="dial-line" x1={sel.headCenter.x - half} y1={dialY} x2={sel.headCenter.x + half} y2={dialY} />
            <line className="dial-tick" x1={sel.headCenter.x} y1={dialY - 5} x2={sel.headCenter.x} y2={dialY + 5} />
            <circle
              className="knob yaw"
              data-testid="handle-yaw"
              cx={sel.headCenter.x + clamp(selState.desiredYaw, -1, 1) * half}
              cy={dialY}
              r={8}
              onPointerDown={(e) => begin({ kind: 'yaw', castId: sel.castId, cx: sel.headCenter.x, half, t: state!.t }, e)}
            >
              <title>拖动：头部朝向（Alt：视线）</title>
            </circle>
            <circle className="gaze-ring" cx={sel.headCenter.x} cy={sel.headCenter.y} r={Math.max(10, sel.head.w * 0.18)} />
            <circle
              className="knob gaze"
              data-testid="handle-gaze"
              cx={sel.headCenter.x + selState.gaze.x * sel.head.w * 0.18}
              cy={sel.headCenter.y - selState.gaze.y * sel.head.w * 0.18}
              r={5}
              onPointerDown={(e) => begin({ kind: 'gaze', castId: sel.castId, c: sel.headCenter, w: sel.head.w * 0.18, h: sel.head.w * 0.18, t: state!.t }, e)}
            >
              <title>拖动：视线方向</title>
            </circle>
          </g>
        )}
        {tool === 'camera' && <rect className="cam-frame" x={2} y={2} width={W - 4} height={H - 4} />}
      </svg>
      {tool === 'select' && (
        <div className="stage-hint" data-testid="stage-hint">
          {selComposed
            ? '拖动：画面位置 · Shift+拖动：站位（相机会跟随）'
            : '拖动：站位 · Shift+拖动：画面位置'}
        </div>
      )}
      {tool === 'camera' && (
        <div className="cam-hint" data-testid="cam-hint">
          相机工具：拖动平移 · 滚轮缩放 · Alt+拖动 背景取景
          {manual && beatId && scene && <button className="btn-s" onClick={() => clearManualCamera(scene.id, beatId)} data-testid="cam-auto">恢复自动镜头</button>}
          {!manual && <span className="dim"> · 当前为自动镜头，拖动后变为手动</span>}
        </div>
      )}
    </>
  );
}
