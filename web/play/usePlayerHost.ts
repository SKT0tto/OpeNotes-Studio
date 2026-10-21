/**
 * Owns the Pixi application, stage, dialogue box and Player for one project and keeps them in sync with edits:
 * the stage is built once per `initKey`; later changes of `project` go through `Player.reload` (debounced).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Application } from 'pixi.js';
import type { Project } from '@shared/schema/project';
import type { CompiledProject, RenderState } from '@shared/timeline/types';
import type { Health } from '../api';
import { AudioEngine } from '../engine/AudioEngine';
import { DialogBox } from '../engine/DialogBox';
import { HudLayer } from '../engine/HudLayer';
import { ModelLibrary } from '../engine/ModelLibrary';
import { Player } from '../engine/Player';
import { STAGE_H, STAGE_RES, Stage } from '../engine/Stage';
import { registerDebugApp, registerDebugBoxes, registerDebugCamera, registerDebugPlayer, registerDebugStage } from '../engine/debugHooks';
import { ensureRuntime } from '../engine/runtime';

export interface PlayInfo {
  t: number;
  duration: number;
  scene: string;
  sceneTitle: string;
  beat: string;
  sceneStarts: number[];
}
const EMPTY: PlayInfo = { t: 0, duration: 0, scene: '', sceneTitle: '', beat: '', sceneStarts: [] };

export function usePlayerHost(health: Health, project: Project | null, initKey: string, aspect = 16 / 9) {
  const host = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const projectRef = useRef(project);
  const latestProject = useRef(project);
  const reloading = useRef(false);
  const [status, setStatus] = useState('初始化…');
  const [error, setError] = useState<string | null>(null);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [info, setInfo] = useState<PlayInfo>(EMPTY);
  /** Automatic line advance (off = hold at the end of every text line); shared by the page controls and the in-stage HUD menu. */
  const [auto, setAutoState] = useState(true);
  const autoRef = useRef(true);
  const hudRef = useRef<HudLayer | null>(null);
  const setAuto = useCallback((on: boolean) => {
    autoRef.current = on;
    setAutoState(on);
    if (playerRef.current) playerRef.current.auto = on;
    hudRef.current?.setAuto(on);
  }, []);
  /** The latest compile result, for panels that show what the compiler made of an edit (held shots, rule director output). */
  const [compiled, setCompiled] = useState<CompiledProject | null>(null);
  const hasScenes = (project?.scenes.length ?? 0) > 0;
  useEffect(() => {
    projectRef.current = project;
  });

  useEffect(() => {
    const first = projectRef.current;
    if (!first || first.scenes.length === 0) return;
    let dead = false;
    let inited = false;
    let app: Application | null = null;
    let stage: Stage | null = null;
    let player: Player | null = null;
    let dialog: DialogBox | null = null;
    let hud: HudLayer | null = null;
    let hiddenSrc: RenderState['ui'] | null = null;
    let hiddenUi: RenderState['ui'] | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeSlow: (() => void) | null = null;
    let removeRestore: (() => void) | null = null;
    const audio = new AudioEngine();
    const el = host.current!;
    setError(null);
    setReloadError(null);
    (async () => {
      setStatus('加载 Cubism Core…');
      app = new Application();
      await ensureRuntime(health.cubismCoreUrl, health.cubismMemoryMB);
      await app.init({ width: Math.round(STAGE_H * aspect), height: STAGE_H, resolution: STAGE_RES, background: 0x000000, antialias: true, preserveDrawingBuffer: true });
      inited = true;
      if (dead) return;
      app.canvas.dataset.testid = 'play-canvas';
      el.insertBefore(app.canvas, el.firstChild);
      registerDebugApp(app);
      const library = await ModelLibrary.create(health.cubismCoreUrl, app.ticker, health.cubismMemoryMB);
      const catalog = await library.catalog();
      const colorOf = (castId: string | null) => {
        const cast = projectRef.current?.cast.find((c) => c.id === castId);
        if (!cast) return null;
        return { name: cast.displayName, color: catalog.characters.find((c) => c.key === cast.characterKey)?.color ?? '#8a93a6' };
      };
      dialog = new DialogBox(el, colorOf);
      stage = new Stage(app, library, aspect);
      const lines = () => {
        const p = playerRef.current;
        if (!p) return [];
        return p.compiled.scenes.flatMap((sc) => sc.beats).filter((b) => b.start <= p.t && b.text && (b.kind === 'dialogue' || b.kind === 'narration')).map((b) => ({ name: colorOf(b.speakerId)?.name ?? '', text: b.text }));
      };
      hud = new HudLayer(el, {
        toggleAuto: () => {
          setAuto(!autoRef.current);
          return autoRef.current;
        },
        skip: () => {
          const p = playerRef.current;
          const s = p?.state;
          if (p && s) void p.seek((p.compiled.scenes[s.sceneIndex + 1]?.start ?? p.duration) + 0.01);
        },
        log: lines,
      });
      const restoreUi = (e: MouseEvent) => {
        if (hud?.hidden) {
          hud.restore();
          e.stopPropagation();
        }
      };
      el.addEventListener('click', restoreUi, true);
      removeRestore = () => el.removeEventListener('click', restoreUi, true);
      setStatus('加载模型、校准并编译时间轴…');
      player = await Player.create(stage, library, audio, first);
      if (dead) return;
      player.auto = autoRef.current;
      hudRef.current = hud;
      hud.setAuto(autoRef.current);
      playerRef.current = player;
      registerDebugPlayer({
        seek: (t) => player!.seek(t),
        play: () => player!.play(),
        pause: () => player!.pause(),
        time: () => player!.t,
        duration: () => player!.duration,
        busy: () => player!.busy,
        state: () => player!.state,
        sceneStarts: () => player!.compiled.scenes.map((sc) => sc.start),
        project: () => player!.project,
        reload: (p) => player!.reload(p),
        beatStarts: () => Object.fromEntries(player!.compiled.scenes.flatMap((sc) => sc.beats.map((b) => [b.id, b.start]))),
      });
      registerDebugStage(() => stage!.probe());
      registerDebugBoxes(() => stage!.actorGeometry().map((g) => ({ castId: g.castId, modelId: stage!.actorFor(g.castId)?.id ?? null, head: g.head })));
      registerDebugCamera(() => ({ ...stage!.camera.pose, bgViewZoom: stage!.bgViewZoom }));
      unsubscribe = player.subscribe((s: RenderState) => {
        // identity-stable while the interface is hidden, so the layers do not re-layout every frame
        if (hud!.hidden && hiddenSrc !== s.ui) {
          hiddenSrc = s.ui;
          hiddenUi = { ...s.ui, hud: { ...s.ui.hud, hideUi: true } };
        }
        const ui = hud!.hidden ? hiddenUi! : s.ui;
        dialog!.update(s.subtitle, ui, false, s.fx.glow);
        hud!.update({ ...s, ui });
      });
      // React state follows the player on its slow clock (2 / s while playing, every frame while paused); the time readouts and the
      // timeline playhead are driven by the player's own events (see PlayClock), not by this state.
      unsubscribeSlow = player.subscribeSlow((s, p) => {
        const sc = p.compiled.scenes[s.sceneIndex]!;
        setPlaying(p.isPlaying);
        setInfo((prev) => {
          const beat = s.subtitle?.beatId ?? '';
          const same = prev.duration === p.duration && prev.scene === s.sceneId && prev.beat === beat && prev.sceneTitle === sc.title && prev.sceneStarts.length === p.compiled.scenes.length;
          return same && prev.t === s.t ? prev : { t: s.t, duration: p.duration, scene: s.sceneId, sceneTitle: sc.title, beat, sceneStarts: same ? prev.sceneStarts : p.compiled.scenes.map((x) => x.start) };
        });
      });
      for (const w of player.compiled.warnings) console.warn(w);
      setCompiled(player.compiled);
      setReady(true);
      setStatus('就绪');
    })().catch((e: Error) => {
      if (!dead) {
        setError(e.message);
        setStatus('失败');
      }
    });
    return () => {
      dead = true;
      registerDebugPlayer(null);
      registerDebugCamera(null);
      registerDebugStage(null);
      registerDebugBoxes(null);
      registerDebugApp(null);
      unsubscribe?.();
      unsubscribeSlow?.();
      player?.dispose();
      playerRef.current = null;
      hudRef.current = null;
      removeRestore?.();
      dialog?.dispose();
      hud?.dispose();
      audio.dispose();
      if (inited && app) {
        stage?.destroy();
        app.destroy(true, { children: true });
      }
      setReady(false);
      setPlaying(false);
      setInfo(EMPTY);
      setCompiled(null);
    };
  }, [health.cubismCoreUrl, health.cubismMemoryMB, initKey, hasScenes, aspect, setAuto]);

  // Edits: recompile the live player (debounced; a later edit supersedes an earlier one).
  useEffect(() => {
    const p = playerRef.current;
    if (!ready || !p || !project || project.scenes.length === 0 || project === p.project) return;
    latestProject.current = project;
    // No debounce: the next animation frame picks up the newest project (continuous drags are throttled to one
    // reload per frame, and at most one reload runs at a time), so a discrete edit shows up in well under 100 ms.
    const run = () => {
      if (reloading.current) return;
      const next = latestProject.current;
      if (!next || next === p.project) return;
      reloading.current = true;
      p.reload(next).then(
        () => {
          setReloadError(null);
          setCompiled(p.compiled);
        },
        (e: Error) => setReloadError(e.message),
      ).finally(() => {
        reloading.current = false;
        if (latestProject.current !== next) run();
      });
    };
    const raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [project, ready]);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying) {
      p.pause();
      setPlaying(false);
    } else {
      void p.play();
      setPlaying(true);
    }
  }, []);
  const seek = useCallback((t: number) => {
    setInfo((i) => ({ ...i, t }));
    void playerRef.current?.seek(t);
  }, []);
  const advance = useCallback(() => playerRef.current?.advance(), []);

  return { hostRef: host, playerRef, compiled, status, error, reloadError, ready, playing, info, auto, setAuto, toggle, seek, advance };
}
