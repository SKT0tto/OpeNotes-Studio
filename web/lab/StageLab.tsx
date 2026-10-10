/**
 * Stage lab (/lab/stage): background + 1..4 actors placed by slot/depth, shot presets or manual camera, depth of
 * field, per-actor opacity, ground line overrides and a manual transition scrubber. It renders through the same
 * compile -> evaluate -> Stage path as the player, so what is verified here is what plays.
 */
import { useEffect, useRef, useState } from 'react';
import { Application } from 'pixi.js';
import type { CompactCatalog } from '@shared/schema/assets';
import { ProjectSchema, type Project } from '@shared/schema/project';
import { SHOT_TYPES, type ShotType } from '@shared/staging/framing';
import { compileProject } from '@shared/timeline/compile';
import { evaluate } from '@shared/timeline/evaluate';
import type { CompiledProject, RenderState } from '@shared/timeline/types';
import { saveBackgroundGround, type Health } from '../api';
import { ModelLibrary } from '../engine/ModelLibrary';
import { STAGE_H, Stage, stageSceneOf } from '../engine/Stage';
import { registerDebugApp, registerDebugCamera } from '../engine/debugHooks';
import { ensureRuntime } from '../engine/runtime';
import type { TransitionKind } from '../engine/Transitions';

interface LabActor {
  id: string;
  modelId: string;
  slot: number;
  depth: number;
  opacity: number;
}

const DEFAULT_ACTORS: LabActor[] = [
  { id: 'a1', modelId: '001_casual_spring_01', slot: -0.32, depth: 0.08, opacity: 1 },
  { id: 'a2', modelId: '002_casual_spring_01', slot: 0.32, depth: 0.16, opacity: 1 },
];
const BG_A = 'adv_bkg_stage_000153';
const BG_B = 'adv_bkg_stage_000001';
const TRANSITIONS: TransitionKind[] = ['crossfade', 'fade_black', 'fade_white', 'wipe'];

function buildProject(bg: string, actors: LabActor[], shot: ShotType, dof: number, focus: string[]): Project {
  return ProjectSchema.parse({
    schemaVersion: 1, id: 'lab', title: 'lab', createdAt: 0, updatedAt: 0,
    settings: { aspect: '16:9', fps: 30, textSpeedCps: 14, defaultLineGap: 0 },
    source: { text: '', format: 'script' },
    cast: actors.map((a) => ({ id: a.id, characterKey: a.modelId.split('_')[0]!, displayName: a.id })),
    scenes: [{
      id: 'lab', title: 'lab', background: { assetId: bg },
      wardrobe: Object.fromEntries(actors.map((a) => [a.id, { modelId: a.modelId }])),
      blocking: Object.fromEntries(actors.map((a) => [a.id, { slot: a.slot, depth: a.depth }])),
      transitionIn: { kind: 'cut', duration: 0 },
      beats: [{ id: 'b', kind: 'pause', text: '', duration: { mode: 'fixed', seconds: 600 }, shot: { type: shot, focus, move: 'static', dof } }],
    }],
  });
}

export function StageLab({ health }: { health: Health }) {
  const host = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const [lib, setLib] = useState<ModelLibrary | null>(null);
  const [catalog, setCatalog] = useState<CompactCatalog | null>(null);
  const [status, setStatus] = useState('初始化…');
  const [error, setError] = useState<string | null>(null);

  const [bg, setBg] = useState(BG_A);
  const [actors, setActors] = useState<LabActor[]>(DEFAULT_ACTORS);
  const [shot, setShot] = useState<ShotType>('group');
  const [focusId, setFocusId] = useState('a1');
  const [dof, setDof] = useState(0);
  const [manual, setManual] = useState(false);
  const [cam, setCam] = useState({ x: 1024, y: 560, zoom: 1 });
  const [ground, setGround] = useState({ horizonY: 560, floorY: 1040 });
  const [newModel, setNewModel] = useState('003_casual_spring_01');
  const [kind, setKind] = useState<TransitionKind>('crossfade');
  const [progress, setProgress] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const sceneKey = useRef('');
  const gen = useRef(0);
  const compiledRef = useRef<CompiledProject | null>(null);

  useEffect(() => {
    let dead = false;
    let inited = false;
    const app = new Application();
    const el = host.current!;
    (async () => {
      await ensureRuntime(health.cubismCoreUrl);
      await app.init({ width: Math.round((STAGE_H * 16) / 9), height: STAGE_H, background: 0x000000, antialias: true, preserveDrawingBuffer: true });
      inited = true;
      if (dead) return;
      el.appendChild(app.canvas);
      registerDebugApp(app);
      const library = await ModelLibrary.create(health.cubismCoreUrl, app.ticker);
      setCatalog(await library.catalog());
      const stage = new Stage(app, library);
      stageRef.current = stage;
      registerDebugCamera(() => stage.camera.pose);
      setLib(library);
    })().catch((e: Error) => !dead && (setError(e.message), setStatus('失败')));
    return () => {
      dead = true;
      registerDebugApp(null);
      registerDebugCamera(null);
      stageRef.current?.destroy();
      stageRef.current = null;
      setLib(null);
      if (inited) app.destroy(true, { children: true });
    };
  }, [health.cubismCoreUrl]);

  // Re-render the stage whenever an input changes.
  useEffect(() => {
    const stage = stageRef.current;
    if (!lib || !stage) return;
    const my = ++gen.current;
    (async () => {
      setStatus('更新…');
      const focus = shot === 'establishing' || shot === 'group' ? actors.map((a) => a.id) : shot === 'two_shot' ? actors.slice(0, 2).map((a) => a.id) : [focusId];
      const project = buildProject(bg, actors, shot, dof, focus.filter((f) => actors.some((a) => a.id === f)));
      const ctx = await lib.compileContext(actors.map((a) => a.modelId), [bg]);
      if (my !== gen.current) return;
      const compiled = compileProject(project, ctx);
      compiledRef.current = compiled;
      const scene = compiled.scenes[0]!;
      const key = `${bg}|${actors.map((a) => `${a.id}:${a.modelId}`).join(',')}|${version}`;
      if (key !== sceneKey.current) {
        await stage.setScene(stageSceneOf(scene));
        if (my !== gen.current) return;
        sceneKey.current = key;
      }
      const base = evaluate(compiled, scene.contentStart + 10);
      const state: RenderState = {
        ...base,
        camera: manual ? cam : base.camera,
        actors: base.actors.map((a) => ({ ...a, opacity: actors.find((x) => x.id === a.castId)?.opacity ?? 1 })),
        transition: progress === null ? null : { kind, progress, seconds: progress, pause: 0, out: 1, hold: 0 },
      };
      stage.apply(state);
      await stage.whenSettled();
      setStatus('就绪');
    })().catch((e: Error) => my === gen.current && (setError(e.message), setStatus('失败')));
  }, [lib, bg, actors, shot, focusId, dof, manual, cam, progress, kind, version]);

  useEffect(() => {
    if (!lib) return;
    void lib.background(bg).then((b) => {
      void lib.ground(bg).then((g) => {
        const h = b.height ?? 1119;
        setGround(g ?? { horizonY: h * (b.setting === '室外' ? 0.46 : 0.5), floorY: h * 0.93 });
      });
    });
  }, [lib, bg]);

  const patch = (id: string, p: Partial<LabActor>) => setActors((as) => as.map((a) => (a.id === id ? { ...a, ...p } : a)));
  const slider = (label: string, v: number, min: number, max: number, step: number, set: (n: number) => void, testid: string) => (
    <label className="slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} data-testid={testid} />
      <output>{v.toFixed(2)}</output>
    </label>
  );
  const bgs = (catalog?.backgrounds ?? []).filter((b) => b.kind === 'scene');
  const models = (catalog?.models ?? []).filter((m) => m.quality !== 'low' && m.mode === 'adv' && !m.still);

  return (
    <div className="lab" data-testid="stage-lab">
      <div className="lab-stage">
        <div ref={host} className="lab-canvas-wide" data-testid="stage-canvas" />
        <p className="dim" data-testid="stage-status">{status}</p>
        {error && <p className="bad" data-testid="stage-error">{error}</p>}
      </div>
      <div className="lab-panel">
        <label>
          背景{' '}
          <select value={bg} onChange={(e) => setBg(e.target.value)} data-testid="stage-bg">
            {bgs.map((b) => <option key={b.id} value={b.id}>{b.id} {b.name}</option>)}
            {!bgs.some((b) => b.id === bg) && <option value={bg}>{bg}</option>}
          </select>
        </label>
        <h3>人物（{actors.length}）</h3>
        {actors.map((a) => (
          <div key={a.id} className="lab-actor" data-testid={`stage-actor-${a.id}`}>
            <b>{a.id}</b> {a.modelId}
            {slider('slot', a.slot, -1, 1, 0.01, (n) => patch(a.id, { slot: n }), `stage-slot-${a.id}`)}
            {slider('depth', a.depth, 0, 1, 0.01, (n) => patch(a.id, { depth: n }), `stage-depth-${a.id}`)}
            {slider('opacity', a.opacity, 0, 1, 0.01, (n) => patch(a.id, { opacity: n }), `stage-opacity-${a.id}`)}
            {actors.length > 1 && <button onClick={() => setActors((as) => as.filter((x) => x.id !== a.id))}>移除</button>}
          </div>
        ))}
        {actors.length < 4 && (
          <div className="row">
            <select value={newModel} onChange={(e) => setNewModel(e.target.value)} data-testid="stage-new-model">
              {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
            <button
              data-testid="stage-add"
              onClick={() => setActors((as) => [...as, { id: `a${Math.max(...as.map((x) => Number(x.id.slice(1)))) + 1}`, modelId: newModel, slot: 0, depth: 0.4, opacity: 1 }])}
            >
              添加
            </button>
          </div>
        )}

        <h3>镜头</h3>
        <div className="row">
          <label>
            构图{' '}
            <select value={shot} onChange={(e) => { setShot(e.target.value as ShotType); setManual(false); }} data-testid="stage-shot">
              {SHOT_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label>
            焦点{' '}
            <select value={focusId} onChange={(e) => setFocusId(e.target.value)} data-testid="stage-focus">
              {actors.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
            </select>
          </label>
        </div>
        {slider('景深 dof', dof, 0, 6, 1, setDof, 'stage-dof')}
        <label className="check">
          <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} data-testid="stage-manual" />
          手动相机
        </label>
        {manual && (
          <>
            {slider('zoom', cam.zoom, 1, 6, 0.05, (n) => setCam((c) => ({ ...c, zoom: n })), 'stage-cam-zoom')}
            {slider('x', cam.x, 0, 2048, 1, (n) => setCam((c) => ({ ...c, x: n })), 'stage-cam-x')}
            {slider('y', cam.y, 0, 1119, 1, (n) => setCam((c) => ({ ...c, y: n })), 'stage-cam-y')}
          </>
        )}

        <h3>地面线（世界像素，按背景保存）</h3>
        {slider('horizonY', ground.horizonY, 0, 1119, 1, (n) => setGround((g) => ({ ...g, horizonY: n })), 'stage-horizon')}
        {slider('floorY', ground.floorY, 0, 1119, 1, (n) => setGround((g) => ({ ...g, floorY: n })), 'stage-floor')}
        <button
          data-testid="stage-ground-save"
          onClick={() => void saveBackgroundGround(bg, ground).then(() => { lib?.invalidateGround(bg); setVersion((v) => v + 1); })}
        >
          保存并应用
        </button>

        <h3>转场</h3>
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as TransitionKind)} data-testid="stage-transition-kind">
            {TRANSITIONS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button
            data-testid="stage-transition-start"
            onClick={() => {
              stageRef.current?.captureSnapshot();
              setProgress(0);
              setBg((b) => (b === BG_A ? BG_B : BG_A));
            }}
          >
            截取当前画面并切换背景
          </button>
          <button data-testid="stage-transition-end" onClick={() => setProgress(null)}>结束转场</button>
        </div>
        {progress !== null && slider('进度', progress, 0, 1, 0.01, setProgress, 'stage-progress')}
        <p className="dim">所有人物的朝向由 P4 解算（默认互相面对），不使用镜像翻转。</p>
      </div>
    </div>
  );
}
