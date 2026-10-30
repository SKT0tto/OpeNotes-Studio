/**
 * The bottom of the AI panel (never scrolls away): a one-line context (selection, 「实时」, tokens), the suggestion chips (the first one is a
 * generation), the one input box with 附图, the 「生成 ▾」 popover and 发送 / 停止. A typed command that means exactly one generation action
 * goes to generation (see `intent.ts`); everything else is an instruction for the assistant, which needs an AI model.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LIVE_MAX_OPS } from '@shared/agent/live';
import { directorMemories, memoryReviewInstruction } from '@shared/agent/memory';
import { MAX_FRAMES } from '@shared/agent/frames';
import { multiContext, multiIds } from '@shared/agent/selection';
import type { Project } from '@shared/schema/project';
import { filesToAttachments } from '../../../agentMedia';
import { useMemories } from '../../../memoryApi';
import { useAgent } from '../../../store/agentStore';
import { useProject } from '../../../store/projectStore';
import { notify, useUi } from '../../../store/uiStore';
import { isDirectedScene, useDirectorRun, type DirectorEnv } from '../directorRun';
import { EXPERIMENTAL_TIP, ExperimentalBadge } from '../MemoryPanel';
import { noAi, useAiSettings } from './aiSettings';
import { beatTarget } from './generateActions';
import { GeneratePopover } from './GeneratePopover';
import { routeIntent } from './intent';

const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const sceneNo = (project: Project, id: string) => project.scenes.findIndex((s) => s.id === id) + 1;

function suggestions(project: Project, sel: { sceneId: string | null; beatId: string | null }, multi = false): string[] {
  if (multi) return ['这几句镜头推近一点', '这几句加回忆效果', '这几句节奏放慢一点'];
  const scene = project.scenes.find((s) => s.id === sel.sceneId);
  const beat = scene?.beats.find((b) => b.id === sel.beatId);
  if (beat) return ['镜头推近一点', '这一句加回忆效果', '这句节奏放慢一点'];
  if (scene) return ['这一场多用双人镜头，少点特写', '这一场节奏放慢一点', '这一场去掉所有特效'];
  return ['选中一句话后，可以说“这里镜头推近一点”'];
}

export function AiComposer({ env, popoverOpen, setPopoverOpen, onOpenSettings }: { env: DirectorEnv; popoverOpen: boolean; setPopoverOpen: (open: boolean) => void; onOpenSettings: () => void }) {
  const project = useProject((s) => s.project)!;
  const selection = useProject((s) => s.selection);
  const picked = useUi((s) => s.cards);
  const { runs, draft: text, attachments: attach, running, live, session, focusTick } = useAgent();
  const genBusy = useDirectorRun((s) => s.busy);
  const turns = useDirectorRun((s) => s.turns);
  const aiState = useAiSettings();
  const mem = useMemories();
  const a = useAgent.getState();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { void useMemories.getState().load(project.id); }, [project.id]);
  useEffect(() => { input.current?.focus(); }, [focusTick]);
  // one line to start with, growing with what is typed (up to the CSS max-height); the stream keeps the height
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  const styleMemories = mem.enabled ? directorMemories(mem.memories, project.id).length : 0;
  const scene = project.scenes.find((s) => s.id === selection.sceneId);
  const beatIdx = scene?.beats.findIndex((b) => b.id === selection.beatId) ?? -1;
  const multi = multiContext(project, picked);
  const ctxText = multi ?? (scene ? `第${sceneNo(project, scene.id)}场${beatIdx >= 0 ? ` · 第${beatIdx + 1}句` : ''}${selection.castId ? ` · ${project.cast.find((c) => c.id === selection.castId)?.displayName ?? ''}` : ''}` : '整个项目');
  const last = runs.at(-1);
  const without = noAi(aiState);
  const hasText = !!project.source.text;
  const busy = running || genBusy;

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { items, problems } = await filesToAttachments(files, MAX_FRAMES - attach.length);
    if (items.length) a.setAttachments((cur) => [...cur, ...items].slice(0, MAX_FRAMES));
    if (problems.length) notify(problems.join('；'), 'warn');
  };

  /** What a typed sentence means for generation (null: it is for the assistant). */
  const routeOf = (t: string) => routeIntent(t, { sceneCount: project.scenes.length, hasPrevious: turns.some((x) => x.status === 'done' && x.who !== '规则') });
  const runRoute = (t: string): boolean => {
    const r = routeOf(t);
    if (!r || !hasText) return false;
    const d = useDirectorRun.getState();
    const base = { scope: 'scene' as const, onlyBeat: false, overwriteUser: false, userText: t.trim() };
    if (r.kind === 'scene') void d.run(false, base, env);
    else if (r.kind === 'sceneNo') void d.run(false, { ...base, sceneId: project.scenes[r.no - 1]!.id }, env);
    else if (r.kind === 'all') void d.run(true, base, env);
    else {
      const prev = [...turns].reverse().find((x) => x.status === 'done' && x.who !== '规则');
      if (!prev) return false;
      void d.run(prev.all, { ...prev.request, refresh: true, userText: t.trim() }, env);
    }
    return true;
  };
  const submit = (t: string) => {
    const v = t.trim();
    if (!v || busy) return;
    if (attach.length === 0 && routeOf(v) && hasText) {
      a.setDraft('');
      if (runRoute(v)) return;
    }
    if (without) return;
    a.setDraft('');
    const pics = attach;
    a.setAttachments([]);
    void useAgent.getState().send(v, pics);
  };
  const routed = routeOf(text) !== null && hasText && attach.length === 0;
  const canSend = !!text.trim() && !busy && (routed || !without);
  const reason = without && !routed && text.trim() ? '改写需要 AI 模型：先到「AI 设置」配置，或用「生成 ▾ → 规则生成」' : '';

  // the first chip is a generation: the scene (「生成」 / 「重新生成」) or, with several lines picked, those lines
  const multiPick = multiIds(project, picked);
  const beats = multiPick.length >= 2 ? beatTarget(project, selection, picked) : null;
  const genChip = !hasText || !scene ? null : beats && beats.beatIds.length >= 2 ? `重做选中的 ${beats.beatIds.length} 句` : isDirectedScene(scene) ? '重新生成这一场' : '生成这一场';
  const runChip = () => {
    const d = useDirectorRun.getState();
    if (beats && beats.beatIds.length >= 2) void d.run(false, { sceneId: beats.sceneId, beatIds: beats.beatIds }, env);
    else void d.run(false, { onlyBeat: false }, env);
  };
  const chips = without ? [] : suggestions(project, selection, !!multi);

  return (
    <div className="ai-composer" data-testid="ai-composer">
      {popoverOpen && <GeneratePopover env={env} onClose={() => setPopoverOpen(false)} onOpenSettings={onOpenSettings} />}
      <div className="ai-context">
        <span className="hint" data-testid="agent-context" title="指令里的“这里 / 这一句”指这个选区；多选时“这几句 / 这段 / 选中的”指选中的句子">选区：{ctxText}</span>
        <label className="chk" title={`打开后，只改当前场景、不超过 ${LIVE_MAX_OPS} 项、不含进出场 / 背景 / 锁的小改动会自动应用（可撤销）`}>
          <input type="checkbox" checked={live} onChange={(e) => a.setLive(e.target.checked)} data-testid="agent-live" /> 实时
        </label>
        <span className="hint" data-testid="agent-cost" title="本条指令的 token 用量 / 本次会话累计（含缓存命中）">
          本条 {fmt((last?.usage.inputTokens ?? 0) + (last?.usage.outputTokens ?? 0))} · 本次共 {fmt(session.inputTokens + session.outputTokens)} tokens
        </span>
      </div>
      <div className="agent-suggest" data-testid="ai-chips">
        {genChip && <button className="btn-s accent" disabled={busy || !hasText || aiState.loading || !!aiState.error} onClick={runChip} data-testid="ai-suggest-gen">{genChip}</button>}
        {chips.map((s) => <button key={s} className="btn-s" disabled={busy || !scene} onClick={() => submit(s)}>{s}</button>)}
        {!without && scene && styleMemories > 0 && (
          <button className="btn-s" data-testid="agent-review-memory" disabled={busy} title={`让 AI 按你保存的 ${styleMemories} 条风格偏好检查这一场，只改明显违反的地方（每处都是普通的变更卡片，可勾选、可撤销）。${EXPERIMENTAL_TIP}`} onClick={() => submit(memoryReviewInstruction(sceneNo(project, scene.id)))}>
            按偏好检查本场 <ExperimentalBadge />
          </button>
        )}
      </div>
      {attach.length > 0 && (
        <div className="agent-attachments" data-testid="agent-attachments">
          {attach.map((x, i) => (
            <span key={i} className="agent-attachment" title={x.label}>
              <img src={x.dataUrl} alt={x.label} />
              <button className="btn-s" data-testid="agent-attachment-remove" aria-label={`移除${x.label}`} onClick={() => a.setAttachments((cur) => cur.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className={`agent-input${dragging ? ' drop' : ''}`} data-testid="agent-dropzone"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); void addFiles([...e.dataTransfer.files]); } }}>
        <input ref={fileInput} type="file" accept="image/*,video/*" multiple hidden data-testid="agent-attach-input" onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        <textarea ref={input} value={text} rows={1} data-testid="agent-input"
          placeholder={without ? '未配置 AI：可输入「生成这一场」「生成全部场景」' : '对 AI 说点什么…（Enter 发送，Shift+Enter 换行）'}
          onPaste={(e) => { const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); void addFiles(files); } }}
          onChange={(e) => a.setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(text); } }} />
      </div>
      <div className="ai-buttons-row">
        <button className="btn-s" data-testid="agent-attach" title={`附上截图或短视频（拖进来、粘贴也可以；最多 ${MAX_FRAMES} 张，视频取几帧）`} disabled={running || attach.length >= MAX_FRAMES} onClick={() => fileInput.current?.click()}>附图</button>
        <button className={`btn-s${popoverOpen ? ' on' : ''}`} aria-expanded={popoverOpen} data-testid="ai-gen-chip" onClick={() => setPopoverOpen(!popoverOpen)} title="生成：重新生成场景的演出，先看差异再应用">生成 ▾</button>
        <span className="grow" />
        {genBusy ? <button className="btn danger" data-testid="ai-cancel" onClick={() => useDirectorRun.getState().cancel()}>停止</button>
          : running ? <button className="btn" data-testid="agent-stop" onClick={() => a.cancel()}>停止</button>
            : <button className="btn primary" data-testid="agent-send" disabled={!canSend} title={reason || undefined} onClick={() => submit(text)}>发送</button>}
      </div>
      {reason && <p className="hint ai-reason" data-testid="ai-send-reason">{reason}</p>}
    </div>
  );
}
