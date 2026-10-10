/** Script editor: scenes and lines. Select a line to edit it in place; drag lines to reorder; add / copy / delete with undo. */
import { useState, type RefObject } from 'react';
import type { CompactCatalog } from '@shared/schema/assets';
import type { Beat } from '@shared/schema/project';
import type { CompiledProject } from '@shared/timeline/types';
import type { Player } from '../../engine/Player';
import { addBeatAfter, addSceneAfter, copyBeat, deleteBeat, deleteScene, editBeat, editScene, reorderBeat, reorderScene } from '../../store/actions';
import { useProject } from '../../store/projectStore';
import { useUi } from '../../store/uiStore';
import { defaultModelOf } from '../castModel';
import { LockIcon } from '../ui';

const KIND_LABEL: Record<Beat['kind'], string> = { dialogue: '对白', narration: '旁白', action: '动作', pause: '停顿', establishing: '空镜', silent: '无声', empty: '空景' };
const KINDS = Object.keys(KIND_LABEL) as Beat['kind'][];

export function Outline({ seek, playerRef, compiled, catalog }: { seek: (t: number) => void; playerRef: RefObject<Player | null>; compiled: CompiledProject | null; catalog: CompactCatalog | null }) {
  const project = useProject((s) => s.project);
  const selection = useProject((s) => s.selection);
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  if (!project) return null;
  const go = (sceneId: string, beatId: string | null) => {
    useProject.getState().select({ sceneId, beatId });
    useUi.getState().set({ inspectorTab: beatId ? 'beat' : 'scene' });
    const sc = playerRef.current?.compiled.scenes.find((s) => s.id === sceneId);
    const t = beatId ? (sc?.beats.find((b) => b.id === beatId)?.start ?? -1) + 0.01 : sc ? sc.start + 0.01 : undefined;
    if (t !== undefined) seek(t);
  };
  const modelOf = (castId: string) => defaultModelOf(catalog, project, castId);
  const addScene = (after: string | null) => {
    const bg = project.scenes.at(-1)?.background.assetId ?? catalog?.backgrounds[0]?.id;
    if (!bg) return;
    const id = addSceneAfter(after, bg, modelOf);
    if (id) useUi.getState().set({ inspectorTab: 'scene' });
  };

  return (
    <div className="script" data-testid="script-editor">
      {project.scenes.length === 0 ? (
        <div className="empty-state" data-testid="outline-empty">
          <p className="empty-title">这个项目还没有场景</p>
          <p className="hint">先在右侧“项目”标签里添加角色，再添加场景；也可以基于示例创建。</p>
          <button className="btn primary" disabled={!catalog} onClick={() => addScene(null)} data-testid="btn-add-scene">＋ 添加场景</button>
        </div>
      ) : (
        <ol className="outline" data-testid="outline">
          {project.scenes.map((s, i) => (
            <li key={s.id}>
              <div className={`o-scene${selection.sceneId === s.id && !selection.beatId ? ' sel' : ''}`}>
                <button className="o-scene-main" onClick={() => go(s.id, null)} data-testid={`outline-scene-${s.id}`}>
                  <span className="o-n">{i + 1}</span>
                  <span className="o-title">{s.title}</span>
                </button>
                <span className="o-tools">
                  <button className="icon-btn" title="上移场景" aria-label="上移场景" disabled={i === 0} onClick={() => reorderScene(s.id, i - 1)}>↑</button>
                  <button className="icon-btn" title="下移场景" aria-label="下移场景" disabled={i === project.scenes.length - 1} onClick={() => reorderScene(s.id, i + 1)}>↓</button>
                  <button className="icon-btn" title="在此场景后添加场景" aria-label="添加场景" disabled={!catalog} onClick={() => addScene(s.id)} data-testid={`btn-add-scene-after-${s.id}`}>＋</button>
                  <button className="icon-btn danger" title="删除场景（可撤销）" aria-label="删除场景" onClick={() => deleteScene(s.id)} data-testid={`btn-del-scene-${s.id}`}>✕</button>
                </span>
              </div>
              <ul>
                {s.beats.map((b, bi) => {
                  const held = compiled?.scenes.find((x) => x.id === s.id)?.beats.find((x) => x.id === b.id)?.shotHeld;
                  const who = project.cast.find((c) => c.id === b.speakerId)?.displayName;
                  const sel = selection.beatId === b.id;
                  return (
                    <li
                      key={b.id}
                      className={`o-item${over === b.id && dragging && dragging !== b.id ? ' drop' : ''}${dragging === b.id ? ' dragging' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/beat', b.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragging(b.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onDragOver={(e) => {
                        if (dragging && s.beats.some((x) => x.id === dragging)) {
                          e.preventDefault();
                          setOver(b.id);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const id = e.dataTransfer.getData('text/beat') || dragging;
                        setDragging(null);
                        setOver(null);
                        if (id && id !== b.id) reorderBeat(s.id, id, bi);
                      }}
                      data-testid={`outline-item-${b.id}`}
                    >
                      <button className={`o-beat${sel ? ' sel' : ''}`} onClick={() => go(s.id, b.id)} data-testid={`outline-beat-${b.id}`}>
                        <span className="o-grip" aria-hidden>⋮⋮</span>
                        <span className="o-who">{b.kind === 'pause' ? '停顿' : (who ?? (b.kind === 'dialogue' ? '—' : KIND_LABEL[b.kind]))}</span>
                        <span className="o-text">{b.text || '—'}</span>
                        {b.meta.locked && <span className="o-held" title="已锁定"><LockIcon locked /></span>}
                        {held && <span className="o-held" title="沿用上一机位（取景相同或最短镜头规则）" data-testid={`outline-held-${b.id}`}>⏸</span>}
                      </button>
                      {sel && (
                        <div className="o-edit" data-testid="beat-editor">
                          <div className="o-edit-row">
                            <select value={b.speakerId ?? ''} aria-label="说话人" data-testid="script-speaker" onChange={(e) => editBeat(s.id, b.id, '修改说话人', (x) => { if (e.target.value) x.speakerId = e.target.value; else delete x.speakerId; })}>
                              <option value="">（无说话人）</option>
                              {Object.keys(s.wardrobe).map((id) => <option key={id} value={id}>{project.cast.find((c) => c.id === id)?.displayName ?? id}</option>)}
                            </select>
                            <select value={b.kind} aria-label="类型" data-testid="script-kind" onChange={(e) => editBeat(s.id, b.id, '修改类型', (x) => void (x.kind = e.target.value as Beat['kind']))}>
                              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                            </select>
                            <select value={b.duration.mode} aria-label="时长模式" data-testid="script-dur-mode" onChange={(e) => editBeat(s.id, b.id, '修改时长模式', (x) => { x.duration.mode = e.target.value as 'auto' | 'fixed'; if (x.duration.mode === 'fixed' && x.duration.seconds <= 0) x.duration.seconds = 3; })}>
                              <option value="auto">时长 自动</option>
                              <option value="fixed">时长 固定</option>
                            </select>
                          </div>
                          <textarea className="area" rows={3} value={b.text} aria-label="台词文本" data-testid="script-text" onChange={(e) => editBeat(s.id, b.id, '修改台词', (x) => void (x.text = e.target.value), 'text')} onBlur={() => useProject.getState().seal()} />
                          <div className="o-edit-row">
                            <button className="btn-s" onClick={() => addBeatAfter(s.id, b.id)} data-testid="script-add-beat">＋ 下方添加</button>
                            <button className="btn-s" onClick={() => copyBeat(s.id, b.id)} data-testid="script-copy-beat">复制</button>
                            <button className="btn-s" disabled={bi === 0} onClick={() => reorderBeat(s.id, b.id, bi - 1)}>上移</button>
                            <button className="btn-s" disabled={bi === s.beats.length - 1} onClick={() => reorderBeat(s.id, b.id, bi + 1)}>下移</button>
                            <button className="btn-s danger" onClick={() => deleteBeat(s.id, b.id)} data-testid="script-del-beat">删除</button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
                <li>
                  <button className="o-add" onClick={() => addBeatAfter(s.id, s.beats.at(-1)?.id ?? null)} data-testid={`btn-add-beat-${s.id}`}>＋ 添加台词</button>
                </li>
              </ul>
              {selection.sceneId === s.id && (
                <input className="o-title-edit text" value={s.title} aria-label="场景标题" data-testid={`outline-title-${s.id}`} onChange={(e) => editScene(s.id, '修改场景标题', (x) => void (x.title = e.target.value), 'title')} onBlur={() => useProject.getState().seal()} />
              )}
            </li>
          ))}
          <li className="o-foot"><button className="btn" onClick={() => addScene(selection.sceneId)} disabled={!catalog} data-testid="btn-add-scene">＋ 添加场景</button></li>
        </ol>
      )}
    </div>
  );
}
