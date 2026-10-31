/**
 * 「检查过长台词」: lists the lines that do not fit the dialogue area (more lines than it has, not expanded), per scene, and offers to cut them.
 * Nothing changes until a button is clicked: 「全部拆分」 is one undo step for the whole project, 「逐场拆分」 one step per scene, and each scene
 * has its own 「拆分本场」. A line can also be left as it is (open it and use 展开显示 in the inspector).
 */
import { useMemo } from 'react';
import { useProject } from '../../store/projectStore';
import { useUi } from '../../store/uiStore';
import { overLongRows, scenesWithLong } from '../longLines';
import { splitLongLines, useSplitRun } from '../longLinesRun';
import { Modal } from '../ui';

export function LongLinesDialog({ sceneId, onClose }: { /** Only this scene (the check was opened from it). */ sceneId?: string; onClose: () => void }) {
  const project = useProject((s) => s.project);
  const run = useSplitRun();
  const rows = useMemo(() => (project ? overLongRows(project, sceneId) : []), [project, sceneId]);
  if (!project) return null;
  const scenes = scenesWithLong(rows);
  const busy = run.busy;
  const go = (ids: string[], oneStep: boolean, target: string) => void splitLongLines({ sceneIds: ids, oneStep, target });
  const show = (sid: string, bid: string) => {
    useProject.getState().select({ sceneId: sid, beatId: bid });
    useUi.getState().set({ inspectorTab: 'beat' });
  };
  return (
    <Modal title={sceneId ? '检查过长台词（本场）' : '检查过长台词'} onClose={onClose} testid="long-lines-dialog" wide>
      {rows.length === 0 ? (
        <p className="hint" data-testid="long-empty">{run.last && run.last.lines > 0 ? `已拆开 ${run.last.lines} 句，现在没有超长的台词了。` : '没有超长的台词：每句都放得下对话框（或已设为展开显示）。'}</p>
      ) : (
        <>
          <p className="hint" data-testid="long-summary">{scenes.length} 个场景里有 {rows.length} 句台词超过对话框的行数，超出的部分在画面上看不到。点击按钮才会改动，改动可以撤销。</p>
          <ul className="long-list" data-testid="long-list">
            {scenes.map((sid) => {
              const mine = rows.filter((r) => r.sceneId === sid);
              const title = project.scenes.find((s) => s.id === sid)?.title ?? sid;
              return (
                <li key={sid} data-testid={`long-scene-${sid}`}>
                  <h4>
                    <span>第 {mine[0]!.sceneNo} 场「{title}」 · {mine.length} 句</span>
                    <button className="btn-s" disabled={busy} onClick={() => go([sid], true, `scene:${sid}`)} data-testid={`long-split-scene-${sid}`}>{busy && run.target === `scene:${sid}` ? '拆分中…' : '拆分本场'}</button>
                  </h4>
                  <ul>
                    {mine.map((r) => (
                      <li key={r.beatId} className="row" data-testid="long-row" data-beat={r.beatId}>
                        <button className="btn-link" onClick={() => show(r.sceneId, r.beatId)} title="在检查器里打开这句">{r.beatNo}</button>
                        <span className="txt" title={r.text}>{r.text}</span>
                        <span className="warn">{r.lines}/{r.max} 行</span>
                        {r.locked && <span className="hint" title="已锁定的句子不会被自动拆分">已锁定</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <div className="long-actions">
            <button className="btn primary" disabled={busy} onClick={() => go(scenes, true, 'all')} data-testid="long-split-all">{busy && run.target === 'all' ? '拆分中…' : `全部拆分（${rows.length} 句 · 一步撤销）`}</button>
            {scenes.length > 1 && <button className="btn" disabled={busy} onClick={() => go(scenes, false, 'all')} data-testid="long-split-each">逐场拆分（每场一步撤销）</button>}
            <button className="btn" onClick={onClose} data-testid="long-close">先不拆</button>
          </div>
        </>
      )}
    </Modal>
  );
}
