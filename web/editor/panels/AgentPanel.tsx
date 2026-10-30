/**
 * 「AI 助手」: talk to the project. One instruction = one change card ("AI 说" next to "实际改动", before -> after with the reason, apply all / some /
 * reject, a 「需要你确认」 group for locked or hand-made content). Applying is one undo step. The 「实时」 switch applies small safe change sets by itself.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { Change } from '@shared/agent/apply';
import { AGENT_SCOPE_LABEL, scopeOf, type AgentScope } from '@shared/agent/ops';
import { LIVE_MAX_OPS } from '@shared/agent/live';
import { multiContext } from '@shared/agent/selection';
import { planReplay } from '@shared/agent/replay';
import type { Project } from '@shared/schema/project';
import { MAX_FRAMES } from '@shared/agent/frames';
import { VERIFICATION_LINE } from '@shared/agent/verify';
import { filesToAttachments } from '../../agentMedia';
import { interleave } from '../../store/agentNotes';
import { useAgent, type AgentAttachment, type CardItem, type RunItem } from '../../store/agentStore';
import { notify } from '../../store/uiStore';
import { useProject } from '../../store/projectStore';
import { useUi } from '../../store/uiStore';
import { directorMemories, memoryReviewInstruction } from '@shared/agent/memory';
import { useMemories } from '../../memoryApi';
import { EXPERIMENTAL_TIP, ExperimentalBadge, MemoryCards, MemoryManager } from './MemoryPanel';



const SCOPE_ORDER: AgentScope[] = ['camera', 'performance', 'costume', 'staging', 'fx', 'background', 'structure', 'rhythm', 'lock'];
const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function suggestions(project: Project, sel: { sceneId: string | null; beatId: string | null }, multi = false): string[] {
  if (multi) return ['这几句镜头推近一点', '这几句加回忆效果', '这几句节奏放慢一点'];
  const scene = project.scenes.find((s) => s.id === sel.sceneId);
  const beat = scene?.beats.find((b) => b.id === sel.beatId);
  if (beat) return ['镜头推近一点', '这一句加回忆效果', '这句节奏放慢一点'];
  if (scene) return ['这一场多用双人镜头，少点特写', '这一场节奏放慢一点', '这一场去掉所有特效'];
  return ['选中一句话后，可以说“这里镜头推近一点”'];
}

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

function Card({ run, project, onFocus }: { run: RunItem; project: Project; onFocus: (sceneId: string, beatId: string | undefined) => void }) {
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
  return (
    <div className="agent-card" data-testid="agent-card" data-run={run.id}>
      <div className="agent-card-head">
        <strong data-testid="agent-card-title">{run.items.length === 0 && p.memory?.length ? '长期记忆' : titleOf(project, run.items)}</strong>
        <span className="hint">{p.stopped === 'steps' ? '（达到步数上限）' : ''}</span>
      </div>
      {run.liveNote && <p className="hint warn" data-testid="agent-live-note">{run.liveNote}</p>}
      <div className="agent-said" data-testid="agent-said"><span className="agent-tag">AI 说</span>{aiSaid || '（没有文字说明）'}</div>
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
      {open.length > 0 && !run.rejected && (
        <div className="agent-buttons">
          <button className="btn primary" data-testid="agent-apply-all" onClick={() => a.applyItems(run.id, open.map((i) => i.id))}>全部应用</button>
          <button className="btn" data-testid="agent-apply-sel" disabled={checked.length === 0} onClick={() => a.applyItems(run.id, checked.map((i) => i.id))}>应用所选 ({checked.length})</button>
          <button className="btn" data-testid="agent-reject" onClick={() => a.reject(run.id)}>拒绝</button>
        </div>
      )}
      {applied.length > 0 && (
        <div className="agent-applied" data-testid="agent-applied">
          已应用 {applied.length} 项 · Ctrl+Z 撤销
          <button className="btn-s" data-testid="agent-undo-card" disabled={undoLabel !== run.appliedLabel} onClick={() => a.undoRun(run.id)}>撤销这次</button>
        </div>
      )}
      {run.rejected && <p className="hint" data-testid="agent-rejected">已拒绝</p>}
    </div>
  );
}

export function AgentPanel({ onFocusBeat }: { onFocusBeat: (sceneId: string, beatId: string | undefined) => void }) {
  const project = useProject((s) => s.project)!;
  const selection = useProject((s) => s.selection);
  const hoverBeat = useUi((st) => st.hoverBeat);
  const cards = useUi((st) => st.cards);
  const { runs, notes, draft: text, running, live, session, snapshot, focusTick } = useAgent();
  const a = useAgent.getState();
  const setText = a.setDraft; // the draft lives in the store: another dock tab in front unmounts this panel, and what was typed must stay
  // pictures / video frames for the next instruction (attach button, drop on the input, paste)
  const [attach, setAttach] = useState<AgentAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const mem = useMemories();
  useEffect(() => { void useMemories.getState().load(project.id); }, [project.id]);
  const styleMemories = mem.enabled ? directorMemories(mem.memories, project.id).length : 0;
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { items, problems } = await filesToAttachments(files, MAX_FRAMES - attach.length);
    if (items.length) setAttach((cur) => [...cur, ...items].slice(0, MAX_FRAMES));
    if (problems.length) notify(problems.join('；'), 'warn');
  };
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { useAgent.getState().bindProject(project.id); }, [project.id]);
  useEffect(() => { input.current?.focus(); }, [focusTick]);
  const tailKey = `${runs.length}:${notes.length}:${runs.at(-1)?.progress.length ?? 0}:${runs.at(-1)?.status ?? ''}`;
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [tailKey]);
  const scene = project.scenes.find((s) => s.id === selection.sceneId);
  const beatIdx = scene?.beats.findIndex((b) => b.id === selection.beatId) ?? -1;
  const multi = multiContext(project, cards);
  const ctxText = multi ?? (scene ? `第${sceneNo(project, scene.id)}场${beatIdx >= 0 ? ` · 第${beatIdx + 1}句` : ''}${selection.castId ? ` · ${project.cast.find((c) => c.id === selection.castId)?.displayName ?? ''}` : ''}` : '整个项目');
  const send = (t: string) => {
    const v = t.trim();
    if (!v || running) return;
    setText('');
    const pics = attach;
    setAttach([]);
    void useAgent.getState().send(v, pics);
  };
  const last = runs.at(-1);
  return (
    <div className="agent-panel" data-testid="agent-panel" data-hover-beat={hoverBeat ?? undefined}>
      <div className="agent-top">
        <label className="chk" title={`打开后，只改当前场景、不超过 ${LIVE_MAX_OPS} 项、不含进出场 / 背景 / 锁的小改动会自动应用（可撤销）`}>
          <input type="checkbox" checked={live} onChange={(e) => a.setLive(e.target.checked)} data-testid="agent-live" /> 实时
        </label>
        <span className="hint" data-testid="agent-context" title="指令里的“这里 / 这一句”指这个选区；多选时“这几句 / 这段 / 选中的”指选中的句子">选区：{ctxText}</span>
        <span className="grow" />
        <button className={`btn-s${showMemory ? ' on' : ''}`} data-testid="agent-memory" title={mem.enabled ? `长期记忆（${EXPERIMENTAL_TIP}）` : '长期记忆已关闭'} onClick={() => setShowMemory((v) => !v)}>{showMemory ? '返回对话' : '记忆'}{!showMemory && mem.enabled && mem.memories.some((m) => m.enabled) ? ` ${mem.memories.filter((m) => m.enabled).length}` : ''}</button>
        <span className="hint" data-testid="agent-cost" title="本条指令的 token 用量 / 本次会话累计（含缓存命中）">
          本条 {fmt((last?.usage.inputTokens ?? 0) + (last?.usage.outputTokens ?? 0))} · 本次共 {fmt(session.inputTokens + session.outputTokens)} tokens
        </span>
      </div>
      {showMemory && <MemoryManager projectId={project.id} />}
      <div className="agent-flow" data-testid="agent-flow" hidden={showMemory}>
        {runs.length === 0 && <p className="hint">用一句话指挥 AI 修改当前项目，例如“第二场多用双人，少点特写”“这一句加回忆效果”“让爱音在这里进场”“这句停顿长一点”。每次修改先给你看变更，可勾选应用，Ctrl+Z 一步撤销。整场重新生成请用上面的「生成」。</p>}
        {interleave(runs, notes).map((row) => {
          // what the AI director did (an accepted result, a one-click generation): the assistant knows it, so 「刚生成的第二场…」 works
          if (row.note) return <div key={`note${row.note.id}`} className="agent-note" data-testid="agent-director-note"><span className="agent-tag">AI 导演</span>{row.note.text}</div>;
          const r = row.run!;
          return (
            <div key={r.id} className="agent-turn" data-testid="agent-turn">
              <div className="agent-user" data-testid="agent-user">{r.instruction}{r.attachments?.length ? <div data-testid="agent-user-attachments">{r.attachments.map((x, i) => <img key={i} src={x.dataUrl} alt={x.label} title={x.label} style={{ height: 40, marginRight: 4, borderRadius: 3 }} />)}</div> : null}</div>
              {r.status === 'running' && <div className="agent-progress" data-testid="agent-progress">{r.progress.slice(-4).map((p, i) => <div key={i} className="hint">{p}</div>)}</div>}
              {r.status === 'failed' && <p className="bad" data-testid="agent-error">{r.error}</p>}
              {r.status === 'cancelled' && <p className="hint">已取消</p>}
              {r.status === 'done' && r.proposal && <Card run={r} project={project} onFocus={onFocusBeat} />}
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {snapshot && <div className="agent-snap hint"><button className="btn-s" data-testid="agent-restore" onClick={() => a.restoreSnapshot()}>恢复到 AI 助手开始前</button></div>}
      <div className="agent-suggest">
        {suggestions(project, selection, !!multi).map((s) => <button key={s} className="btn-s" disabled={running || !scene} onClick={() => send(s)}>{s}</button>)}
        {scene && styleMemories > 0 && (
          <button className="btn-s" data-testid="agent-review-memory" disabled={running} title={`让助手按你保存的 ${styleMemories} 条风格偏好检查这一场，只改明显违反的地方（每处都是普通的变更卡片，可勾选、可撤销）。${EXPERIMENTAL_TIP}`} onClick={() => send(memoryReviewInstruction(sceneNo(project, scene.id)))}>
            按偏好检查本场 <ExperimentalBadge />
          </button>
        )}
      </div>
      {attach.length > 0 && (
        <div className="agent-attachments" data-testid="agent-attachments" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '2px 0' }}>
          {attach.map((x, i) => (
            <span key={i} style={{ position: 'relative' }} title={x.label}>
              <img src={x.dataUrl} alt={x.label} style={{ height: 44, borderRadius: 3, display: 'block' }} />
              <button className="btn-s" data-testid="agent-attachment-remove" aria-label={`移除${x.label}`} style={{ position: 'absolute', top: 0, right: 0, padding: '0 4px' }} onClick={() => setAttach((cur) => cur.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className={`agent-input${dragging ? ' drop' : ''}`} data-testid="agent-dropzone" style={dragging ? { outline: '2px dashed var(--accent, #6aa0ff)' } : undefined}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); void addFiles([...e.dataTransfer.files]); } }}>
        <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden data-testid="agent-attach-input" onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <button className="btn-s" data-testid="agent-attach" title={`附上截图或短视频（拖进来、粘贴也可以；最多 ${MAX_FRAMES} 张，视频取几帧）`} disabled={running || attach.length >= MAX_FRAMES} onClick={() => fileInput.current?.click()}>附图</button>
        <textarea ref={input} value={text} rows={2} placeholder="对 AI 说点什么…（Enter 发送，Shift+Enter 换行，Ctrl+K 聚焦；可以拖入或粘贴截图）" data-testid="agent-input"
          onPaste={(e) => { const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); void addFiles(files); } }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }} />
        {running ? <button className="btn" data-testid="agent-stop" onClick={() => a.cancel()}>停止</button> : <button className="btn primary" data-testid="agent-send" disabled={!text.trim()} onClick={() => send(text)}>发送</button>}
      </div>
    </div>
  );
}
