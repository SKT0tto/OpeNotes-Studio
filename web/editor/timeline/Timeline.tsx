/**
 * Multi-track timeline for the selected scene. Lanes: lines, transition, shots + camera keys, location banner, effects,
 * audio, and per person motion / expression / head / body / gaze / position / opacity / costume. Keys are diamonds:
 * click selects (Shift adds, box-select on empty space), drag moves (re-anchors across lines, snaps to line edges /
 * playhead / other keys, Ctrl = no snap, Alt = copy), the handle after a key sets its transition time, double-click an
 * empty lane adds a key, double-click a rule-director ghost bakes it. Locked keys / tracks refuse and say so.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { storedBeatTimes, type Channel, type TrackTarget } from '@shared/project/mutate';
import type { CompactCatalog } from '@shared/schema/assets';
import type { Project } from '@shared/schema/project';
import type { usePlayerHost } from '../../play/usePlayerHost';
import { addKeyAt, bakeRuleKeys, editBeat, editScene, lockTrack, moveKeys, patchKey, positionAt, selectActor, setManualCamera } from '../../store/actions';
import { useProject } from '../../store/projectStore';
import { notify, useUi } from '../../store/uiStore';
import { cameraOfBeat } from '../stageTools/camera';
import { BEAT_KIND_LABEL, SHOT_LABEL, SHOT_SHORT, TRANSITION_LABEL } from '@shared/catalog/labels';
import { LockIcon } from '../ui';
import { loadModel } from '../useModel';
import { buildGroups, snapPoints, type Lane, type LaneKey } from './lanes';

type Host = ReturnType<typeof usePlayerHost>;
const HEAD_W = 172;
const PAD = 24;
const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const SNAP_PX = 7;

interface KeyDrag {
  /** Time of the key that was grabbed (a click without a drag moves the playhead there, locked or not). */
  at: number;
  ids: string[];
  orig: Map<string, number>;
  primary: string;
  x0: number;
  moved: boolean;
  blocked: boolean;
  copy: boolean;
  lastDt: number;
  snap: number[];
}
interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  shift: boolean;
}

export function Timeline({ project, host, catalog }: { project: Project; host: Host; catalog: CompactCatalog | null }) {
  const selection = useProject((s) => s.selection);
  const keySel = useUi((s) => s.keySel);
  const pps = useUi((s) => s.pps);
  const muted = useUi((s) => s.muted);
  const solo = useUi((s) => s.solo);
  const set = useUi((s) => s.set);
  const { compiled, info, seek, ready, playerRef } = host;

  const sceneIndex = Math.max(0, project.scenes.findIndex((s) => s.id === selection.sceneId));
  const scene = project.scenes[sceneIndex];
  const cScene = compiled?.scenes.find((s) => s.id === scene?.id);
  const groups = useMemo(() => (scene ? buildGroups(project, scene, sceneIndex, cScene, (id) => catalog?.audio.find((a) => a.id === id)?.name ?? '音频') : []), [project, scene, sceneIndex, cScene, catalog]);
  // Selecting a person (stage, inspector, outline) brings their track group into view.
  useEffect(() => {
    const id = selection.castId;
    if (!id) return;
    const raf = requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-testid="tl-group-actor:${id}"]`);
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [selection.castId]);
  const beatTimes = useMemo(() => (scene ? storedBeatTimes(project, sceneIndex) : []), [project, scene, sceneIndex]);
  const open = useUi((s) => s.openGroups);
  const setOpen = (o: Record<string, boolean>) => set({ openGroups: o });
  const [activeLane, setActiveLane] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const drag = useRef<KeyDrag | null>(null);
  const beatDrag = useRef<{ id: string; start: number } | null>(null);
  const leadEdge = useRef<{ kind: string } | null>(null);
  const bannerDrag = useRef<{ mode: 'delay' | 'hold'; start: number } | null>(null);
  const live = useRef({ project, scene, sceneIndex, info, pps, cScene, beatTimes, groups });
  useEffect(() => {
    live.current = { project, scene, sceneIndex, info, pps, cScene, beatTimes, groups };
  });

  const t0 = cScene?.start ?? 0;
  const t1 = cScene?.end ?? 1;
  const width = Math.max(200, (t1 - t0) * pps + PAD);
  const x = useCallback((t: number) => (t - t0) * pps, [t0, pps]);

  // The playhead is moved straight from the player's render events (smooth during playback) and after every render.
  const placeHead = useCallback(
    (t: number) => {
      const el = playhead.current;
      if (!el) return;
      el.style.transform = `translateX(${(t - t0) * pps}px)`;
      el.style.display = t >= t0 - 1e-6 && t <= t1 + 1e-6 ? 'block' : 'none';
      const sc = scroller.current;
      if (sc && playerRef.current?.isPlaying) {
        const px = HEAD_W + (t - t0) * pps;
        if (px > sc.scrollLeft + sc.clientWidth - 40 || px < sc.scrollLeft + HEAD_W) sc.scrollLeft = Math.max(0, px - HEAD_W - 60);
      }
    },
    [t0, t1, pps, playerRef],
  );
  useLayoutEffect(() => placeHead(info.t));
  useEffect(() => {
    const p = playerRef.current;
    if (!ready || !p) return;
    return p.subscribe((s) => placeHead(s.t));
  }, [ready, playerRef, placeHead]);

  // Ctrl + wheel zooms the time axis.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      set({ pps: Math.min(600, Math.max(12, live.current.pps * Math.exp(-e.deltaY * 0.0015))) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [set, scene?.id]);

  const castColor = (castId: string | undefined) => {
    const key = project.cast.find((c) => c.id === castId)?.characterKey;
    return catalog?.characters.find((c) => c.key === key)?.color ?? 'var(--text-3)';
  };
  const timeAt = (clientX: number) => {
    const r = content.current!.getBoundingClientRect();
    return t0 + (clientX - r.left - HEAD_W) / live.current.pps;
  };

  if (!scene || !cScene) {
    return (
      <div className="tl tl-empty" data-testid="timeline">
        <p className="hint">{project.scenes.length === 0 ? '没有场景，没有可编辑的时间轴。' : '预览加载完成后显示时间轴。'}</p>
      </div>
    );
  }

  const seekTo = (t: number) => seek(Math.min(host.info.duration, Math.max(t0, t)));

  // ---- keys ---------------------------------------------------------------------------------------------
  const allKeys = groups.flatMap((g) => g.lanes.flatMap((l) => l.keys.map((k) => ({ l, k }))));
  const keyDown = (e: React.PointerEvent, k: LaneKey) => {
    e.stopPropagation(); // a key never starts a box selection / seek on the lane under it
    if (k.ghost) return;
    const sel = useUi.getState().keySel;
    let next = sel;
    if (e.shiftKey) next = sel.includes(k.id) ? sel.filter((x) => x !== k.id) : [...sel, k.id];
    else if (!sel.includes(k.id)) next = [k.id];
    set({ keySel: next, inspectorTab: next.length > 0 ? 'key' : useUi.getState().inspectorTab });
    if (e.shiftKey) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const picked = allKeys.filter((x) => next.includes(x.k.id));
    const free = picked.filter((x) => !x.k.locked);
    const orig = new Map(free.map((x) => [x.k.id, x.k.at]));
    const others = allKeys.filter((x) => !next.includes(x.k.id)).map((x) => x.k.at);
    drag.current = {
      at: k.at, ids: [...orig.keys()], orig, primary: free.some((x) => x.k.id === k.id) ? k.id : (free[0]?.k.id ?? k.id), x0: e.clientX, moved: false, blocked: free.length === 0,
      copy: e.altKey, lastDt: 0, snap: snapPoints(project, sceneIndex, [live.current.info.t, ...others]),
    };
    if (free.length < picked.length && free.length > 0) notify(`${picked.length - free.length} 个锁定的关键帧不会移动`);
  };
  const keyMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 3) return;
    if (d.blocked) {
      if (!d.moved) notify('这个关键帧已锁定，先解锁再拖动');
      d.moved = true;
      return;
    }
    d.moved = true;
    let dt = dx / live.current.pps;
    if (!e.ctrlKey) {
      const want = d.orig.get(d.primary)! + dt;
      const near = d.snap.reduce<number | null>((best, s) => (Math.abs(s - want) * live.current.pps <= SNAP_PX && (best === null || Math.abs(s - want) < Math.abs(best - want)) ? s : best), null);
      if (near !== null) dt = near - d.orig.get(d.primary)!;
    }
    const mn = Math.min(...d.orig.values());
    const mx = Math.max(...d.orig.values());
    dt = Math.min(t1 - mx, Math.max(t0 - mn, dt));
    d.lastDt = dt;
    if (!d.copy) moveKeys(scene.id, d.ids.map((id) => ({ id, t: d.orig.get(id)! + dt })), false, 'kdrag');
  };
  const keyUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved && d.copy && !d.blocked) moveKeys(scene.id, d.ids.map((id) => ({ id, t: d.orig.get(id)! + d.lastDt })), true);
    useProject.getState().seal();
    if (!d.moved) seekTo(d.at);
  };

  const durDown = (e: React.PointerEvent, k: LaneKey) => {
    e.stopPropagation();
    if (k.locked) {
      notify('这个关键帧已锁定，先解锁再调整时长');
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const el = e.currentTarget as HTMLElement;
    el.dataset.drag = String(k.at);
  };
  const durMove = (e: React.PointerEvent, k: LaneKey) => {
    const el = e.currentTarget as HTMLElement;
    if (el.dataset.drag === undefined) return;
    const dur = Math.max(0, Math.round((timeAt(e.clientX) - k.at) / 0.05) * 0.05);
    patchKey(scene.id, k.id, { duration: Math.round(dur * 100) / 100 }, '调整关键帧时长', 'dur');
  };
  const durUp = (e: React.PointerEvent) => {
    delete (e.currentTarget as HTMLElement).dataset.drag;
    useProject.getState().seal();
  };

  // ---- lanes: click / box select / add --------------------------------------------------------------------
  const laneDown = (e: React.PointerEvent, lane: Lane) => {
    if (e.button !== 0) return;
    setActiveLane(lane.id);
    const r = content.current!.getBoundingClientRect();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setMarquee({ x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, shift: e.shiftKey });
  };
  const laneMove = (e: React.PointerEvent) => {
    if (!marquee) return;
    const r = content.current!.getBoundingClientRect();
    setMarquee({ ...marquee, x1: e.clientX - r.left, y1: e.clientY - r.top });
  };
  const laneUp = (e: React.PointerEvent) => {
    const m = marquee;
    setMarquee(null);
    if (!m) return;
    const moved = Math.abs(m.x1 - m.x0) > 4 || Math.abs(m.y1 - m.y0) > 4;
    if (!moved) {
      seekTo(timeAt(e.clientX));
      if (!m.shift) set({ keySel: [] });
      return;
    }
    const r = content.current!.getBoundingClientRect();
    const box = { l: r.left + Math.min(m.x0, m.x1), r: r.left + Math.max(m.x0, m.x1), t: r.top + Math.min(m.y0, m.y1), b: r.top + Math.max(m.y0, m.y1) };
    const hit: string[] = [];
    content.current!.querySelectorAll<HTMLElement>('[data-key-id]').forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.right >= box.l && b.left <= box.r && b.bottom >= box.t && b.top <= box.b && el.dataset.ghost !== '1') hit.push(el.dataset.keyId!);
    });
    set({ keySel: m.shift ? [...new Set([...useUi.getState().keySel, ...hit])] : hit, inspectorTab: hit.length > 0 ? 'key' : useUi.getState().inspectorTab });
  };

  const defaultValue = async (lane: Lane, t: number): Promise<{ value: unknown; duration: number } | null> => {
    const tr = lane.track;
    if (!tr) return null;
    const castId = tr.target.kind === 'actor' ? tr.target.castId : null;
    const actor = castId ? host.playerRef.current?.state?.actors.find((a) => a.castId === castId) : undefined;
    const modelId = actor?.modelId ?? (castId ? scene.wardrobe[castId]?.modelId : undefined);
    const model = modelId ? await loadModel(modelId) : null;
    switch (tr.channel) {
      case 'motion': {
        const fam = (model?.motions ?? []).filter((m) => !m.family.startsWith('idle')).map((m) => m.family);
        return fam.length > 0 ? { value: { name: fam.includes('nod01') ? 'nod01' : fam[0]! }, duration: 0 } : null;
      }
      case 'expression': {
        const cur = actor?.expression;
        const name = (model?.expressions ?? []).map((e) => e.name).find((n) => n !== cur) ?? null;
        return { value: { name }, duration: 0 };
      }
      case 'head': case 'body': return { value: { mode: 'target', target: 'camera' }, duration: 0.3 };
      case 'gaze': return { value: { target: 'camera' }, duration: 0.2 };
      case 'position': {
        const p = castId ? positionAt(project, scene.id, castId, t) : null;
        return { value: p ?? { slot: 0, depth: 0.3 }, duration: 0.5 };
      }
      case 'opacity': return { value: 1, duration: 0.3 };
      case 'costume': return modelId ? { value: { modelId }, duration: 0 } : null;
      case 'camera': {
        const b = cScene.beats.find((x) => t >= x.start && t < x.end);
        return { value: { shot: b?.shotType ?? 'mcu', focus: b?.focus ?? [] }, duration: 0.5 };
      }
      case 'bgm': case 'se': {
        const a = catalog?.audio[0];
        if (!a) {
          notify('素材库里没有可用的音频');
          return null;
        }
        return { value: tr.channel === 'bgm' ? { assetId: a.id, volume: 0.6 } : { assetId: a.id, volume: 0.8 }, duration: 0 };
      }
      case 'fade': return { value: { color: 'black', alpha: 1 }, duration: 0.5 };
      case 'fx': return { value: { fx: 'vignette_anxiety', strength: 1, roll: 0 }, duration: 0.3 };
    }
  };
  const addAt = async (lane: Lane, t: number) => {
    const tr = lane.track;
    if (!tr) return;
    const v = await defaultValue(lane, t);
    if (!v) return;
    const id = addKeyAt(scene.id, tr.target as TrackTarget, tr.channel as Channel, v.value, t, v.duration);
    if (id) set({ keySel: [id], inspectorTab: 'key' });
  };

  // ---- other lanes ---------------------------------------------------------------------------------------
  const storedIds = new Set(scene.beats.map((b) => b.id));
  const edgeMove = (e: React.PointerEvent) => {
    const d = beatDrag.current;
    if (!d) return;
    const len = Math.max(0.3, Math.round((timeAt(e.clientX) - d.start) / 0.05) * 0.05);
    editBeat(scene.id, d.id, '拖动句子时长', (b) => { b.duration.mode = 'fixed'; b.duration.seconds = Math.round(len * 100) / 100; }, 'bdur');
  };
  const edgeUp = () => {
    beatDrag.current = null;
    useProject.getState().seal();
  };
  const leadMove = (e: React.PointerEvent) => {
    if (!leadEdge.current) return;
    const lead = Math.max(0, Math.round((timeAt(e.clientX) - cScene.start) / 0.05) * 0.05);
    const k = scene.transitionIn.kind;
    if (k === 'dip_black') editScene(scene.id, '拖动转场时长', (s) => { s.style.overrides['transitions.dipHold'] = Math.max(0, Math.round((lead - (cScene.timing.out)) * 100) / 100); }, 'lead');
    else if (k === 'scene_black') editScene(scene.id, '拖动转场时长', (s) => { s.style.overrides['transitions.sceneHold'] = Math.max(0, Math.round((lead - cScene.timing.pause - cScene.timing.out) * 100) / 100); }, 'lead');
    else if (k !== 'cut') editScene(scene.id, '拖动转场时长', (s) => { s.transitionIn.duration = Math.round(lead * 100) / 100; }, 'lead');
  };
  const leadUp = () => {
    leadEdge.current = null;
    useProject.getState().seal();
  };
  const bannerMove = (e: React.PointerEvent) => {
    const d = bannerDrag.current;
    if (!d || !cScene.location) return;
    const t = timeAt(e.clientX);
    const lc = cScene.ui.location;
    if (d.mode === 'delay') {
      const base = cScene.contentStart + cScene.timing.fadeIn;
      editScene(scene.id, '拖动地点条出现时间', (s) => { s.style.overrides['location.delay'] = Math.max(0, Math.round((t - base) * 20) / 20); }, 'bdelay');
    } else {
      editScene(scene.id, '拖动地点条停留', (s) => { s.style.overrides['location.hold'] = Math.max(0, Math.round((t - cScene.location!.start - lc.slideIn) * 10) / 10); }, 'bhold');
    }
  };
  const bannerUp = () => {
    bannerDrag.current = null;
    useProject.getState().seal();
  };

  const toggleMute = (id: string) => set({ muted: muted.includes(id) ? muted.filter((m) => m !== id) : [...muted, id] });
  const toggleSolo = (id: string) => set({ solo: solo.includes(id) ? solo.filter((m) => m !== id) : [...solo, id] });
  const ticks: number[] = [];
  const step = pps >= 90 ? 0.5 : pps >= 40 ? 1 : pps >= 22 ? 2 : 5;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  const onSelectedLane = allKeys.find((x) => x.l.id === activeLane)?.l ?? groups.flatMap((g) => g.lanes).find((l) => l.id === activeLane);

  return (
    <div className="tl" data-testid="timeline">
      <div className="tl-bar">
        <span className="panel-title tl-title">时间轴</span>
        <span className="tl-scene" title="时间轴显示当前选中的场景">{sceneIndex + 1}. {scene.title}</span>
        <span className="dim mono">{fmt(t0)}–{fmt(t1)}</span>
        <span className="grow" />
        <button className="btn-s" disabled={!onSelectedLane?.track} onClick={() => onSelectedLane && void addAt(onSelectedLane, host.info.t)} data-testid="tl-add-key" title="在播放头位置给当前轨道添加关键帧（也可以双击轨道）">＋ 关键帧 @播放头</button>
        <button className="btn-s" onClick={() => set({ pps: Math.max(12, pps / 1.4) })} aria-label="缩小时间轴" data-testid="tl-zoom-out">－</button>
        <button className="btn-s" onClick={() => set({ pps: Math.min(600, pps * 1.4) })} aria-label="放大时间轴" data-testid="tl-zoom-in">＋</button>
        <button className="btn-s" onClick={() => set({ pps: Math.max(12, Math.min(600, ((scroller.current?.clientWidth ?? 800) - HEAD_W - PAD - 8) / Math.max(1, t1 - t0))) })} data-testid="tl-fit">适合场景</button>
        <span className="dim tl-hint">拖动关键帧移动 · Ctrl 关闭吸附 · Alt 复制 · 双击轨道添加 · Del 删除</span>
      </div>
      <div className="tl-scroll" ref={scroller}>
        <div className="tl-content" ref={content} style={{ width: HEAD_W + width }}>
          <div className="tl-row tl-ruler-row">
            <div className="tl-head tl-corner" />
            <div
              className="tl-lane tl-ruler"
              style={{ width }}
              data-testid="tl-ruler"
              onPointerDown={(e) => {
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
                seekTo(timeAt(e.clientX));
              }}
              onPointerMove={(e) => e.buttons === 1 && seekTo(timeAt(e.clientX))}
            >
              {ticks.map((t) => <span key={t} className="tl-tick" style={{ left: x(t) }}>{Number.isInteger(t) ? `${t}s` : ''}</span>)}
              {beatTimes.map((b, i) => <span key={b.beatId} className="tl-beat-tick" style={{ left: x(b.start) }}>{i + 1}</span>)}
            </div>
          </div>

          {groups.map((g) => {
            const isOpen = open[g.id] ?? (g.castId ? g.castId === groups.find((x) => x.castId)?.castId : true);
            return (
              <div key={g.id} className="tl-group" data-testid={`tl-group-${g.id}`}>
                <div className="tl-row tl-group-row">
                  <button className={`tl-head tl-group-head${g.castId && g.castId === selection.castId ? ' sel' : ''}`} onClick={() => { if (g.castId) selectActor(g.castId); setOpen({ ...useUi.getState().openGroups, [g.id]: !isOpen }); }} aria-expanded={isOpen}>
                    <span className="chev">{isOpen ? '▾' : '▸'}</span>
                    <span className="tl-swatch" style={{ background: g.castId ? castColor(g.castId) : g.color }} />
                    <span className="tl-name">{g.label}</span>
                  </button>
                  <div className="tl-lane tl-group-lane" style={{ width }}>
                    {!isOpen && g.lanes.flatMap((l) => l.keys).map((k) => <span key={k.id} className="tl-dot" style={{ left: x(k.at) }} />)}
                  </div>
                </div>
                {isOpen && g.lanes.map((lane) => (
                  <div key={lane.id} className={`tl-row${activeLane === lane.id ? ' active' : ''}`} data-testid={`tl-lane-${lane.id}`}>
                    <div className="tl-head">
                      <span className="tl-name" title={lane.label}>{lane.label}</span>
                      {lane.track?.trackId && (
                        <span className="tl-ctl">
                          <button className={`tl-btn${muted.includes(lane.track.trackId) ? ' on' : ''}`} title="静音（仅预览，不改项目）" aria-pressed={muted.includes(lane.track.trackId)} onClick={() => toggleMute(lane.track!.trackId!)} data-testid={`tl-mute-${lane.id}`}>M</button>
                          <button className={`tl-btn${solo.includes(lane.track.trackId) ? ' on' : ''}`} title="独奏（预览里只保留独奏的轨道）" aria-pressed={solo.includes(lane.track.trackId)} onClick={() => toggleSolo(lane.track!.trackId!)} data-testid={`tl-solo-${lane.id}`}>S</button>
                          <button className={`tl-btn${lane.track.locked ? ' on' : ''}`} title={lane.track.locked ? '轨道已锁定（点击解锁）' : '锁定整条轨道'} aria-pressed={lane.track.locked} onClick={() => lockTrack(scene.id, lane.track!.trackId!, !lane.track!.locked)} data-testid={`tl-lock-${lane.id}`}><LockIcon locked={lane.track.locked} size={12} /></button>
                        </span>
                      )}
                    </div>
                    <div
                      className={`tl-lane lane-${lane.kind}${lane.track?.locked ? ' locked' : ''}`}
                      style={{ width, ['--lane' as string]: lane.color }}
                      onPointerDown={(e) => laneDown(e, lane)}
                      onPointerMove={laneMove}
                      onPointerUp={laneUp}
                      onDoubleClick={(e) => lane.track && e.target === e.currentTarget && void addAt(lane, timeAt(e.clientX))}
                    >
                      {lane.kind === 'beats' && cScene.beats.map((b, i) => {
                        const stored = storedIds.has(b.id);
                        const who = project.cast.find((c) => c.id === b.speakerId)?.displayName;
                        return (
                          <div
                            key={b.id}
                            className={`tl-block${selection.beatId === b.id ? ' sel' : ''}${stored ? '' : ' auto'}`}
                            style={{ left: x(b.start), width: Math.max(2, (b.end - b.start) * pps - 1), borderColor: castColor(b.speakerId ?? undefined) }}
                            title={`${i + 1}. ${who ?? ''} ${b.text}  ${b.start.toFixed(2)}–${b.end.toFixed(2)}s`}
                            data-testid={`tl-beat-${b.id}`}
                            onPointerDown={(e) => { e.stopPropagation(); useProject.getState().select({ beatId: b.id }); set({ inspectorTab: 'beat' }); seekTo(b.start + 0.01); }}
                          >
                            <span className="tl-block-text">{who ? `${who}：` : ''}{b.text || (BEAT_KIND_LABEL[b.kind] ?? b.kind)}</span>
                            {stored && (
                              <span
                                className="tl-edge"
                                title="拖动调整这句的时长（改为固定时长）"
                                data-testid={`tl-beat-edge-${b.id}`}
                                onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); beatDrag.current = { id: b.id, start: b.start }; }}
                                onPointerMove={edgeMove}
                                onPointerUp={edgeUp}
                              />
                            )}
                          </div>
                        );
                      })}
                      {lane.kind === 'transition' && (
                        <>
                          <div
                            className={`tl-block trans${cScene.timing.lead === 0 ? ' cut' : ''}`}
                            style={{ left: 0, width: Math.max(scene.transitionIn.kind === 'cut' ? 36 : 18, (cScene.contentStart - cScene.start) * pps) }}
                            title={`转场：${TRANSITION_LABEL[scene.transitionIn.kind] ?? scene.transitionIn.kind}，前导 ${(cScene.contentStart - cScene.start).toFixed(2)}s（点击在检查器里编辑）`}
                            data-testid="tl-transition"
                            onPointerDown={(e) => { e.stopPropagation(); useProject.getState().select({ beatId: null }); set({ inspectorTab: 'scene' }); seekTo(cScene.start + 0.01); }}
                          >
                            <span className="tl-block-text">{(() => {
                              const k = scene.transitionIn.kind;
                              const lead = cScene.contentStart - cScene.start;
                              const full = k === 'cut' ? '硬切' : `${TRANSITION_LABEL[k] ?? k} ${lead.toFixed(1)}s`;
                              // a block narrower than its text shows a glyph (the full text is in the tooltip) instead of a clipped fragment
                              return k !== 'cut' && lead * pps < [...full].length * 11 + 14 ? '◐' : full;
                            })()}</span>
                            {scene.transitionIn.kind !== 'cut' && (
                              <span className="tl-edge" title="拖动调整转场时长" data-testid="tl-transition-edge" onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); leadEdge.current = { kind: scene.transitionIn.kind }; }} onPointerMove={leadMove} onPointerUp={leadUp} />
                            )}
                          </div>
                          {cScene.beats.map((b) => {
                            const sb = scene.beats.find((x) => x.id === b.id);
                            return sb?.cutIn === 'dip_black' ? (
                              <span key={b.id} className="tl-dip" style={{ left: x(b.start) }} title="黑场眨眼切入（在“句子”标签里调整）" onPointerDown={(e) => { e.stopPropagation(); useProject.getState().select({ beatId: b.id }); set({ inspectorTab: 'beat' }); seekTo(b.start + 0.01); }}>◆</span>
                            ) : null;
                          })}
                        </>
                      )}
                      {lane.kind === 'shots' && cScene.beats.map((b) => {
                        const stored = storedIds.has(b.id);
                        return (
                          <div
                            key={b.id}
                            className={`tl-block shot${selection.beatId === b.id ? ' sel' : ''}${b.shotHeld ? ' held' : ''}`}
                            style={{ left: x(b.start), width: Math.max(2, (b.end - b.start) * pps - 1) }}
                            title={`${SHOT_LABEL[b.shotType] ?? b.shotType} · 景深 ${b.dof}${b.shotHeld ? ' · 沿用上一机位' : ''}${stored ? '（双击：烘焙为手动镜头）' : ''}`}
                            data-testid={`tl-shot-${b.id}`}
                            onPointerDown={(e) => { e.stopPropagation(); useProject.getState().select({ beatId: b.id }); set({ inspectorTab: 'shot' }); seekTo(b.start + 0.01); }}
                            onDoubleClick={() => {
                              const cam = stored ? cameraOfBeat(compiled, scene, scene.id, b.id) : null;
                              if (cam && !cam.manual) setManualCamera(scene.id, b.id, cam.pose, '烘焙镜头为手动');
                            }}
                          >
                            <span className="tl-block-text">{b.shotHeld ? '⏸ ' : ''}{SHOT_SHORT[b.shotType] ?? b.shotType} · 景深 {b.dof}</span>
                          </div>
                        );
                      })}
                      {lane.kind === 'banner' && cScene.location && (
                        <div
                          className="tl-block banner"
                          style={{ left: x(cScene.location.start), width: Math.max(8, (cScene.ui.location.slideIn + cScene.ui.location.hold + cScene.ui.location.slideOut) * pps) }}
                          title="地点标题条：拖动改出现时间，右边缘改停留"
                          data-testid="tl-banner"
                          onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); bannerDrag.current = { mode: 'delay', start: cScene.location!.start }; }}
                          onPointerMove={bannerMove}
                          onPointerUp={bannerUp}
                        >
                          <span className="tl-block-text">{cScene.location.text}</span>
                          <span className="tl-edge" data-testid="tl-banner-edge" onPointerDown={(e) => { e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); bannerDrag.current = { mode: 'hold', start: cScene.location!.start }; }} onPointerMove={bannerMove} onPointerUp={bannerUp} />
                        </div>
                      )}
                      {lane.kind === 'banner' && !cScene.location && <span className="tl-empty-note">本场景没有地点标题条（在“场景”标签里开启）</span>}

                      {lane.keys.map((k) => {
                        const selected = keySel.includes(k.id);
                        const fxKey = lane.track?.channel === 'fx';
                        return (
                          <div key={k.id} className="tl-keywrap" style={{ left: x(k.at) }}>
                            {k.duration > 0 && <span className={`tl-span${fxKey ? ' fx' : ''}`} style={{ width: k.duration * pps }} />}
                            <span
                              className={`tl-key${selected ? ' sel' : ''}${k.locked ? ' locked' : ''}${k.ghost ? ' ghost' : ''}`}
                              data-key-id={k.id}
                              data-ghost={k.ghost ? '1' : '0'}
                              data-testid={`tl-key-${k.id}`}
                              title={k.title}
                              onPointerDown={(e) => keyDown(e, k)}
                              onPointerMove={keyMove}
                              onPointerUp={keyUp}
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                if (k.ghost) bakeRuleKeys(scene.id, k.ghost.castId, k.ghost.keys);
                              }}
                            >
                              {k.locked && <span className="tl-lockmark"><LockIcon locked size={10} /></span>}
                            </span>
                            <span className="tl-key-label">{k.label}</span>
                            {!k.ghost && (
                              <span className="tl-dur" title="拖动调整过渡时长" data-testid={`tl-dur-${k.id}`} style={{ left: Math.max(k.duration * pps, 11) }} onPointerDown={(e) => durDown(e, k)} onPointerMove={(e) => durMove(e, k)} onPointerUp={durUp} />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}

          <div className="tl-playhead" ref={playhead} style={{ left: HEAD_W }} data-testid="tl-playhead"><span className="tl-playhead-cap" /></div>
          {marquee && <div className="tl-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
        </div>
      </div>
    </div>
  );
}

