/**
 * Storyboard: one card per line with its thumbnail, shot size / depth of field / hold badges, duration and the controls
 * you reach for most (shot size, focus, cut-in). Click selects (Ctrl / Shift: several, then change them together),
 * drag reorders inside a scene, ＋ inserts a line after, ✕ deletes. Thumbnails come from the live player (see thumbs.ts).
 */
import { useMemo, useState } from 'react';
import { BEAT_KIND_LABEL, SHOT_LABEL, SHOT_SHORT } from '@shared/catalog/labels';
import { SHOT_TYPES } from '@shared/staging/framing';
import type { Beat, Project } from '@shared/schema/project';
import type { usePlayerHost } from '../../play/usePlayerHost';
import { addBeatAfter, copyBeat, deleteBeat, editBeat, editScene, editShot, reorderBeat } from '../../store/actions';
import { useProject } from '../../store/projectStore';
import { useUi } from '../../store/uiStore';
import { LockIcon } from '../ui';
import { cachedThumb, useThumbnails } from './thumbs';
import { useCatalog } from '../useCatalog';

type Host = ReturnType<typeof usePlayerHost>;
const TRANSITION_LABEL: Record<string, string> = { cut: '硬切', dip_black: '黑场眨眼', scene_black: '换场黑场', fade_black: '黑场', fade_white: '白场', crossfade: '交叉溶解', wipe: '擦除' };

export function Storyboard({ project, host, active }: { project: Project; host: Host; active: boolean }) {
  const selection = useProject((s) => s.selection);
  const cards = useUi((s) => s.cards);
  const set = useUi((s) => s.set);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const storedKey = useMemo(() => project.scenes.flatMap((s) => s.beats.map((b) => b.id)).join(','), [project.scenes]);
  const { pending } = useThumbnails(host, storedKey, active);
  const name = (id: string) => project.cast.find((c) => c.id === id)?.displayName ?? id;
  const catalog = useCatalog();
  const bgName = (id: string) => catalog?.backgrounds.find((b) => b.id === id)?.name ?? id;

  const pick = (sceneId: string, beatId: string, e: React.MouseEvent) => {
    useProject.getState().select({ sceneId, beatId });
    if (e.ctrlKey || e.metaKey || e.shiftKey) set({ cards: cards.includes(beatId) ? cards.filter((c) => c !== beatId) : [...cards, beatId] });
    else set({ cards: [beatId] });
    const t = host.playerRef.current?.compiled.scenes.find((s) => s.id === sceneId)?.beats.find((b) => b.id === beatId)?.start;
    if (t !== undefined && !e.ctrlKey && !e.shiftKey) host.seek(t + 0.01);
  };
  const batch = (label: string, fn: (b: Beat) => void) => {
    for (const s of project.scenes) for (const b of s.beats) if (cards.includes(b.id)) editBeat(s.id, b.id, label, fn);
  };
  const batchShot = (type: Beat['shot']['type']) => {
    for (const s of project.scenes) for (const b of s.beats) if (cards.includes(b.id)) editShot(s.id, b.id, '批量修改景别', (sh) => void (sh.type = type));
  };

  if (project.scenes.length === 0) {
    return (
      <div className="storyboard empty-state" data-testid="storyboard">
        <p className="empty-title">没有可显示的镜头</p>
        <p className="hint">先在左侧剧本里添加场景和台词。</p>
      </div>
    );
  }

  return (
    <div className="storyboard" data-testid="storyboard">
      <div className="sb-bar">
        <strong>分镜</strong>
        <span className="dim" data-testid="sb-status">{pending > 0 ? `正在生成缩略图… 剩余 ${pending}` : '缩略图已就绪'}</span>
        <span className="grow" />
        {cards.length > 1 ? (
          <span className="sb-batch" data-testid="sb-batch">
            <span className="dim">已选 {cards.length} 张 · 批量</span>
            <select value="" aria-label="批量景别" data-testid="sb-batch-shot" onChange={(e) => e.target.value && batchShot(e.target.value as Beat['shot']['type'])}>
              <option value="">景别…</option>
              {SHOT_TYPES.map((t) => <option key={t} value={t}>{SHOT_LABEL[t]}</option>)}
            </select>
            <select value="" aria-label="批量切入方式" data-testid="sb-batch-cutin" onChange={(e) => e.target.value && batch('批量修改切入方式', (b) => void (b.cutIn = e.target.value as Beat['cutIn']))}>
              <option value="">切入…</option><option value="cut">硬切</option><option value="dip_black">黑场眨眼</option>
            </select>
            <button className="btn-s" onClick={() => set({ cards: [] })}>取消选择</button>
          </span>
        ) : (
          <span className="dim">Ctrl / Shift 点击多选后可批量修改 · 拖动卡片重排 · 双击回到预览</span>
        )}
      </div>
      <div className="sb-scroll">
        {project.scenes.map((s, si) => {
          const cScene = host.compiled?.scenes.find((x) => x.id === s.id);
          return (
            <section key={s.id} className="sb-scene" data-testid={`sb-scene-${s.id}`}>
              <header className="sb-scene-head">
                <span className="o-n">{si + 1}</span>
                <strong>{s.title}</strong>
                <label className="inline">转场
                  <select value={s.transitionIn.kind} data-testid={`sb-trans-${s.id}`} onChange={(e) => editScene(s.id, '修改转场', (x) => void (x.transitionIn.kind = e.target.value as typeof x.transitionIn.kind))}>
                    {Object.entries(TRANSITION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <span className="dim mono">{cScene ? `${(cScene.end - cScene.start).toFixed(1)}s` : ''}</span>
              </header>
              <div className="sb-grid">
                {s.beats.map((b, bi) => {
                  const cb = cScene?.beats.find((x) => x.id === b.id);
                  const url = cScene ? cachedThumb(cScene, b.id) : undefined;
                  const sel = cards.includes(b.id) || selection.beatId === b.id;
                  const type = cb?.shotType ?? b.shot.type;
                  return (
                    <article
                      key={b.id}
                      className={`sb-card${sel ? ' sel' : ''}${dragging === b.id ? ' dragging' : ''}${over === b.id && dragging && dragging !== b.id ? ' drop' : ''}`}
                      data-testid={`sb-card-${b.id}`}
                      draggable
                      onDragStart={(e) => { e.dataTransfer.setData('text/beat', b.id); e.dataTransfer.effectAllowed = 'move'; setDragging(b.id); }}
                      onDragEnd={() => { setDragging(null); setOver(null); }}
                      onDragOver={(e) => { if (dragging && s.beats.some((x) => x.id === dragging)) { e.preventDefault(); setOver(b.id); } }}
                      onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/beat') || dragging; setDragging(null); setOver(null); if (id && id !== b.id) reorderBeat(s.id, id, bi); }}
                      onClick={(e) => pick(s.id, b.id, e)}
                      onDoubleClick={() => set({ centerView: 'preview' })}
                    >
                      <div className="sb-thumb">
                        {url ? <img src={url} alt={`第 ${bi + 1} 句的画面`} draggable={false} data-testid={`sb-thumb-${b.id}`} /> : <span className="sb-wait" data-testid={`sb-wait-${b.id}`}>{active ? '生成中…' : ''}</span>}
                        <span className="sb-n">{bi + 1}</span>
                        <span className="sb-badges">
                          <span className="badge shot" data-testid={`sb-shot-${b.id}`}>{SHOT_SHORT[type] ?? type}</span>
                          {cb && <span className="badge" title="景深等级">景深 {cb.dof}</span>}
                          {cb && cScene && (() => {
                            const seg = cScene.bgSegments.find((g, i) => i > 0 && g.start >= cb.start - 1e-6 && g.start < cb.end - 1e-6);
                            return seg ? <span className="badge bgsw" title={`从这句起换背景：${bgName(seg.assetId)}`} data-testid={`sb-bg-${b.id}`}>🖼 {bgName(seg.assetId).slice(0, 8)}</span> : null;
                          })()}
                          {cb?.shotHeld && <span className="badge held" title="沿用上一机位">⏸</span>}
                          {b.cutIn === 'dip_black' && <span className="badge dip" title="黑场眨眼切入">◆</span>}
                          {b.meta.locked && <span className="badge" title="已锁定"><LockIcon locked /></span>}
                        </span>
                        <span className="sb-dur mono">{cb ? (cb.end - cb.start).toFixed(1) : '—'}s</span>
                        <div className="sb-actions" onClick={(e) => e.stopPropagation()}>
                        <button className="icon-btn" title="在此镜头后插入" aria-label="插入镜头" data-testid={`sb-add-${b.id}`} onClick={() => addBeatAfter(s.id, b.id)}>＋</button>
                        <button className="icon-btn" title="复制镜头" aria-label="复制镜头" onClick={() => copyBeat(s.id, b.id)}>⧉</button>
                        <button className="icon-btn danger" title="删除镜头（可撤销）" aria-label="删除镜头" data-testid={`sb-del-${b.id}`} onClick={() => deleteBeat(s.id, b.id)}>✕</button>
                      </div>
                      </div>
                      <div className="sb-text"><span className="sb-who">{b.speakerId ? name(b.speakerId) : BEAT_KIND_LABEL[b.kind] ?? b.kind}</span>{b.text || '—'}</div>
                      <div className="sb-ctl" onClick={(e) => e.stopPropagation()}>
                        <select value={b.shot.type} aria-label="景别" data-testid={`sb-type-${b.id}`} onChange={(e) => editShot(s.id, b.id, '修改景别', (sh) => void (sh.type = e.target.value as Beat['shot']['type']))}>
                          {((SHOT_TYPES as readonly string[]).includes(b.shot.type) ? [...SHOT_TYPES] : [b.shot.type, ...SHOT_TYPES]).map((t) => <option key={t} value={t}>{SHOT_LABEL[t]}</option>)}
                        </select>
                        <select value={b.cutIn} aria-label="切入方式" data-testid={`sb-cutin-${b.id}`} onChange={(e) => editBeat(s.id, b.id, '修改切入方式', (x) => void (x.cutIn = e.target.value as Beat['cutIn']))}>
                          <option value="cut">硬切</option><option value="dip_black">黑场</option>
                        </select>
                      </div>
                      <div className="sb-focus" onClick={(e) => e.stopPropagation()}>
                        {Object.keys(s.wardrobe).map((id) => (
                          <label key={id} className="chip check" title="镜头焦点">
                            <input type="checkbox" checked={b.shot.focus.includes(id)} onChange={(e) => editShot(s.id, b.id, '修改镜头焦点', (sh) => void (sh.focus = e.target.checked ? [...sh.focus, id] : sh.focus.filter((x) => x !== id)))} />
                            {name(id)}
                          </label>
                        ))}
                      </div>

                    </article>
                  );
                })}
                <button className="sb-card sb-new" onClick={() => addBeatAfter(s.id, s.beats.at(-1)?.id ?? null)} data-testid={`sb-new-${s.id}`}>＋ 插入镜头</button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
