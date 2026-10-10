import { useCallback, useEffect, useRef, useState } from 'react';
import { Application, Graphics, Rectangle } from 'pixi.js';
import type { Calibration } from '@shared/schema/calibration';
import type { CompactCatalog, ModelEntry } from '@shared/schema/assets';
import { chooseMotionVariant, desiredYaw, nominalScreenYaw, residualOffset, variantsOfFamily } from '@shared/staging/facing';
import { fetchCalibration, fetchCatalog, fetchModel, saveCalibration, type Health } from '../api';
import { ensureRuntime } from '../engine/runtime';
import { Live2DActor, NEUTRAL_SIGNS } from '../engine/Live2DActor';
import { probeModel } from '../engine/ModelProbe';
import { registerDebugActor, registerDebugApp } from '../engine/debugHooks';
import { ZERO_INTENTS } from '../engine/ParamOverride';
import { AspectBox } from '../ui/AspectBox';

const STAGE_W = 560;
const STAGE_H = 760;
const READOUT = ['ParamAngleX', 'ParamBodyAngleX', 'ParamEyeBallX'] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2));

interface Demo {
  motion: string;
  angleX: number | null;
  /** Computed from the calibrated head sign and the motion's mean ParamAngleX. */
  facesRight: boolean;
  image: string;
}

/** Fit the full body into the stage, feet on a fixed line. Scale is always positive. */
function placeModel(actor: Live2DActor, overlay: Graphics, cal: Calibration): void {
  const s = (STAGE_H * 0.9) / cal.totalHeight;
  const x = STAGE_W / 2 - cal.ground.x * s;
  const y = STAGE_H * 0.96 - cal.ground.y * s;
  actor.model.scale.set(s);
  actor.model.position.set(x, y);
  overlay.scale.set(s);
  overlay.position.set(x, y);
  overlay.clear();
  const b = cal.head.bbox;
  overlay.rect(b.x, b.y, b.w, b.h).stroke({ width: 2 / s, color: 0xffe14a });
  overlay.moveTo(cal.ground.x - 80, cal.ground.y).lineTo(cal.ground.x + 80, cal.ground.y).stroke({ width: 2 / s, color: 0x4af0a0 });
}

export function ActorLab({ health }: { health: Health }) {
  const host = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const actorRef = useRef<Live2DActor | null>(null);
  const overlayRef = useRef<Graphics | null>(null);
  const [app, setApp] = useState<Application | null>(null);
  const [catalog, setCatalog] = useState<CompactCatalog | null>(null);
  const [modelId, setModelId] = useState(() => new URLSearchParams(location.search).get('model') ?? '001_casual_spring_01');
  const [entry, setEntry] = useState<ModelEntry | null>(null);
  const [cal, setCal] = useState<Calibration | null>(null);
  const [status, setStatus] = useState('初始化…');
  const [error, setError] = useState<string | null>(null);
  const [motion, setMotion] = useState('');
  const [expr, setExpr] = useState('');
  const [sliders, setSliders] = useState({ ...ZERO_INTENTS });
  const [readout, setReadout] = useState<Record<string, [number | null, number | null]>>({});
  const [showBox, setShowBox] = useState(true);
  const [demos, setDemos] = useState<Demo[]>([]);
  const [family, setFamily] = useState('idle01');
  const [want, setWant] = useState(0);
  const [chosen, setChosen] = useState('');

  useEffect(() => {
    fetchCatalog().then(setCatalog, (e: Error) => setError(e.message));
  }, []);

  // Pixi application, created once (after Cubism Core so the Live2D render pipe is registered).
  useEffect(() => {
    let dead = false;
    let inited = false;
    const a = new Application();
    const el = host.current;
    (async () => {
      await ensureRuntime(health.cubismCoreUrl);
      await a.init({ width: STAGE_W, height: STAGE_H, background: 0x20242d, antialias: true, preserveDrawingBuffer: true });
      inited = true;
      if (dead) return void a.destroy(true);
      el?.appendChild(a.canvas);
      const overlay = new Graphics();
      overlay.zIndex = 1000;
      a.stage.sortableChildren = true;
      a.stage.addChild(overlay);
      overlayRef.current = overlay;
      appRef.current = a;
      registerDebugApp(a);
      setApp(a);
    })().catch((e: Error) => !dead && (setError(e.message), setStatus('失败')));
    return () => {
      dead = true;
      registerDebugApp(null);
      appRef.current = null;
      setApp(null);
      if (inited && el?.contains(a.canvas)) a.destroy(true, { children: true });
    };
  }, [health.cubismCoreUrl]);

  // Load the selected model; probe + persist calibration on first sight.
  useEffect(() => {
    if (!app) return;
    let dead = false;
    let unreg: (() => void) | null = null;
    (async () => {
      setStatus(`加载 ${modelId}…`);
      setError(null);
      const rt = await ensureRuntime(health.cubismCoreUrl);
      const [me, saved] = await Promise.all([fetchModel(modelId), fetchCalibration(modelId)]);
      if (dead) return;
      const actor = await Live2DActor.load(rt, { id: modelId, modelUrl: me.url, signs: saved ?? NEUTRAL_SIGNS, ticker: app.ticker });
      if (dead) return void actor.destroy();
      app.stage.addChild(actor.model);
      await sleep(150); // let a frame run so the core has evaluated the pose
      const c = saved ?? probeModel(actor, modelId);
      if (!saved) await saveCalibration(c);
      actor.override.signs = c;
      placeModel(actor, overlayRef.current!, c);
      const idle = me.motions.find((m) => m.family === 'idle01' && m.side === 'C') ?? me.motions.find((m) => m.family.startsWith('idle'));
      if (idle) await actor.playIdle(idle.name);
      actorRef.current = actor;
      unreg = registerDebugActor(actor);
      setEntry(me);
      setCal(c);
      setMotion(idle?.name ?? '');
      setFamily(idle?.family ?? me.motions[0]?.family ?? '');
      setSliders({ ...ZERO_INTENTS });
      setStatus(`已加载 ${modelId}${saved ? '（已保存校准）' : '（已探测并保存校准）'}`);
    })().catch((e: Error) => !dead && (setError(e.message), setStatus('失败')));
    return () => {
      dead = true;
      unreg?.();
      actorRef.current?.destroy();
      actorRef.current = null;
      setEntry(null);
      setCal(null);
      setDemos([]);
      setChosen('');
    };
  }, [app, modelId, health.cubismCoreUrl]);

  useEffect(() => {
    const t = setInterval(() => {
      const a = actorRef.current;
      if (a) setReadout(Object.fromEntries(READOUT.map((id) => [id, [a.appliedValue(id), a.baseValue(id)]])));
    }, 100);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (overlayRef.current) overlayRef.current.visible = showBox;
  }, [showBox]);

  const setSlider = (k: keyof typeof sliders, v: number) => {
    setSliders((s) => ({ ...s, [k]: v }));
    actorRef.current?.override.setTarget({ [k]: v }, 0.15);
  };
  const zero = () => {
    setSliders({ ...ZERO_INTENTS });
    actorRef.current?.override.setTarget(ZERO_INTENTS, 0.4);
  };

  const play = (name: string) => {
    setMotion(name);
    void actorRef.current?.playMotion(name);
  };

  const updateCal = useCallback(
    async (patch: Partial<Calibration>) => {
      if (!cal) return;
      const next = await saveCalibration({ ...cal, ...patch });
      setCal(next);
      if (actorRef.current) actorRef.current.override.signs = next;
    },
    [cal],
  );

  const reprobe = async () => {
    const a = actorRef.current;
    if (!a) return;
    const next = await saveCalibration(probeModel(a, modelId));
    setCal(next);
    a.override.signs = next;
    placeModel(a, overlayRef.current!, next);
  };

  /** Play the _L and _R idle variants and capture each, to compare against the computed facing. */
  const demo = async () => {
    const a = actorRef.current;
    if (!a || !app || !cal || !entry) return;
    a.override.setTarget(ZERO_INTENTS, 0);
    setSliders({ ...ZERO_INTENTS });
    const out: Demo[] = [];
    for (const side of ['L', 'R'] as const) {
      const m = entry.motions.find((x) => x.family === 'idle01' && x.side === side) ?? entry.motions.find((x) => x.side === side);
      if (!m) continue;
      await a.playMotion(m.name, { loop: true });
      await sleep(1500);
      const ang = m.stats?.angleX?.mean ?? null;
      const canvas = app.renderer.extract.canvas({ target: app.stage, frame: new Rectangle(0, 0, STAGE_W, STAGE_H) }) as HTMLCanvasElement;
      out.push({ motion: m.name, angleX: ang, facesRight: nominalScreenYaw(ang, cal.headSign) > 0, image: canvas.toDataURL('image/png') });
    }
    setDemos(out);
    const centre = entry.motions.find((x) => x.family === 'idle01' && x.side === 'C') ?? entry.motions.find((x) => x.family.startsWith('idle'));
    if (centre) void a.playIdle(centre.name);
  };

  /** P4 pipeline: desired screen yaw -> closest variant of the family -> additive residual. */
  const applyFacing = async (fam: string, yaw: number) => {
    const a = actorRef.current;
    if (!a || !entry || !cal) return;
    const pick = chooseMotionVariant(variantsOfFamily(entry.motions, fam), yaw, cal.headSign);
    if (!pick) return;
    setChosen(`${pick.name}（自带 yaw ${pick.nominalYaw.toFixed(2)}）`);
    setMotion(pick.name);
    await a.playMotion(pick.name, { loop: true });
    const r = residualOffset({ desiredYaw: yaw, nominalYaw: pick.nominalYaw });
    setSliders((s) => ({ ...s, headYaw: r.headYaw, bodyYaw: r.bodyYaw }));
    a.override.setTarget({ headYaw: r.headYaw, bodyYaw: r.bodyYaw }, 0.4);
  };

  const families = entry ? [...new Set(entry.motions.map((m) => m.family))] : [];

  return (
    <div className="lab" data-testid="actor-lab">
      <div className="lab-stage">
        <AspectBox className="lab-canvas" frameClassName="lab-frame" frameTestId="stage-frame" aspect={STAGE_W / STAGE_H}>
          <div ref={host} style={{ width: '100%', height: '100%' }} data-testid="lab-canvas" />
        </AspectBox>
        <p className="dim" data-testid="lab-status">{status}</p>
        {error && <p className="bad" data-testid="lab-error">{error}</p>}
      </div>
      <div className="lab-panel">
        <label>
          模型{' '}
          <select value={modelId} onChange={(e) => setModelId(e.target.value)} data-testid="lab-model">
            {(catalog?.models ?? []).filter((m) => m.quality !== 'low' || m.id === modelId).map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
            {!catalog && <option value={modelId}>{modelId}</option>}
          </select>
        </label>
        <div className="row">
          <label>
            动作{' '}
            <select value={motion} onChange={(e) => play(e.target.value)} data-testid="lab-motion">
              {(entry?.motions ?? []).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          </label>
          <label>
            表情{' '}
            <select
              value={expr}
              onChange={(e) => { setExpr(e.target.value); void actorRef.current?.setExpression(e.target.value || null); }}
              data-testid="lab-expression"
            >
              <option value="">（无）</option>
              {(entry?.expressions ?? []).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
        </div>

        <h3>覆盖层（意图 -1..1，正 = 画面右 / 上）</h3>
        {(['headYaw', 'bodyYaw', 'gazeX', 'gazeY'] as const).map((k) => (
          <label key={k} className="slider">
            <span>{k}</span>
            <input type="range" min={-1} max={1} step={0.01} value={sliders[k]} onChange={(e) => setSlider(k, Number(e.target.value))} data-testid={`slider-${k}`} />
            <output>{sliders[k].toFixed(2)}</output>
          </label>
        ))}
        <button onClick={zero} data-testid="override-zero">全部归零</button>

        <table className="readout" data-testid="readout">
          <thead><tr><th>core 参数</th><th>实际值</th><th>motion 基值</th><th>差</th></tr></thead>
          <tbody>
            {READOUT.map((id) => {
              const [ap, ba] = readout[id] ?? [null, null];
              return (
                <tr key={id}>
                  <td>{id}</td>
                  <td data-testid={`ro-${id}`}>{fmt(ap)}</td>
                  <td>{fmt(ba)}</td>
                  <td>{ap !== null && ba !== null ? fmt(ap - ba) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3>朝向解算（P4）</h3>
        <div className="row">
          <select value={family} onChange={(e) => setFamily(e.target.value)} data-testid="facing-family">
            {families.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <label className="slider">
            <span>期望 yaw</span>
            <input type="range" min={-1} max={1} step={0.05} value={want} onChange={(e) => setWant(Number(e.target.value))} data-testid="facing-want" />
            <output>{want.toFixed(2)}</output>
          </label>
          <button onClick={() => void applyFacing(family, want)} data-testid="facing-apply">应用</button>
          <button
            onClick={() => {
              const yaw = desiredYaw({ x: 0, y: 0 }, { x: 600, y: 0 }, cal?.head.height ?? 200);
              setWant(yaw);
              void applyFacing(family, yaw);
            }}
          >
            面向右侧目标
          </button>
        </div>
        <p className="dim" data-testid="facing-chosen">{chosen}</p>

        <h3>校准</h3>
        {cal ? (
          <div data-testid="calibration">
            <p className="dim">
              总高 {cal.totalHeight.toFixed(0)}px，头高 {cal.head.height.toFixed(0)}px（{((cal.head.height / cal.totalHeight) * 100).toFixed(1)}%），
              接地点 ({cal.ground.x.toFixed(0)}, {cal.ground.y.toFixed(0)})，{cal.verified ? '已人工确认' : '未确认'}
            </p>
            <div className="row">
              {(['headSign', 'bodySign', 'eyeSign'] as const).map((k) => (
                <label key={k}>
                  {k}{' '}
                  <select value={cal[k]} onChange={(e) => void updateCal({ [k]: Number(e.target.value), verified: false })} data-testid={`cal-${k}`}>
                    <option value={1}>+1（正值→画面右）</option>
                    <option value={-1}>-1（正值→画面左）</option>
                    <option value={0}>0</option>
                  </select>
                </label>
              ))}
            </div>
            {!cal.hasEyeBallX && <p className="warn">无眼球轴（无 ParamEyeBallX）</p>}
            <div className="row">
              <label className="check"><input type="checkbox" checked={showBox} onChange={(e) => setShowBox(e.target.checked)} />头部框 / 接地线</label>
              <button onClick={() => void reprobe()} data-testid="cal-reprobe">重新探测</button>
              <button onClick={() => void demo()} data-testid="cal-demo">L / R 各演示</button>
              <button onClick={() => void updateCal({ verified: true })} data-testid="cal-verify">确认无误（verified）</button>
            </div>
          </div>
        ) : (
          <p className="dim">加载后显示。</p>
        )}
        {demos.length > 0 && (
          <div className="demos" data-testid="demos">
            {demos.map((d) => (
              <figure key={d.motion}>
                <img src={d.image} alt={d.motion} />
                <figcaption>
                  {d.motion}：ParamAngleX 均值 {fmt(d.angleX)} → 计算面向<b>{d.facesRight ? '画面右' : '画面左'}</b>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
