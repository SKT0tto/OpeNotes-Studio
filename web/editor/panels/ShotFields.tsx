/** The shot of the selected line: size, move, cut / glide, depth of field, focus, hand-made camera and per-person offsets. */
import { MOVE_LABEL, SHOT_LABEL } from '@shared/catalog/labels';
import { CAMERA_MOVES, DEFAULT_INSERT_BOX, SHOT_TYPES, normalizeShotType } from '@shared/staging/framing';
import { resolveStyle } from '@shared/style/ournotes';
import type { Beat, Project, Scene } from '@shared/schema/project';
import type { CompiledProject } from '@shared/timeline/types';
import { clearManualCamera, editShot, setManualCamera } from '../../store/actions';
import { useProject } from '../../store/projectStore';
import { FieldLock, NumField, Row, SliderField, setFieldLock } from '../ui';
import { cameraOfBeat } from '../stageTools/camera';


export function ShotFields({ project, scene, beat, compiled }: { project: Project; scene: Scene; beat: Beat; compiled: CompiledProject | null }) {
  const seal = useProject.getState().seal;
  const sh = (label: string, fn: (s: Beat['shot']) => void, coalesce?: string) => void editShot(scene.id, beat.id, label, fn, coalesce);
  const lock = (locked: boolean) => void editShot(scene.id, beat.id, locked ? '锁定镜头' : '解锁镜头', (s) => void (s.meta.locked = locked), undefined, true);
  const fl = (field: string) => <FieldLock meta={beat.shot.meta} field={field} toggle={(on) => void editShot(scene.id, beat.id, on ? '锁定字段' : '解锁字段', (s) => setFieldLock(s.meta, field, on), undefined, true)} />;
  const castIds = Object.keys(scene.wardrobe);
  const name = (id: string) => project.cast.find((c) => c.id === id)?.displayName ?? id;
  const autoDof = resolveStyle(project.style, scene.style, beat.style).values.shots[normalizeShotType(beat.shot.type).type].dof;
  const cBeat = compiled?.scenes.find((x) => x.id === scene.id)?.beats.find((x) => x.id === beat.id);
  const cam = cameraOfBeat(compiled, scene, scene.id, beat.id);
  const offsets = beat.shot.offsets ?? {};

  return (
    <div data-testid="insp-shot">
      <Row label="景别" meta={beat.shot.meta} onLock={lock} extra={fl('type')}>
        <select value={beat.shot.type} data-testid="insp-shot-type" onChange={(e) => sh('修改景别', (s) => void (s.type = e.target.value as Beat['shot']['type']))}>
          {((SHOT_TYPES as readonly string[]).includes(beat.shot.type) ? [...SHOT_TYPES] : [beat.shot.type, ...SHOT_TYPES]).map((t) => <option key={t} value={t}>{SHOT_LABEL[t]}</option>)}
        </select>
      </Row>
      {normalizeShotType(beat.shot.type).type === 'insert' && (
        <>
          {(['x', 'y', 'w', 'h'] as const).map((k) => {
            const box = beat.shot.insertBox ?? DEFAULT_INSERT_BOX;
            return (
              <Row key={k} label={{ x: '目标框 左', y: '目标框 上', w: '目标框 宽', h: '目标框 高' }[k]}>
                <SliderField value={box[k]} min={k === 'w' || k === 'h' ? 0.05 : 0} max={1} step={0.01} testid={`insp-insert-${k}`} onChange={(v) => sh('调整插入镜头目标框', (s) => { s.insertBox = { ...(s.insertBox ?? DEFAULT_INSERT_BOX), [k]: Math.round(v * 100) / 100 }; }, `ib.${k}`)} onCommit={seal} />
              </Row>
            );
          })}
          <Row label=""><span className="ro">目标框相对于焦点人物的整体轮廓（头到脚）；相机会对准这个框。</span></Row>
        </>
      )}
      <Row label="运镜" extra={fl('move')}>
        <select value={beat.shot.move} data-testid="insp-shot-move" onChange={(e) => sh('修改运镜', (s) => void (s.move = e.target.value as Beat['shot']['move']))}>
          {CAMERA_MOVES.map((m) => <option key={m} value={m}>{MOVE_LABEL[m]}</option>)}
        </select>
      </Row>
      <Row label="换镜方式">
        <select value={beat.shot.transition ?? 'auto'} data-testid="insp-shot-transition" onChange={(e) => sh('修改换镜方式', (s) => { if (e.target.value === 'auto') delete s.transition; else s.transition = e.target.value as 'cut' | 'glide'; })}>
          <option value="auto">按风格（默认硬切）</option><option value="cut">硬切</option><option value="glide">滑移</option>
        </select>
      </Row>
      {cBeat?.shotHeld && (
        <Row label="沿用机位">
          <span className="held" data-testid="insp-shot-held">
            <span className="chip">沿用上一机位（取景相同或最短镜头规则）</span>
            <button className="btn-s" data-testid="insp-shot-force-cut" onClick={() => sh('强制切镜', () => undefined)}>强制切镜</button>
          </span>
        </Row>
      )}
      <Row label="景深" extra={fl('dof')}>
        <span className="seg" role="group" aria-label="景深模式">
          <button className={beat.shot.dof === undefined ? 'on' : ''} aria-pressed={beat.shot.dof === undefined} data-testid="insp-shot-dof-auto" onClick={() => sh('景深自动', (s) => void delete s.dof)}>自动 {autoDof}</button>
          <button className={beat.shot.dof !== undefined ? 'on' : ''} aria-pressed={beat.shot.dof !== undefined} data-testid="insp-shot-dof-manual" onClick={() => sh('景深手动', (s) => { if (s.dof === undefined) s.dof = autoDof; })}>手动</button>
        </span>
      </Row>
      {beat.shot.dof !== undefined && (
        <Row label="">
          <SliderField value={beat.shot.dof} min={0} max={6} step={1} digits={0} testid="insp-shot-dof" onChange={(v) => sh('修改景深', (s) => void (s.dof = Math.round(v)), 'dof')} onCommit={seal} />
        </Row>
      )}
      <Row label="焦点" extra={fl('focus')}>
        <span className="chips">
          {castIds.map((id) => (
            <label key={id} className="chip check">
              <input type="checkbox" checked={beat.shot.focus.includes(id)} data-testid={`insp-focus-${id}`} onChange={(e) => sh('修改镜头焦点', (s) => void (s.focus = e.target.checked ? [...s.focus, id] : s.focus.filter((x) => x !== id)))} />
              {name(id)}
            </label>
          ))}
        </span>
      </Row>

      <div className="subhead">手动镜头（本句）</div>
      <Row label="状态">
        <span className="held">
          <span className={`chip${cam?.manual ? ' on' : ''}`} data-testid="cam-state">{cam?.manual ? '手动取景' : '自动求解'}</span>
          {cam?.manual ? (
            <button className="btn-s" data-testid="cam-restore" onClick={() => clearManualCamera(scene.id, beat.id)}>恢复自动</button>
          ) : (
            <button className="btn-s" disabled={!cam} data-testid="cam-bake" onClick={() => cam && setManualCamera(scene.id, beat.id, cam.pose, '烘焙镜头为手动')} title="把当前求解结果固定为可编辑的数值">烘焙为手动</button>
          )}
        </span>
      </Row>
      {cam && (
        <>
          <Row label="中心 X"><NumField value={cam.pose.x} step={5} digits={0} unit="px" testid="cam-x" onChange={(v) => setManualCamera(scene.id, beat.id, { ...cam.pose, x: v }, '修改镜头位置', 'x')} onCommit={seal} /></Row>
          <Row label="中心 Y"><NumField value={cam.pose.y} step={5} digits={0} unit="px" testid="cam-y" onChange={(v) => setManualCamera(scene.id, beat.id, { ...cam.pose, y: v }, '修改镜头位置', 'y')} onCommit={seal} /></Row>
          <Row label="缩放"><SliderField value={cam.pose.zoom} min={1} max={14} step={0.05} unit="×" testid="cam-zoom" onChange={(v) => setManualCamera(scene.id, beat.id, { ...cam.pose, zoom: v }, '修改镜头缩放', 'zoom')} onCommit={seal} /></Row>
          <Row label="背景放大"><SliderField value={cam.pose.bgZoom ?? Math.pow(cam.pose.zoom, 0.85)} min={1} max={6} step={0.05} unit="×" testid="cam-bgzoom" onChange={(v) => setManualCamera(scene.id, beat.id, { ...cam.pose, bgZoom: v }, '修改背景放大', 'bgz')} onCommit={seal} /></Row>
          <Row label="倾斜"><SliderField value={cam.pose.roll ?? 0} min={-30} max={30} step={0.5} unit="°" testid="cam-roll" onChange={(v) => setManualCamera(scene.id, beat.id, { ...cam.pose, roll: v }, '修改镜头倾斜', 'roll')} onCommit={seal} /></Row>
        </>
      )}

      <div className="subhead">镜头内人物偏移（单位：画面高度）</div>
      {castIds.map((id) => {
        const o = offsets[id] ?? { x: 0, y: 0 };
        const set = (patch: Partial<{ x: number; y: number }>, coalesce: string) => sh('调整人物偏移', (s) => { s.offsets ??= {}; s.offsets[id] = { ...o, ...patch }; }, coalesce);
        return (
          <Row key={id} label={name(id)}>
            <NumField label="x" value={o.x} step={0.01} min={-2} max={2} testid={`off-x-${id}`} onChange={(v) => set({ x: v }, `ox.${id}`)} onCommit={seal} />
            <NumField label="y" value={o.y} step={0.01} min={-2} max={2} testid={`off-y-${id}`} onChange={(v) => set({ y: v }, `oy.${id}`)} onCommit={seal} />
            {offsets[id] && <button className="ghost" title="清除偏移" aria-label={`清除 ${name(id)} 偏移`} onClick={() => sh('清除人物偏移', (s) => { if (s.offsets) { delete s.offsets[id]; if (Object.keys(s.offsets).length === 0) delete s.offsets; } })}>↺</button>}
          </Row>
        );
      })}
      <p className="hint">在预览里按住 Shift 拖动人物也可以调整；偏移叠加在自动排布之上。</p>
    </div>
  );
}
