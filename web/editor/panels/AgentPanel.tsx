/**
 * The assistant's part of the AI panel: its change card (one instruction = one card, "AI 说" next to "实际改动", before -> after with the reason,
 * apply all / some / reject, a 「需要你确认」 group for locked or hand-made content) and one conversation turn. Applying is one undo step.
 * The panel itself (header, stream, composer) is `AiPanel.tsx`; the card shell is shared with the generation card (`ai/AiCard.tsx`).
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Change } from '@shared/agent/apply';
import { AGENT_SCOPE_LABEL, scopeOf, type AgentScope } from '@shared/agent/ops';
import { planReplay } from '@shared/agent/replay';
import type { Project } from '@shared/schema/project';
import { VERIFICATION_LINE } from '@shared/agent/verify';
import { useAgent, type CardItem, type RunItem } from '../../store/agentStore';
import { stepIsLive, useProject } from '../../store/projectStore';
import { useUi } from '../../store/uiStore';
import { AiCard } from './ai/AiCard';
import { MemoryCards } from './MemoryPanel';



const SCOPE_ORDER: AgentScope[] = ['camera', 'performance', 'costume', 'staging', 'fx', 'background', 'structure', 'rhythm', 'lock'];

const sceneNo = (project: Project, id: string) => project.scenes.findIndex((s) => s.id === id) + 1;

function titleOf(project: Project, items: CardItem[]): string {
  const recs = items.filter((i) => i.origin === 'applied');
  if (recs.length === 0) return '没有改动';
  const scenes = [...new Set(recs.map((i) => i.record.op.sceneId))];
  const byScope = new Map<string, number>();
  for (const i of recs) byScope.set(AGENT_SCOPE_LABEL[scopeOf(i.record.op)], (byScope.get(AGENT_SCOPE_LABEL[scopeOf(i.record.op)]) ?? 0) + 1);
  return `${scenes.length === 1 ? `第${sceneNo(project, scenes[0]!)}场` : `${scenes.length} 个场景`} · ${recs.length} 项修改（${[...byScope].map(([k, n]) => `${k} ${n}`).join(' · ')}）`;
}

function ChangeLines({ changes }: { changes: Change[] }) {
  const shown = changes.slice(0, 6);
  return (
    <>
      {shown.map((c, i) => (
        <div key={i} className="agent-change">
          <span className="where">{c.where}</span> <span className="field">{c.field}</span>：<span className="del">{c.before}</span> → <span className="add">{c.after}</span>
        </div>
      ))}
      {changes.length > shown.length && <div className="hint">… 另有 {changes.length - shown.length} 处</div>}
    </>
  );
}

/** 「已截图核对 ✓」 line + thumbnails of the frames the assistant looked at after its picture edits; click a thumbnail to enlarge. */
function Verification({ v }: { v: NonNullable<RunItem['proposal']>['verification'] }) {
  const [big, setBig] = useState<number | null>(null);
  useEffect(() => {
    if (big === null) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setBig(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [big]);
  if (!v || v.status === 'none') return null;
  return (
    <div className={`agent-verify ${v.status}`} data-testid="agent-verify" data-status={v.status}>
      <span className="agent-tag">{VERIFICATION_LINE[v.status]}</span>
      {v.frames.length > 0 && (
        <div className="agent-thumbs">
          {v.frames.map((f, i) => <img key={i} src={f.dataUrl} alt={f.label} title={f.label} className="agent-thumb" data-testid="agent-thumb" onClick={() => setBig(i)} />)}
        </div>
      )}
      {big !== null && v.frames[big] && (
        <div className="agent-lightbox" data-testid="agent-lightbox" role="dialog" aria-label={v.frames[big]!.label} onClick={() => setBig(null)}>
          <img src={v.frames[big]!.dataUrl} alt={v.frames[big]!.label} />
          <div>{v.frames[big]!.label}</div>
        </div>
      )}
    </div>
  );
}

/** One batch / script as the card shows it: its label, its items (open ones), and the script text when there is one. */
interface BatchView { id: string; kind: 'batch' | 'script'; label: string; script?: string | undefined; items: CardItem[]; }

function batchesOf(all: CardItem[], open: CardItem[]): BatchView[] {
  const out = new Map<string, BatchView>();
  for (const i of open) {
    const g = i.record.group;
    if (!g) continue;
    (out.get(g.id) ?? out.set(g.id, { id: g.id, kind: g.kind, label: g.label, items: [] }).get(g.id)!).items.push(i);
  }
  for (const i of all) {
    const g = i.record.group;
    if (g?.script && out.has(g.id)) out.get(g.id)!.script = g.script;
  }
  return [...out.values()];
}

interface PendingView extends BatchView { status: 'needs_unlock' | 'needs_confirm'; }
function pendingBatchesOf(pending: CardItem[]): PendingView[] {
  const out = new Map<string, PendingView>();
  for (const i of pending) {
    const g = i.record.group;
    if (!g) continue;
    const status = i.record.status === 'needs_unlock' ? 'needs_unlock' : 'needs_confirm';
    const key = `${g.id}:${status}`;
    (out.get(key) ?? out.set(key, { id: g.id, kind: g.kind, label: g.label, status, items: [] }).get(key)!).items.push(i);
  }
  return [...out.values()];
}

/** A batch / script group: one summary line with a tri-state checkbox, expandable into the per-beat rows (rendered only while open). */
function BatchGroup({ run, batch, renderRow }: { run: RunItem; batch: BatchView; renderRow: (i: CardItem) => ReactElement }) {
  const a = useAgent.getState();
  const [shown, setShown] = useState(false);
  const live = batch.items.filter((i) => i.state !== 'stale');
  const on = live.filter((i) => i.checked).length;
  const scopes = [...new Set(batch.items.map((i) => AGENT_SCOPE_LABEL[scopeOf(i.record.op)]))].join('、');
  return (
    <details className="agent-group agent-batch" data-testid="agent-batch" data-kind={batch.kind} onToggle={(e) => setShown((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <input type="checkbox" aria-label="选择这一组" data-testid="agent-batch-check" disabled={run.rejected || live.length === 0} checked={live.length > 0 && on === live.length}
          ref={(el) => { if (el) el.indeterminate = on > 0 && on < live.length; }}
          onClick={(e) => e.stopPropagation()} onChange={(e) => a.toggleMany(run.id, live.map((i) => i.id), e.target.checked)} />
        <span className="agent-batch-label" data-testid="agent-batch-label">{batch.label}</span>
        <span className="badge" data-testid="agent-batch-count">{batch.items.length} 项</span>
        <span className="hint">{scopes}</span>
        {batch.kind === 'script' && <span className="agent-tag">AI 写的脚本</span>}
      </summary>
      {batch.kind === 'script' && batch.script !== undefined && (
        <details className="agent-script" data-testid="agent-script">
          <summary>AI 写的脚本（点开看源码）</summary>
          <pre data-testid="agent-script-code">{batch.script}</pre>
        </details>
      )}
      {shown && batch.items.map(renderRow)}
    </details>
  );
}

/** The locked / hand-made part of a batch: one block with group-wide buttons, expandable into the single items. */
function PendingBatch({ run, batch, renderPending }: { run: RunItem; batch: PendingView; renderPending: (i: CardItem) => ReactElement }) {
  const a = useAgent.getState();
  const [shown, setShown] = useState(false);
  const ids = batch.items.map((i) => i.id);
  const isLock = batch.status === 'needs_unlock';
  return (
    <details className="agent-pending-batch" data-testid="agent-pending-batch" onToggle={(e) => setShown((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="hint warn">{batch.label}：{batch.items.length} 项{isLock ? '被锁定' : '会覆盖手改'}</span>
      </summary>
      <div className="agent-buttons">
        {isLock ? <button className="btn-s" data-testid="agent-unlock-apply-all" onClick={() => a.applyItems(run.id, ids, { unlock: true })}>全部解锁并应用</button>
          : <button className="btn-s" data-testid="agent-confirm-apply-all" onClick={() => a.applyItems(run.id, ids, { confirm: true })}>全部仍然应用（覆盖手改）</button>}
        <button className="btn-s" data-testid="agent-skip-all" onClick={() => ids.forEach((id) => a.skip(run.id, id))}>全部跳过</button>
      </div>
      {shown && batch.items.map(renderPending)}
    </details>
  );
}

export function AgentCard({ run, project, onFocus }: { run: RunItem; project: Project; onFocus: (sceneId: string, beatId: string | undefined) => void }) {
  const a = useAgent.getState();
  const hover = (beatId: string | undefined) => useUi.getState().set({ hoverBeat: beatId ?? null });
  useEffect(() => () => useUi.getState().set({ hoverBeat: null }), []);
  const p = run.proposal!;
  const open = run.items.filter((i) => i.origin === 'applied' && (i.state === 'open' || i.state === 'stale'));
  const checked = open.filter((i) => i.checked);
  const applied = run.items.filter((i) => i.state === 'applied');
  const pending = run.items.filter((i) => i.origin === 'pending' && (i.state === 'open' || i.state === 'stale'));
  const undoLabel = useProject((s) => s.undoLabel);
  // live view of the items against the project as it is now: a target deleted or locked meanwhile shows as 已失效 / needs confirmation
  // (keyed on which items are still open, not on their checkboxes: a big batch is many ops and must not be re-planned on every tick)
  const openKey = run.items.filter((i) => i.state === 'open' || i.state === 'stale').map((i) => i.id).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plan = useMemo(() => planReplay(project, run.items.filter((i) => i.state === 'open' || i.state === 'stale').map((i) => ({ id: i.id, op: i.record.op })), { genId: 'view', now: 0 }), [project, openKey]);
  const status = new Map(plan.items.map((i) => [i.id, i]));
  const loose = open.filter((i) => !i.record.group);
  const groups = SCOPE_ORDER.map((s) => ({ s, items: loose.filter((i) => scopeOf(i.record.op) === s) })).filter((g) => g.items.length > 0);
  const batches = batchesOf(run.items, open);
  const pendingBatches = pendingBatchesOf(pending);
  const renderPending = (i: CardItem) => {
    const st = status.get(i.id);
    const isLock = i.record.status === 'needs_unlock';
    return (
      <div key={i.id} className="agent-row" data-testid="agent-pending-row" onMouseEnter={() => hover(i.record.changes[0]?.beatId)} onMouseLeave={() => hover(undefined)} onClick={(e) => { if (!(e.target as HTMLElement).closest('input,button')) onFocus(i.record.op.sceneId, i.record.changes[0]?.beatId); }}>
        <div className="agent-row-body">
          <div className="hint warn">{isLock ? `锁定：${i.record.violations.join('、')}` : `会覆盖手改：${i.record.overwrote.join('、')}`}</div>
          <ChangeLines changes={i.record.changes} />
          {st?.status === 'stale' && <div className="hint warn">{st.reason}</div>}
          <div className="agent-buttons">
            {isLock ? <button className="btn-s" data-testid="agent-unlock-apply" onClick={() => a.applyItems(run.id, [i.id], { unlock: true })}>解锁并应用</button>
              : <button className="btn-s" data-testid="agent-confirm-apply" onClick={() => a.applyItems(run.id, [i.id], { confirm: true })}>仍然应用（覆盖手改）</button>}
            <button className="btn-s" data-testid="agent-skip" onClick={() => a.skip(run.id, i.id)}>跳过</button>
          </div>
        </div>
      </div>
    );
  };
  const renderRow = (i: CardItem) => {
    const st = status.get(i.id);
    const stale = i.state === 'stale' || st?.status === 'stale';
    const askNow = st && (st.status === 'needs_unlock' || st.status === 'needs_confirm');
    return (
      <div key={i.id} className={`agent-row${stale ? ' stale' : ''}`} data-testid="agent-row" data-op={i.record.op.op} onMouseEnter={() => hover(i.record.changes[0]?.beatId)} onMouseLeave={() => hover(undefined)} onClick={(e) => { if (!(e.target as HTMLElement).closest('input,button')) onFocus(i.record.op.sceneId, i.record.changes[0]?.beatId); }}>
        <input type="checkbox" checked={i.checked && !stale} disabled={stale || run.rejected} onChange={(e) => a.toggle(run.id, i.id, e.target.checked)} aria-label="选择这一项" />
        <div className="agent-row-body">
          <ChangeLines changes={i.record.changes} />
          {i.record.op.reason && !i.record.group && <div className="hint">理由：{i.record.op.reason}</div>}
          {i.record.warnings.length > 0 && <div className="hint warn">{i.record.warnings.join('；')}</div>}
          {stale && <div className="hint warn" data-testid="agent-stale">{i.reason ?? st?.reason ?? '已失效'}</div>}
          {askNow && <div className="hint warn">{st.reason}（该项会进入“需要你确认”，请逐项处理）</div>}
        </div>
      </div>
    );
  };
  const aiSaid = p.summary || (p.question ? p.question.question : '');
  const actual = run.items.filter((i) => i.origin === 'applied').flatMap((i) => i.record.changes).length;
  const undone = applied.length > 0 && !!run.steps?.length && !run.steps.some(stepIsLive);
  const stateKey = run.rejected ? 'rejected' : undone || (run.wasUndone && applied.length === 0) ? 'undone' : applied.length > 0 ? (open.length > 0 ? 'partial' : 'applied') : open.length > 0 || pending.length > 0 ? 'pending' : 'done';
  const stateText = { rejected: '已拒绝', undone: '已撤销', partial: '部分应用', applied: '已应用', pending: '待确认', done: '' }[stateKey];
  const tone = stateKey === 'applied' ? 'ok' : stateKey === 'pending' || stateKey === 'partial' ? 'warn' : 'hint';
  useProject((s) => s.histRev); // 已应用 reads 已撤销 after Ctrl+Z
  const actions = (
    <>
      {open.length > 0 && !run.rejected && (
        <>
          <button className="btn primary" data-testid="agent-apply-all" onClick={() => a.applyItems(run.id, open.map((i) => i.id))}>应用全部</button>
          <button className="btn" data-testid="agent-apply-sel" disabled={checked.length === 0} onClick={() => a.applyItems(run.id, checked.map((i) => i.id))}>应用所选 ({checked.length})</button>
          <button className="btn" data-testid="agent-reject" onClick={() => a.reject(run.id)}>拒绝</button>
        </>
      )}
      {applied.length > 0 && (
        <span className="ai-applied" data-testid="agent-applied">
          {undone ? `已撤销 ${applied.length} 项` : `已应用 ${applied.length} 项 · Ctrl+Z 撤销`}
          <button className="btn" data-testid="agent-undo-card" disabled={undoLabel !== run.appliedLabel} onClick={() => a.undoRun(run.id)}>撤销这次</button>
        </span>
      )}
    </>
  );
  const hasActions = (open.length > 0 && !run.rejected) || applied.length > 0;
  return (
    <AiCard
      state={stateKey} title={run.items.length === 0 && p.memory?.length ? '长期记忆' : titleOf(project, run.items)} titleTestId="agent-card-title" who="AI"
      stateLabel={stateText || undefined} tone={tone} said={aiSaid || '（没有文字说明）'} saidTestId="agent-said" meta={p.stopped === 'steps' ? '（达到步数上限）' : undefined}
      bodyTestId="agent-card" bodyAttrs={{ 'data-run': String(run.id) }} actions={hasActions ? actions : undefined}
    >
      {run.liveNote && <p className="hint warn" data-testid="agent-live-note">{run.liveNote}</p>}
      {p.claimedWithoutOps && <p className="hint warn" data-testid="agent-claimed">AI 提到但没有执行：{p.claimedWithoutOps}</p>}
      {p.question && (
        <div className="agent-question" data-testid="agent-question">
          <strong>{p.question.question}</strong>
          <div className="agent-options">{p.question.options.map((o) => <button key={o} className="btn-s" data-testid="agent-option" onClick={() => void a.send(o)}>{o}</button>)}</div>
        </div>
      )}
      {p.memory && p.memory.length > 0 && <MemoryCards events={p.memory} projectId={project.id} decisions={run.memoryDone ?? {}} onDecide={(i, d) => a.decideMemory(run.id, i, d)} />}
      <Verification v={p.verification} />
      <div className="agent-actual"><span className="agent-tag">实际改动</span>{actual === 0 ? ' 没有' : ` ${actual} 处`}</div>
      {batches.map((b) => <BatchGroup key={b.id} run={run} batch={b} renderRow={renderRow} />)}
      {groups.map((g) => (
        <details key={g.s} open className="agent-group" data-testid={`agent-group-${g.s}`}>
          <summary>{AGENT_SCOPE_LABEL[g.s]} <span className="badge">{g.items.length}</span></summary>
          {g.items.map(renderRow)}
        </details>
      ))}
      {pending.length > 0 && (
        <div className="agent-confirm" data-testid="agent-pending">
          <div className="agent-tag warn">需要你确认</div>
          {pendingBatches.map((b) => <PendingBatch key={`${b.id}:${b.status}`} run={run} batch={b} renderPending={renderPending} />)}
          {pending.filter((i) => !i.record.group).map(renderPending)}
        </div>
      )}
      {p.pending.length > 0 && pending.length === 0 && <p className="hint">需要确认的项目已处理。</p>}
      {run.rejected && <p className="hint" data-testid="agent-rejected">已拒绝</p>}
    </AiCard>
  );
}

/** One assistant turn of the stream: the 「你」 bubble (with its pictures), progress while it runs, then the change card. */
export function ChatTurn({ run, project, onFocus }: { run: RunItem; project: Project; onFocus: (sceneId: string, beatId: string | undefined) => void }) {
  return (
    <div className="ai-turn" data-testid="ai-turn" data-kind="chat">
      <div className="agent-turn" data-testid="agent-turn">
      <div className="ai-user-wrap">
        <div className="agent-user ai-user-bubble" data-testid="agent-user">{run.instruction}{run.attachments?.length ? <div data-testid="agent-user-attachments">{run.attachments.map((x, i) => <img key={i} src={x.dataUrl} alt={x.label} title={x.label} style={{ height: 40, marginRight: 4, borderRadius: 3 }} />)}</div> : null}</div>
      </div>
      {run.status === 'running' && <div className="agent-progress" data-testid="agent-progress">{run.progress.slice(-4).map((p, i) => <div key={i} className="hint">{p}</div>)}</div>}
      {run.status === 'failed' && <p className="bad" data-testid="agent-error">{run.error}</p>}
      {run.status === 'cancelled' && <p className="hint">已取消</p>}
      {run.status === 'done' && run.proposal && <AgentCard run={run} project={project} onFocus={onFocus} />}
      </div>
    </div>
  );
}

