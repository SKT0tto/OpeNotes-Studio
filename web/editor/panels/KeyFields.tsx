/** The selected timeline key(s): value, time, transition time, easing curve, lock, delete. */
import { absTime, locateKey, storedBeatTimes } from '@shared/project/mutate';
import { SHOT_LABEL, costumeLabelZh, expressionLabel, motionLabel } from '@shared/catalog/labels';
import type { CompactCatalog } from '@shared/schema/assets';
import { cameraSystemOf, type Project, type Scene } from '@shared/schema/project';
import { shotTypeChoices } from '@shared/staging/framing';
import { EASE_NAMES, ease, type EaseName } from '@shared/timeline/easing';
import { FX_KINDS } from '@shared/schema/project';
import { useState } from 'react';
import { deleteKeys, lockKey, moveKeys, patchKey } from '../../store/actions';
import { useSceneFit } from '../bg/bgFit';
import { BgPicker } from '../bg/BgPicker';
import { useProject } from '../../store/projectStore';
import { useUi } from '../../store/uiStore';
import { NumField, Row, SliderField } from '../ui';
import { CHANNEL_LABEL } from '../timeline/lanes';
import { useModelEntry } from '../useModel';

const EASE_LABEL: Record<EaseName, string> = { linear: '线性', inQuad: '缓入', outQuad: '缓出', inOutQuad: '缓入缓出', inOutSine: '正弦缓入缓出', outCubic: '三次缓出', outSine: '正弦缓出', outQuint: '五次缓出' };
const FX_LABEL: Record<string, string> = { vignette_anxiety: '不安暗角', memory_glow: '回忆泛光', dutch: '荷兰角倾斜' };

function Curve({ name }: { name: EaseName }) {
  const pts = Array.from({ length: 33 }, (_, i) => `${(i / 32) * 100},${(1 - ease(name, i / 32)) * 36 + 2}`).join(' ');
  return (
    <svg className="curve" viewBox="0 0 100 40" preserveAspectRatio="none" aria-label={`缓动曲线 ${EASE_LABEL[name]}`} data-testid="key-curve">
      <line x1="0" y1="38" x2="100" y2="2" className="curve-diag" />
      <polyline points={pts} className="curve-line" />
    </svg>
  );
}

export function KeyFields({ project, scene, catalog }: { project: Project; scene: Scene; catalog: CompactCatalog | null }) {
  const keySel = useUi((s) => s.keySel);
  const found = keySel.map((id) => locateKey(scene, id)).filter((x): x is NonNullable<typeof x> => !!x);
  const seal = useProject.getState().seal;
  const first = found[0];
  const castId = first && first.track.target.kind === 'actor' ? first.track.target.castId : null;
  const model = useModelEntry(castId ? scene.wardrobe[castId]?.modelId : null);
  if (!first) {
    return (
      <div className="empty-state" data-testid="key-empty">
        <p className="empty-title">没有选中的关键帧</p>
        <p className="hint">在时间轴上点击一个关键帧（Shift 多选，或在空白处框选）后，这里编辑它的值、时间、过渡时长和缓动。</p>
      </div>
    );
  }
  const beats = storedBeatTimes(project, project.scenes.findIndex((s) => s.id === scene.id));
  if (found.length > 1) {
    return (
      <div data-testid="key-multi">
        <div className="subhead">已选 {found.length} 个关键帧</div>
        <Row label="缓动">
          <select value="" data-testid="key-multi-ease" onChange={(e) => e.target.value && found.forEach((f) => patchKey(scene.id, f.key.id, { ease: e.target.value as EaseName }, '修改缓动'))}>
            <option value="">（统一设置…）</option>
            {EASE_NAMES.map((n) => <option key={n} value={n}>{EASE_LABEL[n]}</option>)}
          </select>
        </Row>
        <Row label="操作">
          <button className="btn-s danger" data-testid="key-delete" onClick={() => deleteKeys(scene.id, keySel)}>删除所选</button>
          <button className="btn-s" onClick={() => found.forEach((f) => lockKey(scene.id, f.key.id, true))}>全部锁定</button>
        </Row>
      </div>
    );
  }
  const { track, key } = first;
  const channel = track.channel;
  const at = absTime(beats, key.at) ?? 0;
  const set = (value: unknown, label: string, coalesce = 'value') => patchKey(scene.id, key.id, { value }, label, coalesce);
  const v = key.value as Record<string, unknown>;
  const others = Object.keys(scene.wardrobe).filter((id) => id !== castId);
  const name = (id: string) => project.cast.find((c) => c.id === id)?.displayName ?? id;
  const families = [...new Set((model?.motions ?? []).filter((m) => !m.family.startsWith('idle')).map((m) => m.family))];
  const costumes = catalog && castId ? catalog.models.filter((m) => m.characterKey === project.cast.find((c) => c.id === castId)?.characterKey && m.quality !== 'low') : [];

  const turn = (val: Record<string, unknown>) => {
    const sel = val.mode === 'angle' ? 'angle' : String(val.target);
    return (
      <>
        <Row label="朝向">
          <select value={sel} data-testid="key-turn" onChange={(e) => set(e.target.value === 'angle' ? { mode: 'angle', yaw: 0 } : { mode: 'target', target: e.target.value }, '修改朝向')}>
            <option value="camera">看向镜头</option><option value="away">背向对方</option>
            {others.map((id) => <option key={id} value={id}>看向 {name(id)}</option>)}
            <option value="angle">指定角度</option>
          </select>
        </Row>
        {val.mode === 'angle' && <Row label="角度"><SliderField value={Number(val.yaw)} min={-1} max={1} step={0.01} testid="key-yaw" onChange={(n) => set({ mode: 'angle', yaw: n }, '修改角度', 'yaw')} onCommit={seal} /></Row>}
      </>
    );
  };

  return (
    <div data-testid="key-fields">
      <div className="subhead">{castId ? `${name(castId)} · ` : ''}{CHANNEL_LABEL[channel]}</div>
      <Row label="时间" meta={key.meta} onLock={(l) => lockKey(scene.id, key.id, l)}>
        <NumField value={at} step={0.05} digits={2} unit="s" testid="key-time" onChange={(n) => moveKeys(scene.id, [{ id: key.id, t: Math.max(0, n) }], false, 'ktime')} onCommit={seal} />
      </Row>
      <Row label="锚定"><span className="ro mono">{key.at.beatId} + {key.at.offset.toFixed(2)}s</span></Row>
      <Row label="过渡时长"><NumField value={key.duration} min={0} max={30} step={0.05} unit="s" testid="key-duration" onChange={(n) => patchKey(scene.id, key.id, { duration: n }, '修改过渡时长', 'dur')} onCommit={seal} /></Row>
      <Row label="缓动">
        <select value={key.ease} data-testid="key-ease" onChange={(e) => patchKey(scene.id, key.id, { ease: e.target.value as EaseName }, '修改缓动')}>
          {EASE_NAMES.map((n) => <option key={n} value={n}>{EASE_LABEL[n]}</option>)}
        </select>
      </Row>
      <Row label=""><Curve name={key.ease} /></Row>

      {channel === 'motion' && (
        <Row label="动作">
          <select value={String(v.name)} data-testid="key-motion" onChange={(e) => set({ name: e.target.value }, '修改动作')}>
            {!families.includes(String(v.name)) && <option value={String(v.name)}>{motionLabel(String(v.name))}</option>}
            {families.map((f) => <option key={f} value={f} title={f}>{motionLabel(f)}</option>)}
          </select>
        </Row>
      )}
      {channel === 'expression' && (
        <Row label="表情">
          <select value={(v.name as string | null) ?? ''} data-testid="key-expression" onChange={(e) => set({ name: e.target.value || null }, '修改表情')}>
            <option value="">（无表情）</option>
            {(model?.expressions ?? []).map((x) => <option key={x.name} value={x.name} title={x.name}>{expressionLabel(x.name)}</option>)}
          </select>
        </Row>
      )}
      {(channel === 'head' || channel === 'body') && turn(key.value as Record<string, unknown>)}
      {channel === 'gaze' && (
        <>
          <Row label="视线">
            <select value={'target' in v ? String(v.target) : 'xy'} data-testid="key-gaze" onChange={(e) => set(e.target.value === 'xy' ? { x: 0, y: 0 } : { target: e.target.value }, '修改视线')}>
              <option value="camera">看镜头</option><option value="down">向下</option><option value="away">看别处</option>
              {others.map((id) => <option key={id} value={id}>看 {name(id)}</option>)}
              <option value="xy">自定义方向</option>
            </select>
          </Row>
          {'x' in v && (
            <>
              <Row label="X"><SliderField value={Number(v.x)} min={-1} max={1} step={0.01} onChange={(n) => set({ x: n, y: Number(v.y) }, '修改视线', 'gx')} onCommit={seal} /></Row>
              <Row label="Y"><SliderField value={Number(v.y)} min={-1} max={1} step={0.01} onChange={(n) => set({ x: Number(v.x), y: n }, '修改视线', 'gy')} onCommit={seal} /></Row>
            </>
          )}
        </>
      )}
      {channel === 'position' && (
        <>
          <Row label="横向"><SliderField value={Number(v.slot)} min={-1} max={1} step={0.01} testid="key-slot" onChange={(n) => set({ slot: n, depth: Number(v.depth) }, '修改位置', 'slot')} onCommit={seal} /></Row>
          <Row label="纵深"><SliderField value={Number(v.depth)} min={0} max={1} step={0.01} testid="key-depth" onChange={(n) => set({ slot: Number(v.slot), depth: n }, '修改位置', 'depth')} onCommit={seal} /></Row>
        </>
      )}
      {channel === 'opacity' && <Row label="不透明度"><SliderField value={Number(key.value)} min={0} max={1} step={0.01} testid="key-opacity" onChange={(n) => set(n, '修改不透明度', 'op')} onCommit={seal} /></Row>}
      {channel === 'costume' && (
        <Row label="服装">
          <select value={String(v.modelId)} data-testid="key-costume" onChange={(e) => set({ modelId: e.target.value }, '修改服装')}>
            {!costumes.some((m) => m.id === v.modelId) && <option value={String(v.modelId)}>{String(v.modelId)}</option>}
            {costumes.map((m) => <option key={m.id} value={m.id} title={m.id}>{costumeLabelZh(m.costumeInfo, m.costume)}</option>)}
          </select>
        </Row>
      )}
      {channel === 'camera' && <CameraKey value={key.value as never} set={set} seal={seal} scene={scene} project={project} />}
      {(channel === 'bgm' || channel === 'se') && (
        <>
          <Row label="音频">
            <select value={String(v.assetId ?? '')} data-testid="key-audio" onChange={(e) => set({ ...v, assetId: e.target.value || null }, '修改音频')}>
              {channel === 'bgm' && <option value="">（停止 BGM）</option>}
              {catalog?.audio.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Row>
          <Row label="音量"><SliderField value={Number(v.volume)} min={0} max={1} step={0.01} onChange={(n) => set({ ...v, volume: n }, '修改音量', 'vol')} onCommit={seal} /></Row>
        </>
      )}
      {channel === 'fade' && (
        <>
          <Row label="颜色">
            <select value={String(v.color)} data-testid="key-fade-color" onChange={(e) => set({ ...v, color: e.target.value }, '修改黑白场颜色')}><option value="black">黑</option><option value="white">白</option></select>
          </Row>
          <Row label="浓度"><SliderField value={Number(v.alpha)} min={0} max={1} step={0.01} testid="key-fade-alpha" onChange={(n) => set({ ...v, alpha: n }, '修改黑白场浓度', 'alpha')} onCommit={seal} /></Row>
        </>
      )}
      {channel === 'fx' && (
        <>
          <Row label="特效">
            <select value={String(v.fx)} data-testid="key-fx" onChange={(e) => set({ ...v, fx: e.target.value }, '修改特效')}>
              {FX_KINDS.map((k) => <option key={k} value={k}>{FX_LABEL[k]}</option>)}
            </select>
          </Row>
          <Row label="强度"><SliderField value={Number(v.strength)} min={0} max={1} step={0.01} testid="key-fx-strength" onChange={(n) => set({ ...v, strength: n }, '修改特效强度', 'str')} onCommit={seal} /></Row>
          {v.fx === 'dutch' && <Row label="倾斜角"><SliderField value={Number(v.roll)} min={-30} max={30} step={0.5} unit="°" testid="key-fx-roll" onChange={(n) => set({ ...v, roll: n }, '修改倾斜角', 'roll')} onCommit={seal} /></Row>}
        </>
      )}
      {channel === 'background' && <BackgroundKey value={v} set={set} seal={seal} scene={scene} project={project} catalog={catalog} />}
      <Row label="操作">
        <button className="btn-s danger" data-testid="key-delete" onClick={() => deleteKeys(scene.id, [key.id])}>删除关键帧</button>
      </Row>
    </div>
  );
}

const BG_TRANSITIONS: Array<[string, string]> = [['cut', '硬切'], ['dip_black', '黑场（眨眼）'], ['crossfade', '叠化']];
const BG_PURPOSES: Array<[string, string]> = [['move', '换地点（人物保留）'], ['insert', '插入镜头（人物隐藏到下一次切换）'], ['time', '同地点换时段']];

/** Value of a background switch: which picture, how it changes (cut / dip to black / crossfade), what it is for. */
function BackgroundKey({ value, set, seal, scene, project, catalog }: { value: Record<string, unknown>; set: (v: unknown, l: string, c?: string) => unknown; seal: () => void; scene: Scene; project: Project; catalog: CompactCatalog | null }) {
  const [picker, setPicker] = useState(false);
  const fit = useSceneFit(project, scene, catalog);
  const cur = catalog?.backgrounds.find((b) => b.id === value.assetId);
  const transition = String(value.transition ?? 'cut');
  return (
    <>
      <Row label="背景">
        <button type="button" className="btn-s" data-testid="key-bg" onClick={() => setPicker(true)} title={String(value.assetId)}>{cur?.name ?? String(value.assetId)} · 更换…</button>
      </Row>
      <Row label="转场">
        <select value={transition} data-testid="key-bg-transition" onChange={(e) => set({ ...value, transition: e.target.value, transitionSeconds: e.target.value === 'cut' ? 0 : Number(value.transitionSeconds) || (e.target.value === 'dip_black' ? 0.8 : 1) }, '修改背景转场')}>
          {BG_TRANSITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Row>
      {transition !== 'cut' && <Row label="转场时长"><SliderField value={Number(value.transitionSeconds ?? 0.5)} min={0.1} max={3} step={0.05} unit="s" testid="key-bg-seconds" onChange={(n) => set({ ...value, transitionSeconds: n }, '修改背景转场时长', 'bgsec')} onCommit={seal} /></Row>}
      <Row label="用途">
        <select value={String(value.purpose ?? 'move')} data-testid="key-bg-purpose" onChange={(e) => set({ ...value, purpose: e.target.value }, '修改背景用途')}>
          {BG_PURPOSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Row>
      {picker && catalog && <BgPicker backgrounds={catalog.backgrounds} current={String(value.assetId)} title="更换这次切换的背景" fit={fit} use={value.purpose === 'insert' ? 'insert' : 'scene'} onPick={(id) => { setPicker(false); set({ ...value, assetId: id }, '更换背景'); }} onClose={() => setPicker(false)} />}
    </>
  );
}

function CameraKey({ value, set, seal, scene, project }: { value: { shot: string; focus: string[] } | { manual: { x: number; y: number; zoom: number; bgZoom?: number; roll?: number } }; set: (v: unknown, l: string, c?: string) => unknown; seal: () => void; scene: Scene; project: Project }) {
  if ('manual' in value) {
    const m = value.manual;
    return (
      <>
        <Row label="中心 X"><NumField value={m.x} step={5} digits={0} unit="px" onChange={(n) => set({ manual: { ...m, x: n } }, '修改镜头', 'cx')} onCommit={seal} /></Row>
        <Row label="中心 Y"><NumField value={m.y} step={5} digits={0} unit="px" onChange={(n) => set({ manual: { ...m, y: n } }, '修改镜头', 'cy')} onCommit={seal} /></Row>
        <Row label="缩放"><SliderField value={m.zoom} min={1} max={14} step={0.05} unit="×" onChange={(n) => set({ manual: { ...m, zoom: n } }, '修改镜头', 'cz')} onCommit={seal} /></Row>
        <Row label="背景放大"><SliderField value={m.bgZoom ?? Math.pow(m.zoom, 0.85)} min={1} max={6} step={0.05} unit="×" onChange={(n) => set({ manual: { ...m, bgZoom: n } }, '修改镜头', 'cbz')} onCommit={seal} /></Row>
        <Row label="倾斜"><SliderField value={m.roll ?? 0} min={-30} max={30} step={0.5} unit="°" onChange={(n) => set({ manual: { ...m, roll: n } }, '修改镜头', 'cr')} onCommit={seal} /></Row>
      </>
    );
  }
  return (
    <>
      <Row label="景别">
        <select value={value.shot} data-testid="key-cam-shot" onChange={(e) => set({ ...value, shot: e.target.value }, '修改镜头景别')}>
          {shotTypeChoices(cameraSystemOf(project, scene) === 'travel', value.shot).map((t) => <option key={t} value={t}>{SHOT_LABEL[t]}</option>)}
        </select>
      </Row>
      <Row label="焦点">
        <span className="chips">
          {Object.keys(scene.wardrobe).map((id) => (
            <label key={id} className="chip check"><input type="checkbox" checked={value.focus.includes(id)} onChange={(e) => set({ ...value, focus: e.target.checked ? [...value.focus, id] : value.focus.filter((x) => x !== id) }, '修改镜头焦点')} />{project.cast.find((c) => c.id === id)?.displayName ?? id}</label>
          ))}
        </span>
      </Row>
    </>
  );
}

