/**
 * Everything about one person at the playhead: expression, gesture, costume, head / body / gaze, position, opacity.
 * Each control writes a key at the current time on the person's track (or updates the key already there) and shows
 * the provenance + lock of that key. Used by the inspector's actor tab and by the quick bar over the preview.
 */
import { costumeLabelZh, expressionLabel, motionLabel } from '@shared/catalog/labels';
import type { CompactCatalog } from '@shared/schema/assets';
import { HEAD_DOWN, HEAD_UP } from '@shared/staging/facing';
import type { Project, Scene } from '@shared/schema/project';
import type { RenderState } from '@shared/timeline/types';
import { keyNear, lockKey, positionAt, setSlotDepth, writeKey } from '../../store/actions';
import { SliderField, Row } from '../ui';
import { useModelEntry } from '../useModel';
import { useProject } from '../../store/projectStore';

type Turn = { mode: 'target'; target: string; pitch?: number } | { mode: 'angle'; yaw: number; pitch?: number };
type Gaze = { target: string } | { x: number; y: number };

export interface ActorCtx {
  project: Project;
  scene: Scene;
  castId: string;
  t: number;
  state: RenderState | null;
  catalog: CompactCatalog | null;
}

const nameOf = (p: Project, id: string) => p.cast.find((c) => c.id === id)?.displayName ?? id;

export function ActorControls({ ctx, compact = false }: { ctx: ActorCtx; compact?: boolean }) {
  const { project, scene, castId, t, state, catalog } = ctx;
  const target = { kind: 'actor', castId } as const;
  const actor = state?.actors.find((a) => a.castId === castId);
  const modelId = actor?.modelId ?? scene.wardrobe[castId]?.modelId;
  const model = useModelEntry(modelId);
  const seal = useProject.getState().seal;
  const near = (channel: Parameters<typeof keyNear>[3]) => keyNear(project, scene.id, target, channel, t);
  const meta = (channel: Parameters<typeof keyNear>[3]) => {
    const k = near(channel);
    return k ? { meta: k.key.meta, onLock: (l: boolean) => lockKey(scene.id, k.key.id, l) } : {};
  };
  const put = (channel: Parameters<typeof keyNear>[3], value: unknown, label: string, opts: { coalesce?: string; duration?: number } = {}) =>
    writeKey(scene.id, target, channel, value, t, { label, ...opts });

  const others = Object.keys(scene.wardrobe).filter((id) => id !== castId);
  const families = [...new Map((model?.motions ?? []).filter((m) => !m.family.startsWith('idle')).map((m) => [m.family, m.family])).keys()];
  const costumes = catalog ? catalog.models.filter((m) => m.characterKey === project.cast.find((c) => c.id === castId)?.characterKey && m.quality !== 'low') : [];
  const pos = positionAt(project, scene.id, castId, t) ?? { slot: 0, depth: 0.3 };

  const turn = (channel: 'head' | 'body') => {
    const k = near(channel);
    const v = k?.key.value as Turn | undefined;
    const label = channel === 'head' ? '头部' : '身体';
    const yaw = v?.mode === 'angle' ? v.yaw : channel === 'head' ? (actor?.desiredYaw ?? 0) : (actor?.body ?? 0);
    const sel = v ? (v.mode === 'angle' ? 'angle' : v.target) : '';
    return (
      <>
        <Row label={`${label}朝向`} testid={`actor-row-${channel}`} {...meta(channel)}>
          <select
            value={sel}
            data-testid={`actor-${channel}-mode`}
            onChange={(e) => {
              const val = e.target.value;
              if (val === '') return;
              put(channel, val === 'angle' ? { mode: 'angle', yaw: Math.round(yaw * 100) / 100 } : { mode: 'target', target: val }, `设置${label}朝向`, { duration: 0 });
            }}
          >
            <option value="">{v ? '（—）' : '自动'}</option>
            <option value="camera">看向镜头</option>
            <option value="away">背向对方</option>
            {channel === 'head' && sel === 'auto' && <option value="auto">自动朝向</option>}
            {others.map((id) => <option key={id} value={id}>看向 {nameOf(project, id)}</option>)}
            <option value="angle">指定角度</option>
          </select>
        </Row>
        {channel === 'head' && (
          <Row label="头部俯仰" testid="actor-row-head-pitch" {...meta('head')}>
            <select
              value={(v?.pitch ?? 0) < -0.05 ? 'down' : (v?.pitch ?? 0) > 0.05 ? 'up' : 'level'}
              data-testid="actor-head-pitch"
              title="低头 / 抬头（ParamAngleY）；保留当前的朝向"
              onChange={(e) => {
                const pitch = e.target.value === 'down' ? HEAD_DOWN : e.target.value === 'up' ? HEAD_UP : 0;
                const facing = v ? (v.mode === 'angle' ? { mode: 'angle' as const, yaw: v.yaw } : { mode: 'target' as const, target: v.target }) : { mode: 'target' as const, target: 'auto' };
                put('head', { ...facing, ...(pitch !== 0 ? { pitch } : {}) }, '设置头部俯仰', { duration: 0.3 });
              }}
            >
              <option value="level">平视</option>
              <option value="down">低头</option>
              <option value="up">抬头</option>
            </select>
          </Row>
        )}
        {!compact || sel === 'angle' ? (
          <Row label="">
            <SliderField
              value={yaw}
              min={-1}
              max={1}
              step={0.01}
              testid={`actor-${channel}-yaw`}
              onChange={(val) => put(channel, { mode: 'angle', yaw: val }, `调整${label}角度`, { coalesce: `${channel}.${castId}`, duration: 0 })}
              onCommit={seal}
            />
          </Row>
        ) : null}
      </>
    );
  };

  const gk = near('gaze');
  const gv = gk?.key.value as Gaze | undefined;
  const gsel = gv ? ('target' in gv ? gv.target : 'xy') : '';
  const gxy = gv && 'x' in gv ? gv : { x: actor?.gaze.x ?? 0, y: actor?.gaze.y ?? 0 };

  return (
    <div className="actor-controls" data-testid="actor-controls">
      <Row label="表情" {...meta('expression')}>
        <select value={actor?.expression ?? ''} data-testid="actor-expression" onChange={(e) => put('expression', { name: e.target.value || null }, '修改表情')}>
          <option value="">（无表情）</option>
          {(model?.expressions ?? []).map((x) => <option key={x.name} value={x.name} title={x.name}>{expressionLabel(x.name)}</option>)}
          {actor?.expression && !(model?.expressions ?? []).some((x) => x.name === actor.expression) && <option value={actor.expression}>{expressionLabel(actor.expression)}</option>}
        </select>
      </Row>
      <Row label="手势动作" {...meta('motion')}>
        <select value="" data-testid="actor-motion" onChange={(e) => e.target.value && put('motion', { name: e.target.value }, '触发动作')}>
          <option value="">{actor?.motion && !actor.motion.loop ? `播放中：${motionLabel(actor.motion.name)}` : '（选择以在此刻播放）'}</option>
          {families.map((f) => <option key={f} value={f} title={f}>{motionLabel(f)}</option>)}
        </select>
      </Row>
      <Row label="服装" meta={scene.wardrobe[castId]?.meta ?? ({ source: 'default', locked: false, updatedAt: 0 } as const)}>
        <select
          value={scene.wardrobe[castId]?.modelId ?? ''}
          data-testid="actor-wardrobe"
          onChange={(e) =>
            useProject.getState().applyEdit((d) => {
              const w = d.scenes.find((s) => s.id === scene.id)?.wardrobe[castId];
              if (w) {
                w.modelId = e.target.value;
                w.meta.source = 'user';
                w.meta.updatedAt = Date.now();
              }
            }, '更换服装')
          }
        >
          {costumes.length === 0 && <option value={scene.wardrobe[castId]?.modelId}>{scene.wardrobe[castId]?.modelId}</option>}
          {costumes.map((m) => <option key={m.id} value={m.id} title={m.id}>{costumeLabelZh(m.costumeInfo, m.costume)}</option>)}
        </select>
      </Row>
      {!compact && (
        <Row label="此刻换装" {...meta('costume')}>
          <select value="" data-testid="actor-costume-key" onChange={(e) => e.target.value && put('costume', { modelId: e.target.value }, '场景中换装')}>
            <option value="">（选择以从此刻起换装）</option>
            {costumes.map((m) => <option key={m.id} value={m.id} title={m.id}>{costumeLabelZh(m.costumeInfo, m.costume)}</option>)}
          </select>
        </Row>
      )}
      {turn('head')}
      {!compact && turn('body')}
      <Row label="视线" {...meta('gaze')}>
        <select
          value={gsel}
          data-testid="actor-gaze-mode"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            put('gaze', v === 'xy' ? { x: Math.round(gxy.x * 100) / 100, y: Math.round(gxy.y * 100) / 100 } : { target: v }, '设置视线', { duration: 0 });
          }}
        >
          <option value="">{gv ? '（—）' : '自动'}</option>
          <option value="camera">看镜头</option>
          <option value="down">向下</option>
          <option value="away">看别处</option>
          {others.map((id) => <option key={id} value={id}>看 {nameOf(project, id)}</option>)}
          <option value="xy">自定义方向</option>
        </select>
      </Row>
      {gsel === 'xy' && (
        <>
          <Row label="视线 X"><SliderField value={gxy.x} min={-1} max={1} step={0.01} testid="actor-gaze-x" onChange={(v) => put('gaze', { x: v, y: gxy.y }, '调整视线', { coalesce: `gaze.${castId}`, duration: 0 })} onCommit={seal} /></Row>
          <Row label="视线 Y"><SliderField value={gxy.y} min={-1} max={1} step={0.01} testid="actor-gaze-y" onChange={(v) => put('gaze', { x: gxy.x, y: v }, '调整视线', { coalesce: `gaze.${castId}`, duration: 0 })} onCommit={seal} /></Row>
        </>
      )}
      {!compact && (
        <>
          <Row label="横向位置" {...meta('position')}>
            <SliderField value={pos.slot} min={-1} max={1} step={0.01} testid="actor-slot" onChange={(v) => setSlotDepth(scene.id, castId, { slot: v, depth: pos.depth }, t)} onCommit={seal} />
          </Row>
          <Row label="纵深">
            <SliderField value={pos.depth} min={0} max={1} step={0.01} testid="actor-depth" onChange={(v) => setSlotDepth(scene.id, castId, { slot: pos.slot, depth: v }, t)} onCommit={seal} />
          </Row>
          <Row label="不透明度" {...meta('opacity')}>
            <SliderField value={actor?.opacity ?? 1} min={0} max={1} step={0.01} testid="actor-opacity" onChange={(v) => put('opacity', v, '调整不透明度', { coalesce: `opacity.${castId}`, duration: 0 })} onCommit={seal} />
          </Row>
        </>
      )}
    </div>
  );
}
