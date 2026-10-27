/**
 * The assistant's long-term memory in the UI (experimental): the manager (switch, list, edit, delete, on/off, kind, scope), the memory cards
 * in the chat (saved / updated / forgotten / 「要记住吗？」 proposals) and the 「本次参考了 N 条偏好」 line of the director dialogs.
 */
import { useEffect, useState } from 'react';
import { MEMORY_KINDS, MEMORY_KIND_LABEL, directorMemories, type Memory, type MemoryEvent, type MemoryKind, type MemoryScope } from '@shared/agent/memory';
import { fetchMemories, useMemories } from '../../memoryApi';

export const EXPERIMENTAL_TIP = '实验性功能：效果可能不稳定，可随时关闭';
export function ExperimentalBadge() {
  return <span className="agent-tag exp" title={EXPERIMENTAL_TIP} data-testid="memory-exp">实验性</span>;
}

const scopeLabel = (m: Pick<Memory, 'scope' | 'castName' | 'castId'>) => (m.scope === 'global' ? '全局' : m.castId ? `本项目 · ${m.castName ?? m.castId}` : '本项目');

function KindSelect({ value, onChange, testId }: { value: MemoryKind; onChange: (k: MemoryKind) => void; testId?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as MemoryKind)} data-testid={testId} title="镜头 / 特效 / 站位表演 / 节奏 会给 AI 导演参考；其他 只给助手">
      {MEMORY_KINDS.map((k) => <option key={k} value={k}>{MEMORY_KIND_LABEL[k]}</option>)}
    </select>
  );
}
function ScopeSelect({ value, onChange, testId }: { value: MemoryScope; onChange: (s: MemoryScope) => void; testId?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as MemoryScope)} data-testid={testId}>
      <option value="project">本项目</option>
      <option value="global">全局</option>
    </select>
  );
}

function MemoryRow({ m, projectId }: { m: Memory; projectId: string }) {
  const st = useMemories.getState();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  const save = () => { const t = text.trim(); if (t && t !== m.text) void st.patch(m.id, { text: t }); setEditing(false); };
  return (
    <div className={`memory-row${m.enabled ? '' : ' off'}`} data-testid="memory-row" data-id={m.id}>
      <input type="checkbox" checked={m.enabled} aria-label="启用这条记忆" title={m.enabled ? '启用中（点一下关掉）' : '已关闭'} data-testid="memory-toggle" onChange={(e) => void st.patch(m.id, { enabled: e.target.checked })} />
      <div className="memory-body">
        {editing
          ? <input className="memory-edit" value={text} autoFocus maxLength={300} data-testid="memory-edit" onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setText(m.text); setEditing(false); } }} />
          : <span className="memory-text" title="双击编辑" data-testid="memory-text" onDoubleClick={() => { setText(m.text); setEditing(true); }}>{m.text}</span>}
        <div className="memory-meta">
          <KindSelect value={m.kind} onChange={(k) => void st.patch(m.id, { kind: k })} testId="memory-kind" />
          <ScopeSelect value={m.scope} onChange={(s) => void st.patch(m.id, s === 'project' ? { scope: s, projectId } : { scope: s })} testId="memory-scope" />
          {m.castId && <span className="hint">只针对 {m.castName ?? m.castId}</span>}
          <span className="hint">{m.origin === 'stated' ? 'AI 按你的话记下' : m.origin === 'confirmed' ? '你确认的建议' : '手动添加'}</span>
          <span className="grow" />
          <button className="btn-s" data-testid="memory-edit-btn" onClick={() => { setText(m.text); setEditing(true); }}>编辑</button>
          <button className="btn-s" data-testid="memory-delete" onClick={() => void st.remove(m.id)}>删除</button>
        </div>
      </div>
    </div>
  );
}

/** The memory manager (opened from the assistant panel). With the system switched off only the switch is shown. */
export function MemoryManager({ projectId }: { projectId: string }) {
  const { memories, enabled, loaded } = useMemories();
  const st = useMemories.getState();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<MemoryKind>('camera');
  const [scope, setScope] = useState<MemoryScope>('global');
  useEffect(() => { void useMemories.getState().load(projectId); }, [projectId]);
  const add = () => {
    const t = text.trim();
    if (!t) return;
    void st.add({ text: t, kind, scope, origin: 'manual', ...(scope === 'project' ? { projectId } : {}) });
    setText('');
  };
  const proj = memories.filter((m) => m.scope === 'project');
  const glob = memories.filter((m) => m.scope === 'global');
  return (
    <div className="memory-manager" data-testid="memory-manager">
      <div className="memory-head">
        <strong>长期记忆</strong>
        <ExperimentalBadge />
        <span className="grow" />
        <label className="chk" title={`${EXPERIMENTAL_TIP}。关闭后助手不再读取、保存记忆，AI 导演也不参考（已存的记忆保留）。`}>
          <input type="checkbox" checked={enabled} data-testid="memory-enabled" onChange={(e) => void st.setEnabled(e.target.checked)} /> 启用记忆
        </label>
      </div>
      {!enabled ? <p className="hint">记忆已关闭：助手不会读取或保存偏好，AI 导演也不参考。</p> : (
        <>
          <p className="hint">助手会记住你说「记住 / 以后 / 一律…」的演出偏好，跨对话生效；当前指令优先于记忆，本项目的优先于全局的。镜头、特效、站位表演、节奏类的偏好也会给 AI 导演生成整场时参考。</p>
          {loaded && memories.length === 0 && <p className="hint" data-testid="memory-empty">还没有记忆。可以对助手说「记住：回忆一律用雾边」，或在下面手动添加。</p>}
          {proj.length > 0 && <div className="memory-section"><div className="hint">本项目</div>{proj.map((m) => <MemoryRow key={`${m.id}:${m.updatedAt}`} m={m} projectId={projectId} />)}</div>}
          {glob.length > 0 && <div className="memory-section"><div className="hint">全局（所有项目）</div>{glob.map((m) => <MemoryRow key={`${m.id}:${m.updatedAt}`} m={m} projectId={projectId} />)}</div>}
          <div className="memory-add">
            <input value={text} maxLength={300} placeholder="新增一条偏好，例如：特写别用太多" data-testid="memory-new" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) add(); }} />
            <KindSelect value={kind} onChange={setKind} testId="memory-new-kind" />
            <ScopeSelect value={scope} onChange={setScope} testId="memory-new-scope" />
            <button className="btn-s" data-testid="memory-add" disabled={!text.trim()} onClick={add}>添加</button>
          </div>
        </>
      )}
    </div>
  );
}

export type MemoryDecision = 'saved' | 'dismissed' | 'removed';

/** Memory events of one assistant turn, as cards: what was saved (with 撤销), and proposals the user confirms or dismisses. */
export function MemoryCards({ events, projectId, decisions, onDecide }: { events: MemoryEvent[]; projectId: string; decisions: Record<number, MemoryDecision>; onDecide: (i: number, d: MemoryDecision) => void }) {
  const st = useMemories.getState();
  if (events.length === 0) return null;
  return (
    <div className="memory-cards" data-testid="memory-cards">
      {events.map((ev, i) => {
        const done = decisions[i];
        if (ev.action === 'proposed') {
          const p = ev.proposal;
          return (
            <div key={i} className="memory-card proposed" data-testid="memory-card" data-action="proposed">
              <div><span className="agent-tag">要记住吗？</span><ExperimentalBadge /><span className="memory-text">{p.text}</span></div>
              <div className="hint">{MEMORY_KIND_LABEL[p.kind]} · {scopeLabel(p)}{p.why ? ` · ${p.why}` : ''}</div>
              {done ? <div className="hint" data-testid="memory-decided">{done === 'saved' ? '已记住' : '没有记住'}</div> : (
                <div className="agent-buttons">
                  <button className="btn-s primary" data-testid="memory-accept" onClick={() => void (async () => {
                    if (p.replaces) { await st.patch(p.replaces, { text: p.text, kind: p.kind }); onDecide(i, 'saved'); return; }
                    const m = await st.add({ text: p.text, kind: p.kind, scope: p.scope, origin: 'confirmed', ...(p.scope === 'project' ? { projectId } : {}), ...(p.castId ? { castId: p.castId, ...(p.castName ? { castName: p.castName } : {}) } : {}) });
                    if (m) onDecide(i, 'saved');
                  })()}>记住</button>
                  <button className="btn-s" data-testid="memory-dismiss" onClick={() => onDecide(i, 'dismissed')}>不用</button>
                </div>
              )}
            </div>
          );
        }
        const m = ev.memory;
        const title = ev.action === 'forgotten' ? '已忘掉' : ev.action === 'updated' ? '已更新记忆' : '已记住';
        return (
          <div key={i} className={`memory-card ${ev.action}`} data-testid="memory-card" data-action={ev.action}>
            <div><span className="agent-tag">{title}</span><ExperimentalBadge /><span className={`memory-text${ev.action === 'forgotten' ? ' del' : ''}`}>{m.text}</span></div>
            <div className="hint">{MEMORY_KIND_LABEL[m.kind]} · {scopeLabel(m)}</div>
            {ev.action === 'saved' && (done === 'removed'
              ? <div className="hint" data-testid="memory-decided">已撤销（没有记住）</div>
              : <div className="agent-buttons"><button className="btn-s" data-testid="memory-undo" onClick={() => void st.remove(m.id).then(() => onDecide(i, 'removed'))}>撤销</button></div>)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The 「本次参考了 N 条偏好」 line of the director dialogs (experimental): the style memories the next generation would read, expandable,
 * and a switch to generate without them (to compare). Nothing is shown when the memory system is off or there are no style memories.
 */
export function DirectorMemoryLine({ projectId, on, setOn, disabled }: { projectId: string | null; on: boolean; setOn: (on: boolean) => void; disabled?: boolean }) {
  // its own copy (the dialog may run for a project the assistant panel is not showing); refreshed when the shared store changes
  const tick = useMemories((s) => s.memories);
  const [got, setGot] = useState<{ enabled: boolean; memories: Memory[] } | null>(null);
  useEffect(() => { let live = true; fetchMemories(projectId).then((r) => { if (live) setGot(r); }, () => {}); return () => { live = false; }; }, [projectId, tick]);
  const enabled = got?.enabled ?? false;
  const use = directorMemories(got?.memories ?? [], projectId);
  if (!enabled || use.length === 0) return null;
  return (
    <div className="director-memory" data-testid="director-memory">
      <label className="chk" title={`${EXPERIMENTAL_TIP}。关掉这一项可以不参考偏好重新生成，用来对比。`}>
        <input type="checkbox" checked={on} disabled={disabled} data-testid="director-memory-on" onChange={(e) => setOn(e.target.checked)} /> 参考我的偏好
      </label>
      <details>
        <summary data-testid="director-memory-count">{on ? `本次参考了 ${use.length} 条偏好` : `不参考偏好（有 ${use.length} 条）`} <ExperimentalBadge /></summary>
        <ul className="director-memory-list">{use.map((m) => <li key={m.id}>{m.text}<span className="hint">（{MEMORY_KIND_LABEL[m.kind]} · {scopeLabel(m)}）</span></li>)}</ul>
      </details>
    </div>
  );
}
