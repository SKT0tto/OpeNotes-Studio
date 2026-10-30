/** Right-hand inspector: every value of the selected project / scene / beat is a field you can edit by hand. */
import { useState } from 'react';
import type { Draft } from 'immer';
import { CAMERA_SYSTEM_LABEL, EMOTION_LABEL, costumeLabelZh, expressionLabel, motionLabel } from '@shared/catalog/labels';
import { multiIds } from '@shared/agent/selection';
import { bandText } from '@shared/director/bandFit';
import { bgSwitchValue } from '@shared/director/bgKeys';
import { bgCategoryOf } from '@shared/director/bgCategory';
import type { CompactCatalog } from '@shared/schema/assets';
import { resolveStyle } from '@shared/style/ournotes';
import { CAMERA_SYSTEMS, cameraSystemOf, type Beat, type Project, type Scene } from '@shared/schema/project';
import { EMOTION_TAGS } from '@shared/timeline/compile';
import type { CompiledProject, RenderState } from '@shared/timeline/types';
import { addCast, addKeyAt, selectActor, toggleActorInScene } from '../../store/actions';
import { defaultModelOf } from '../castModel';
import { touch, useProject } from '../../store/projectStore';
import { useUi, type InspectorTab } from '../../store/uiStore';
import { FieldLock, NumField, Row, Section, SliderField, setFieldLock } from '../ui';
import { ActorControls } from './ActorFields';
import { KeyFields } from './KeyFields';
import { ShotFields } from './ShotFields';
import { openTravelNoticeIfNeeded } from '../travelNotice';
import { BgBadges } from '../bg/BgCard';
import { useSceneFit } from '../bg/bgFit';
import { BgPicker } from '../bg/BgPicker';
import { BgThumb } from '../bg/BgThumb';
import { StyleSection } from './StyleFields';
import { cachedLineInfo, expandHint, lineIndicator } from '../longLines';
import { splitLongLines, useSplitRun } from '../longLinesRun';

const TRANSITIONS: Array<[Scene['transitionIn']['kind'], string]> = [
  ['cut', '硬切'], ['dip_black', '黑场眨眼'], ['scene_black', '换场黑场'], ['fade_black', '黑场（旧）'], ['fade_white', '白场（旧）'], ['crossfade', '交叉溶解（旧）'], ['wipe', '擦除（旧）'],
];
const BEAT_KINDS: Array<[Beat['kind'], string]> = [
  ['dialogue', '对白'], ['narration', '旁白'], ['action', '动作'], ['pause', '停顿'], ['establishing', '空镜（建立镜头）'], ['silent', '无声节拍'], ['empty', '空景（人物淡出）'],
];
const VARIANTS: Array<[Beat['variant'], string]> = [['normal', '普通'], ['monologue', '内心独白'], ['offscreen', '画外音']];

const TABS: Array<[InspectorTab, string]> = [['project', '项目'], ['scene', '场景'], ['beat', '句子'], ['actor', '角色'], ['shot', '镜头'], ['key', '关键帧'], ['style', '风格']];

export function Inspector({ catalog, compiled, state, t }: { catalog: CompactCatalog | null; compiled?: CompiledProject | null; state: RenderState | null; t: number }) {
  const project = useProject((s) => s.project);
  const selection = useProject((s) => s.selection);
  const tab = useUi((s) => s.inspectorTab);
  const keyCount = useUi((s) => s.keySel.length);
  const cards = useUi((s) => s.cards);
  if (!project) return null;
  const multiN = multiIds(project, cards).length;
  const scene = project.scenes.find((s) => s.id === selection.sceneId) ?? null;
  const beat = scene?.beats.find((b) => b.id === selection.beatId) ?? null;
  const castId = selection.castId && scene?.wardrobe[selection.castId] ? selection.castId : null;
  const need = (what: string) => <p className="hint" data-testid="insp-need">{what}</p>;
  return (
    <div className="inspector" data-testid="inspector">
      <nav className="insp-tabs" role="tablist" data-testid="insp-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => useUi.getState().set({ inspectorTab: k })} data-testid={`insp-tab-${k}`}>
            {label}{k === 'key' && keyCount > 0 ? <span className="badge">{keyCount}</span> : null}
          </button>
        ))}
      </nav>
      {multiN > 1 && <p className="hint insp-multi" data-testid="insp-multi">已选 {multiN} 句（下方显示最后点选的一句）</p>}
      {tab === 'project' && <ProjectFields project={project} catalog={catalog} />}
      {tab === 'scene' && (scene ? <SceneFields project={project} scene={scene} catalog={catalog} compiled={compiled ?? null} t={t} /> : need('选择一个场景后，这里显示它的转场、背景、站位与音乐。'))}
      {tab === 'beat' && (scene && beat ? <BeatFields project={project} scene={scene} beat={beat} compiled={compiled ?? null} /> : need('在左侧剧本里选择一句台词后，这里编辑它。'))}
      {tab === 'actor' && (scene ? <ActorTab project={project} scene={scene} castId={castId} catalog={catalog} state={state} t={t} /> : need('选择场景后可以编辑其中的角色。'))}
      {tab === 'shot' && (scene && beat ? <Section title="镜头" hint={beat.id} testid="insp-shot-section"><ShotFields project={project} scene={scene} beat={beat} compiled={compiled ?? null} /></Section> : need('选择一句台词后，这里编辑它的镜头。'))}
      {tab === 'key' && (scene ? <KeyFields project={project} scene={scene} catalog={catalog} /> : need('选择场景后，这里编辑时间轴上选中的关键帧。'))}
      {tab === 'style' && <StyleTab project={project} scene={scene} beat={beat} />}
    </div>
  );
}

function StyleTab({ project, scene, beat }: { project: Project; scene: Scene | null; beat: Beat | null }) {
  const unit = useUi((s) => s.styleUnit);
  return (
    <div data-testid="insp-style-tab">
      <div className="style-bar">
        <span className="dim">数值单位</span>
        <span className="seg" role="group" aria-label="风格数值单位">
          <button className={unit === 'H' ? 'on' : ''} aria-pressed={unit === 'H'} data-testid="style-unit-h" onClick={() => useUi.getState().set({ styleUnit: 'H' })} title="画面高度的小数（内部存储值）">H</button>
          <button className={unit === 'px' ? 'on' : ''} aria-pressed={unit === 'px'} data-testid="style-unit-px" onClick={() => useUi.getState().set({ styleUnit: 'px' })} title="按 1080 行换算的像素">px@1080</button>
        </span>
      </div>
      <StyleSection project={project} layer={{ kind: 'project' }} title="风格预设（全局）" />
      {scene && <StyleSection project={project} layer={{ kind: 'scene', sceneId: scene.id }} title="风格（本场景覆盖）" />}
      {scene && beat && <StyleSection project={project} layer={{ kind: 'beat', sceneId: scene.id, beatId: beat.id }} title="风格（本句覆盖）" />}
    </div>
  );
}

function ActorTab({ project, scene, castId, catalog, state, t }: { project: Project; scene: Scene; castId: string | null; catalog: CompactCatalog | null; state: RenderState | null; t: number }) {
  const ids = Object.keys(scene.wardrobe);
  if (ids.length === 0) return <p className="hint" data-testid="insp-need">这个场景里还没有角色。在“场景”标签的“角色站位与服装”里让角色入场。</p>;
  const cur = castId ?? ids[0]!;
  return (
    <div data-testid="insp-actor">
      <div className="actor-pick" role="group" aria-label="选择角色">
        {ids.map((id) => (
          <button key={id} className={`chip pick${id === cur ? ' on' : ''}`} onClick={() => selectActor(id, false)} data-testid={`pick-actor-${id}`}>{project.cast.find((c) => c.id === id)?.displayName ?? id}</button>
        ))}
      </div>
      <Section title="播放头处的表演" hint={`@ ${t.toFixed(2)}s`} testid="insp-actor-controls">
        <p className="hint">改动会在播放头位置写入关键帧（已有关键帧则更新），人工锁定后重新生成不会覆盖。</p>
        <ActorControls ctx={{ project, scene, castId: cur, t, state, catalog }} />
      </Section>
    </div>
  );
}

const useEdit = () => useProject.getState();

function ProjectFields({ project, catalog }: { project: Project; catalog: CompactCatalog | null }) {
  const [pick, setPick] = useState('');
  const { applyEdit, seal } = useEdit();
  return (
    <>
    <Section title="项目" testid="insp-project">
      <Row label="标题">
        <input className="text" value={project.title} data-testid="insp-project-title" onChange={(e) => applyEdit((d) => void (d.title = e.target.value), '修改项目标题', { coalesce: 'project.title' })} onBlur={seal} />
      </Row>
      <Row label="文字速度">
        <SliderField value={resolveStyle(project.style).values.rhythm.textSpeedCps} min={2} max={40} step={0.5} digits={1} unit="字/秒" testid="insp-cps" onChange={(v) => applyEdit((d) => { d.style.overrides['rhythm.textSpeedCps'] = v; touch(d.style.meta); }, '修改文字速度', { coalesce: 'style.rhythm.cps' })} onCommit={seal} />
      </Row>
      <Row label="帧率"><span className="ro">{project.settings.fps} fps · {project.settings.aspect}</span></Row>
      <Row label="镜头系统"><span className="ro" data-testid="insp-camera-system">{CAMERA_SYSTEM_LABEL[project.settings.cameraSystem ?? 'classic']}（在顶部工具栏切换）</span></Row>
      <p className="hint">经典 = 硬切为主；运镜 = 紧凑站位、说话人之间横移、双人/群像与单人之间的推拉；相邻的人之间运镜，近景换人硬切。</p>
    </Section>
    <Section title="角色" hint={`${project.cast.length} 人`} testid="insp-cast-list">
      {project.cast.length === 0 && <p className="hint" data-testid="cast-empty">还没有角色。从下拉里选择一个角色加入项目，再到场景里让 TA 入场。</p>}
      {project.cast.map((c) => (
        <Row key={c.id} label={c.id} meta={c.meta}>
          <input className="text" value={c.displayName} aria-label={`${c.id} 显示名`} data-testid={`cast-name-${c.id}`} onChange={(e) => applyEdit((d) => { const m = d.cast.find((x) => x.id === c.id); if (m) { m.displayName = e.target.value; touch(m.meta); } }, '修改角色名', { coalesce: `cast.${c.id}` })} onBlur={seal} />
        </Row>
      ))}
      <Row label="添加">
        <select value={pick} data-testid="cast-pick" onChange={(e) => setPick(e.target.value)}>
          <option value="">（选择角色…）</option>
          {catalog?.characters.filter((ch) => ch.modelIds.length > 0).map((ch) => <option key={ch.key} value={ch.key}>{ch.name}</option>)}
        </select>
        <button className="btn-s" disabled={!pick} data-testid="cast-add" onClick={() => { const ch = catalog?.characters.find((x) => x.key === pick); if (ch) { addCast(ch.key, ch.name); setPick(''); } }}>加入</button>
      </Row>
    </Section>
    </>
  );
}

function SceneFields({ project, scene, catalog, compiled, t }: { project: Project; scene: Scene; catalog: CompactCatalog | null; compiled: CompiledProject | null; t: number }) {
  const { applyEdit, seal } = useEdit();
  const up = (label: string, fn: (s: Draft<Scene>) => void, coalesce?: string) =>
    applyEdit((d) => {
      const s = d.scenes.find((x) => x.id === scene.id);
      if (s) fn(s);
    }, label, coalesce ? { coalesce: `${scene.id}.${coalesce}` } : {});
  const lock = (get: (s: Draft<Scene>) => { locked: boolean } | undefined) => (locked: boolean) => up(locked ? '锁定' : '解锁', (s) => void (get(s) && (get(s)!.locked = locked)));
  const castIds = Object.keys(scene.wardrobe);
  const name = (id: string) => project.cast.find((c) => c.id === id)?.displayName ?? id;
  const idx = project.scenes.indexOf(scene) + 1;

  return (
    <>
      <Section title={`场景 ${idx}`} hint={scene.id} testid="insp-scene">
        <Row label="标题" meta={scene.meta} onLock={lock((s) => s.meta)}>
          <input className="text" value={scene.title} data-testid="insp-scene-title" onChange={(e) => up('修改场景标题', (s) => { s.title = e.target.value; touch(s.meta); }, 'title')} onBlur={seal} />
        </Row>
        <Row label="转场" meta={scene.transitionIn.meta} onLock={lock((s) => s.transitionIn.meta)}>
          <select value={scene.transitionIn.kind} data-testid="insp-transition" onChange={(e) => up('修改转场', (s) => { s.transitionIn.kind = e.target.value as Scene['transitionIn']['kind']; touch(s.transitionIn.meta); })}>
            {TRANSITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Row>
        <Row label="镜头系统">
          <select value={scene.cameraSystem ?? 'inherit'} data-testid="insp-scene-camera-system" onChange={(e) => {
            const before = cameraSystemOf(project, scene);
            up('修改镜头系统', (s) => { if (e.target.value === 'inherit') delete s.cameraSystem; else s.cameraSystem = e.target.value as 'classic' | 'travel'; touch(s.meta); });
            if (before === 'classic') openTravelNoticeIfNeeded(scene.id);
          }}>
            <option value="inherit">{CAMERA_SYSTEM_LABEL.inherit}（当前：{CAMERA_SYSTEM_LABEL[project.settings.cameraSystem ?? 'classic']}）</option>
            {CAMERA_SYSTEMS.map((k) => <option key={k} value={k}>{CAMERA_SYSTEM_LABEL[k]}</option>)}
          </select>
        </Row>
        {!['dip_black', 'scene_black'].includes(scene.transitionIn.kind) && (
          <Row label="转场时长">
            <NumField value={scene.transitionIn.duration} min={0} max={10} step={0.05} unit="s" testid="insp-transition-dur" onChange={(v) => up('修改转场时长', (s) => { s.transitionIn.duration = v; touch(s.transitionIn.meta); }, 'tdur')} onCommit={seal} />
          </Row>
        )}
        {['dip_black', 'scene_black'].includes(scene.transitionIn.kind) && <Row label="转场时长"><span className="ro">各段时长在下方“风格 → 转场”中调整</span></Row>}
        <Row label="地点标题条" {...(scene.location ? { meta: scene.location.meta, onLock: lock((s) => s.location?.meta) } : {})}>
          <input type="checkbox" checked={scene.location?.show ?? false} data-testid="insp-location-show" onChange={(e) => up('地点标题条', (s) => { if (s.location) { s.location.show = e.target.checked; touch(s.location.meta); } else s.location = { text: s.title, show: e.target.checked, meta: { source: 'user', locked: false, updatedAt: Date.now() } }; })} />
          <input className="text" value={scene.location?.text ?? ''} placeholder="地名" data-testid="insp-location-text" onChange={(e) => up('地点标题条文字', (s) => { if (s.location) { s.location.text = e.target.value; touch(s.location.meta); } else s.location = { text: e.target.value, show: true, meta: { source: 'user', locked: false, updatedAt: Date.now() } }; }, 'loc')} onBlur={seal} />
        </Row>
      </Section>
      <Section title="背景" testid="insp-background">
        <BackgroundSection project={project} scene={scene} catalog={catalog} compiled={compiled} t={t} onPick={(id) => up('更换背景', (s) => { s.background.assetId = id; touch(s.background.meta); })} lock={lock((s) => s.background.meta)} />
        <Row label="取景缩放"><SliderField value={scene.background.framing.zoom} min={1} max={3} step={0.01} testid="insp-bg-zoom" onChange={(v) => up('背景取景', (s) => { s.background.framing.zoom = v; touch(s.background.meta); }, 'bgzoom')} onCommit={seal} /></Row>
        <Row label="取景 X"><NumField value={scene.background.framing.offsetX} step={5} digits={0} unit="px" onChange={(v) => up('背景取景', (s) => { s.background.framing.offsetX = v; touch(s.background.meta); }, 'bgx')} onCommit={seal} /></Row>
        <Row label="取景 Y"><NumField value={scene.background.framing.offsetY} step={5} digits={0} unit="px" onChange={(v) => up('背景取景', (s) => { s.background.framing.offsetY = v; touch(s.background.meta); }, 'bgy')} onCommit={seal} /></Row>
      </Section>

      <Section title="角色站位与服装" hint={`${castIds.length} 人`} testid="insp-cast">
        <Row label="在场角色">
          <span className="chips">
            {project.cast.length === 0 && <span className="ro">先在“项目”标签里添加角色</span>}
            {project.cast.map((c) => (
              <label key={c.id} className="chip check">
                <input type="checkbox" checked={castIds.includes(c.id)} data-testid={`scene-has-${c.id}`} onChange={(e) => toggleActorInScene(scene.id, c.id, e.target.checked, defaultModelOf(catalog, project, c.id))} />
                {c.displayName}
              </label>
            ))}
          </span>
        </Row>
        {castIds.map((cid) => {
          const cm = project.cast.find((c) => c.id === cid);
          const modelIds = catalog?.characters.find((c) => c.key === cm?.characterKey)?.modelIds ?? [];
          const options = catalog ? catalog.models.filter((m) => modelIds.includes(m.id) && (m.quality !== 'low' || m.id === scene.wardrobe[cid]!.modelId)) : [];
          const bl = scene.blocking[cid];
          return (
            <div key={cid} className="cast-card" data-testid={`insp-cast-${cid}`}>
              <div className="cast-name">{name(cid)}</div>
              <Row label="服装" meta={scene.wardrobe[cid]!.meta} onLock={lock((s) => s.wardrobe[cid]?.meta)}>
                <select value={scene.wardrobe[cid]!.modelId} data-testid={`insp-wardrobe-${cid}`} onChange={(e) => up('更换服装', (s) => { const w = s.wardrobe[cid]; if (w) { w.modelId = e.target.value; touch(w.meta); } })}>
                  {!options.some((m) => m.id === scene.wardrobe[cid]!.modelId) && <option value={scene.wardrobe[cid]!.modelId}>（素材库中缺失的服装）</option>}
                  {options.map((m) => <option key={m.id} value={m.id} title={m.id}>{costumeLabelZh(m.costumeInfo, m.costume)}</option>)}
                </select>
              </Row>
              {bl && (
                <>
                  <Row label="横向位置" meta={bl.meta} onLock={lock((s) => s.blocking[cid]?.meta)} testid={`insp-slot-row-${cid}`}>
                    <SliderField value={bl.slot} min={-1} max={1} step={0.01} testid={`insp-slot-${cid}`} onChange={(v) => up('调整站位', (s) => { const b = s.blocking[cid]; if (b) { b.slot = v; touch(b.meta); } }, `slot.${cid}`)} onCommit={seal} />
                  </Row>
                  <Row label="纵深">
                    <SliderField value={bl.depth} min={0} max={1} step={0.01} testid={`insp-depth-${cid}`} onChange={(v) => up('调整站位', (s) => { const b = s.blocking[cid]; if (b) { b.depth = v; touch(b.meta); } }, `depth.${cid}`)} onCommit={seal} />
                  </Row>
                  <Row label="入场">
                    <select value={bl.enter?.beatId ?? ''} data-testid={`insp-enter-${cid}`} onChange={(e) => up('入场时机', (s) => { const b = s.blocking[cid]; if (!b) return; if (e.target.value) b.enter = { beatId: e.target.value, side: b.enter?.side ?? 'none' }; else delete b.enter; touch(b.meta); })}>
                      <option value="">（开场就在）</option>
                      {scene.beats.map((b, i) => <option key={b.id} value={b.id}>第 {i + 1} 句</option>)}
                    </select>
                    {bl.enter && (
                      <select value={bl.enter.side} data-testid={`insp-enter-side-${cid}`} onChange={(e) => up('入场方向', (s) => { const b = s.blocking[cid]; if (b?.enter) { b.enter.side = e.target.value as 'left' | 'right' | 'none'; touch(b.meta); } })}>
                        <option value="none">无滑入</option><option value="left">从左</option><option value="right">从右</option>
                      </select>
                    )}
                  </Row>
                  <Row label="退场">
                    <select value={bl.exit?.beatId ?? ''} data-testid={`insp-exit-${cid}`} onChange={(e) => up('退场时机', (s) => { const b = s.blocking[cid]; if (!b) return; if (e.target.value) b.exit = { beatId: e.target.value }; else delete b.exit; touch(b.meta); })}>
                      <option value="">（不退场）</option>
                      {scene.beats.map((b, i) => <option key={b.id} value={b.id}>第 {i + 1} 句</option>)}
                    </select>
                  </Row>
                </>
              )}
            </div>
          );
        })}
      </Section>

      <Section title="音乐" defaultOpen={false} testid="insp-audio">
        <Row label="BGM" {...(scene.audio.bgm ? { meta: scene.audio.bgm.meta, onLock: lock((s) => s.audio.bgm?.meta) } : {})}>
          <select value={scene.audio.bgm?.assetId ?? ''} data-testid="insp-bgm" onChange={(e) => up('更换 BGM', (s) => {
            if (!e.target.value) delete s.audio.bgm;
            else if (s.audio.bgm) { s.audio.bgm.assetId = e.target.value; touch(s.audio.bgm.meta); }
            else s.audio.bgm = { assetId: e.target.value, volume: 0.6, meta: { source: 'user', locked: false, updatedAt: Date.now() } };
          })}>
            <option value="">（无）</option>
            {catalog?.audio.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            {scene.audio.bgm && !catalog?.audio.some((a) => a.id === scene.audio.bgm!.assetId) && <option value={scene.audio.bgm.assetId}>{scene.audio.bgm.assetId}（素材库中缺失）</option>}
          </select>
        </Row>
        {scene.audio.bgm && (
          <Row label="音量"><SliderField value={scene.audio.bgm.volume} min={0} max={1} step={0.01} onChange={(v) => up('BGM 音量', (s) => { if (s.audio.bgm) { s.audio.bgm.volume = v; touch(s.audio.bgm.meta); } }, 'bgmvol')} onCommit={seal} /></Row>
        )}
      </Section>
    </>
  );
}

const PURPOSE_LABEL: Record<string, string> = { move: '换地点', insert: '插入镜头', time: '换时段' };
const BG_TRANS_LABEL: Record<string, string> = { cut: '硬切', dip_black: '黑场', dip_white: '白场', crossfade: '叠化' };

/** The scene's backgrounds: the start picture, the switches along the timeline, and "switch here" at the playhead. */
function BackgroundSection({ project, scene, catalog, compiled, t, onPick, lock }: { project: Project; scene: Scene; catalog: CompactCatalog | null; compiled: CompiledProject | null; t: number; onPick: (id: string) => void; lock: (l: boolean) => void }) {
  const [picker, setPicker] = useState<'start' | 'switch' | null>(null);
  const fit = useSceneFit(project, scene, catalog);
  const current = catalog?.backgrounds.find((b) => b.id === scene.background.assetId);
  const bandName = (k: string) => catalog?.bands.find((b) => b.key === k)?.name ?? k;
  const curFit = current ? fit(current) : null;
  const notStage = scene.brief?.isPerformance === true && current?.labels && !current.labels.stage;
  const cScene = compiled?.scenes.find((x) => x.id === scene.id);
  const segs = cScene?.bgSegments ?? [];
  const nowIdx = segs.reduce((acc, g, i) => (g.start <= t + 1e-6 ? i : acc), 0);
  const nameOf = (id: string) => catalog?.backgrounds.find((b) => b.id === id)?.name ?? id;
  const doSwitch = (id: string) => {
    setPicker(null);
    const at = Math.max(t, cScene?.contentStart ?? 0);
    const keyId = addKeyAt(scene.id, { kind: 'stage' }, 'background', bgSwitchValue(id, 'cut', 'move'), at, 0);
    if (keyId) useUi.getState().set({ keySel: [keyId], inspectorTab: 'key' });
  };
  return (
    <>
      <Row label="开场背景" meta={scene.background.meta} onLock={lock}>
        <button type="button" className="btn-s" data-testid="insp-bg" onClick={() => setPicker('start')}>更换…</button>
      </Row>
      <div className="bgx-cur" data-testid="insp-bg-card">
        {current ? <BgThumb bg={current} w={240} /> : <div className="bgx-thumb"><div className="bgx-ph"><strong>{scene.background.assetId}</strong><span>素材库中缺失</span></div></div>}
        <div className="t">
          <strong data-testid="insp-bg-title">{current?.name ?? scene.background.assetId}</strong>
          <small>{current?.description ?? ''}</small>
          {current && <BgBadges bg={current} />}
        </div>
      </div>
      {curFit?.level === 'no' && <p className="bg-warn" data-testid="insp-bg-warn">⚠ {current?.labels && bgCategoryOf(current) === 'scene' ? `这个背景属于 ${bandText(current.labels, bandName)}，与场景里的出场角色不符` : curFit.reason}（手动选择仍然有效）。</p>}
      {curFit?.level === 'fallback' && <p className="bg-warn" data-testid="insp-bg-warn">？ 这个背景的主人/归属不明，请确认是否合适。</p>}
      {notStage && <p className="bg-warn" data-testid="insp-bg-warn-stage">⚠ 这是正式演出，但这个背景不是舞台。</p>}
      <Row label="切换">
        <button type="button" className="btn-s" data-testid="insp-bg-switch" onClick={() => setPicker('switch')} title="在播放头位置给这个场景添加一次背景切换">在此处切换背景…</button>
      </Row>
      {segs.length > 1 && (
        <div className="bgx-segs" data-testid="insp-bg-segs">
          {segs.map((g, i) => (
            <div key={`${g.start}:${g.assetId}`} className={`bgx-seg${i === nowIdx ? ' now' : ''}`} data-testid="insp-bg-seg">
              <span className="time">{g.start.toFixed(1)}s</span>
              <span className="t" title={nameOf(g.assetId)}>{nameOf(g.assetId)}</span>
              <span className="dim">{i === 0 ? '开场' : `${PURPOSE_LABEL[g.purpose]} · ${BG_TRANS_LABEL[g.transition]}`}</span>
              {g.keyId && <button type="button" className="btn-s" onClick={() => useUi.getState().set({ keySel: [g.keyId!], inspectorTab: 'key' })}>编辑</button>}
            </div>
          ))}
        </div>
      )}
      {picker && catalog && (
        <BgPicker
          backgrounds={catalog.backgrounds} current={picker === 'start' ? scene.background.assetId : (segs[nowIdx]?.assetId ?? null)}
          title={picker === 'start' ? '选择开场背景' : `在 ${t.toFixed(1)}s 处切换到…`} fit={fit}
          onPick={(id) => { if (picker === 'start') { setPicker(null); onPick(id); } else doSwitch(id); }} onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}

function BeatFields({ project, scene, beat, compiled }: { project: Project; scene: Scene; beat: Beat; compiled: CompiledProject | null }) {
  const { applyEdit, seal } = useEdit();
  const up = (label: string, fn: (b: Draft<Beat>) => void, coalesce?: string) =>
    applyEdit((d) => {
      const b = d.scenes.find((s) => s.id === scene.id)?.beats.find((x) => x.id === beat.id);
      if (b) fn(b);
    }, label, coalesce ? { coalesce: `${beat.id}.${coalesce}` } : {});
  const lock = (get: (b: Draft<Beat>) => { locked: boolean }) => (locked: boolean) => up(locked ? '锁定' : '解锁', (b) => void (get(b).locked = locked));
  const fl = (field: string) => <FieldLock meta={beat.meta} field={field} toggle={(on) => up(on ? '锁定字段' : '解锁字段', (b) => setFieldLock(b.meta, field, on))} />;
  const castIds = Object.keys(scene.wardrobe);
  const name = (id: string) => project.cast.find((c) => c.id === id)?.displayName ?? id;
  const n = scene.beats.indexOf(beat) + 1;
  // What the compiler made of this line (preview truth): held camera, and the rule director's expression / gesture
  const cScene = compiled?.scenes.find((x) => x.id === scene.id);
  const cBeat = cScene?.beats.find((x) => x.id === beat.id);
  const speaker = cScene?.actors.find((a) => a.castId === beat.speakerId);
  const lineInfo = cachedLineInfo(project, scene, beat);
  const ind = lineIndicator(lineInfo);
  const split = useSplitRun();
  const ruleExpr = cBeat && speaker?.expressions.find((e) => Math.abs(e.at - cBeat.start) < 1e-6)?.name;
  const ruleGesture = cBeat && speaker?.motions.find((m) => !m.loop && Math.abs(m.at - (cBeat.start + 0.15)) < 1e-6)?.name;
  return (
    <>
      <Section title={`台词 ${n}`} hint={beat.id} testid="insp-beat">
        <Row label="类型" meta={beat.meta} onLock={lock((b) => b.meta)}>
          <select value={beat.kind} data-testid="insp-beat-kind" onChange={(e) => up('修改类型', (b) => { b.kind = e.target.value as Beat['kind']; touch(b.meta); })}>
            {BEAT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Row>
        <Row label="形式">
          <select value={beat.variant} data-testid="insp-beat-variant" onChange={(e) => up('修改台词形式', (b) => { b.variant = e.target.value as Beat['variant']; touch(b.meta); })}>
            {VARIANTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Row>
        <Row label="说话人">
          <select value={beat.speakerId ?? ''} data-testid="insp-beat-speaker" onChange={(e) => up('修改说话人', (b) => { if (e.target.value) b.speakerId = e.target.value; else delete b.speakerId; touch(b.meta); })}>
            <option value="">（无）</option>
            {castIds.map((id) => <option key={id} value={id}>{name(id)}</option>)}
          </select>
        </Row>
        <Row label="同时说话">
          <span className="chips">
            {castIds.filter((id) => id !== beat.speakerId).map((id) => (
              <label key={id} className="chip check">
                <input type="checkbox" checked={beat.coSpeakers.includes(id)} data-testid={`insp-cospeaker-${id}`} onChange={(e) => up('修改同时说话人', (b) => { b.coSpeakers = e.target.checked ? [...b.coSpeakers, id] : b.coSpeakers.filter((x) => x !== id); touch(b.meta); })} />
                {name(id)}
              </label>
            ))}
          </span>
        </Row>
        <Row label="镜头切入" extra={fl('cutIn')}>
          <select value={beat.cutIn} data-testid="insp-beat-cutin" onChange={(e) => up('修改切入方式', (b) => { b.cutIn = e.target.value as Beat['cutIn']; touch(b.meta); })}>
            <option value="cut">硬切</option><option value="dip_black">黑场眨眼</option><option value="dip_white">白场眨眼</option>
          </select>
          {beat.cutIn !== 'cut' && (
            <label className="chip check"><input type="checkbox" checked={beat.cutInKeepDialog} data-testid="insp-beat-keepdialog" onChange={(e) => up('黑场保留对话区', (b) => { b.cutInKeepDialog = e.target.checked; touch(b.meta); })} />保留对话区</label>
          )}
        </Row>
        <Row label="台词文本" extra={fl('text')}><span className="ro">锁字段后，重新生成时这句的文字不变</span></Row>
        <textarea className="area" rows={4} value={beat.text} data-testid="insp-beat-text" onChange={(e) => up('修改台词', (b) => { b.text = e.target.value; touch(b.meta); }, 'text')} onBlur={seal} />
        {ind && lineInfo && (
          <div className={`line-meter${ind.warn ? ' over' : ''}`} data-testid="insp-line-meter" data-over={ind.warn ? 'true' : 'false'} data-expanded={ind.expanded ? 'true' : 'false'}>
            <div className="line-meter-row">
              <span className={`line-count${ind.warn ? ' warn' : ''}`} data-testid="insp-line-count">{ind.text}</span>
              {ind.warn && <span className="badge warn-badge" data-testid="insp-long-badge">超长</span>}
              {ind.expanded && <span className="badge" data-testid="insp-expanded-badge">已展开</span>}
              {ind.warn && (
                <button className="btn-s accent" disabled={split.busy} onClick={() => void splitLongLines({ sceneIds: [scene.id], beatIds: [beat.id], target: beat.id })} data-testid="insp-auto-split" title="按语义拆成连续的几句，同一个镜头、同一个说话人；一步撤销">
                  {split.busy && split.target === beat.id ? '拆分中…' : '自动拆分'}
                </button>
              )}
            </div>
            {ind.warn && <p className="hint warn" data-testid="insp-long-hint">超出对话框的 {lineInfo.lines - lineInfo.max} 行在画面上看不到。可以自动拆分，或打开下面的展开显示。</p>}
            {(lineInfo.lines > lineInfo.max || ind.expanded) && (
              <label className="line-expand" data-testid="insp-expand-row">
                <input type="checkbox" checked={ind.expanded} data-testid="insp-expand" onChange={(e) => up('展开显示', (b) => { if (e.target.checked) b.overflow = 'expand'; else delete b.overflow; touch(b.meta); })} />
                展开显示
                <span className="hint" data-testid="insp-expand-hint">{expandHint(lineInfo.lines, lineInfo.max)}</span>
              </label>
            )}
          </div>
        )}
        {beat.splitFrom !== undefined && <p className="hint" data-testid="insp-continuation">↳ 续句：拆自 {beat.splitFrom}，沿用同一个镜头</p>}
        <Row label="情绪" extra={fl('emotion')}>
          <select value={beat.emotion ?? ''} data-testid="insp-beat-emotion" onChange={(e) => up('修改情绪', (b) => { if (e.target.value) b.emotion = e.target.value; else delete b.emotion; touch(b.meta); })}>
            <option value="">（未设置）</option>
            {(beat.emotion && !EMOTION_TAGS.includes(beat.emotion) ? [beat.emotion, ...EMOTION_TAGS] : EMOTION_TAGS).map((k) => <option key={k} value={k}>{EMOTION_LABEL[k] ?? k}</option>)}
          </select>
        </Row>
        {(ruleExpr || ruleGesture) && (
          <Row label="规则导演" meta={{ source: 'rule', locked: false, updatedAt: 0 }}>
            <span className="ro" data-testid="insp-rule-output" title={`${ruleExpr ?? ''} ${ruleGesture ?? ''}`}>表情 {ruleExpr ? expressionLabel(ruleExpr) : '—'} · 手势 {ruleGesture ? motionLabel(ruleGesture) : '—'}</span>
          </Row>
        )}
        <Row label="时长" extra={fl('duration')}>
          <select value={beat.duration.mode} data-testid="insp-beat-dur-mode" onChange={(e) => up('修改时长模式', (b) => { b.duration.mode = e.target.value as 'auto' | 'fixed'; if (b.duration.mode === 'fixed' && b.duration.seconds <= 0) b.duration.seconds = 3; touch(b.meta); })}>
            <option value="auto">自动（按文字）</option>
            <option value="fixed">固定</option>
          </select>
          {beat.duration.mode === 'fixed' && (
            <NumField value={beat.duration.seconds} min={0.2} max={60} step={0.1} digits={1} unit="s" testid="insp-beat-dur" onChange={(v) => up('修改时长', (b) => { b.duration.seconds = v; touch(b.meta); }, 'dur')} onCommit={seal} />
          )}
        </Row>
      </Section>

    </>
  );
}
