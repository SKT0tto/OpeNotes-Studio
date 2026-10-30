/**
 * 「从小说开始」: paste or import a novel (txt / md, UTF-8 or GBK) on the left; on the right is the AI conversation, the first turn of the
 * same one the editor continues. 「先分场看看」 breaks the novel into scenes (a card you can review before the project is created),
 * 「分场并生成全部」 does the whole thing (breakdown -> project -> every scene, 3 at a time, cancellable and resumable). The cards are the
 * editor's `AiCard`; entering the editor hands them over as the first entries of its stream (`store/aiFlow.ts`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { detectChapters, splitParagraphs } from '@shared/director/paragraphs';
import type { CompactCatalog } from '@shared/schema/assets';
import { costumeLabel } from '@shared/catalog/costume';
import { DirectorApiError, type BatchProgress, type BreakdownResponse, type RunInfo } from '../../directorApi';
import { DirectorMemoryLine } from '../panels/MemoryPanel';
import type { Project } from '@shared/schema/project';
import { createProject, loadProject } from '../../projectsApi';
import { useAiFlow } from '../../store/aiFlow';
import { useProject } from '../../store/projectStore';
import { readTextFile, normalizeNovel } from '../../textImport';
import { Modal } from '../ui';
import { AiCard, type CardTone } from '../panels/ai/AiCard';
import { noAi, useAiSettings } from '../panels/ai/aiSettings';
import { UserBubble } from '../panels/ai/GenerateCard';
import { continuityOf, whoLabel } from '../panels/directorRun';
import { applyAndSave, breakdownEntry, generateEntry, isUndirectedScene, runBreakdown, runOneClick, skeletonEntry } from './oneClickRun';
import { SettingsDialog } from './SettingsDialog';

type Engine = 'ai' | 'rule';
type Phase = 'input' | 'review' | 'full';

interface Stats { calls: number; cached: number; inTok: number; outTok: number; repairs: number; ms: number }
const zero = (): Stats => ({ calls: 0, cached: 0, inTok: 0, outTok: 0, repairs: 0, ms: 0 });
const addRuns = (s: Stats, runs: RunInfo[]): Stats => runs.reduce((a, r) => ({
  calls: a.calls + (r.cached ? 0 : 1), cached: a.cached + (r.cached ? 1 : 0), inTok: a.inTok + (r.cached ? 0 : r.usage.inputTokens), outTok: a.outTok + (r.cached ? 0 : r.usage.outputTokens), repairs: a.repairs + (r.repaired ? 1 : 0), ms: a.ms,
}), s);

/** What to do about a failure, by kind. */
export function fixHint(kind: string | undefined): { text: string; settings: boolean } | null {
  switch (kind) {
    case 'auth': return { text: 'API key 无效或未配置 → 打开 AI 设置，重新填写 key 并点「测试连接」', settings: true };
    case 'not_configured': return { text: '尚未配置 AI → 打开 AI 设置填写 key，或把引擎切换为「规则生成（非 AI）」', settings: true };
    case 'network': return { text: '连不上模型服务 → 检查网络、代理或接口地址（AI 设置里的「接口地址」），然后重试', settings: true };
    case 'timeout': return { text: '请求超时 → 稍后重试；本地模型可换更小的模型，或检查服务是否在运行', settings: false };
    case 'rate_limit': return { text: '请求过于频繁或额度不足 → 稍等片刻后重试，或检查账户额度', settings: false };
    case 'truncated': return { text: '模型输出被截断 → 重试；仍失败时把长场景拆短', settings: false };
    case 'repair_failed': case 'invalid_output': return { text: '模型输出不合格且自动修复失败 → 重试，或换用更强的模型 / 规则生成', settings: false };
    default: return null;
  }
}

export function AiBreakdownDialog({ catalog, onClose, onCreated }: { catalog: CompactCatalog | null; onClose: () => void; onCreated: (id: string) => void }) {
  const aiState = useAiSettings();
  const { settings } = aiState;
  const [showSettings, setShowSettings] = useState(false);
  const [engine, setEngine] = useState<Engine>('ai');
  const [useMem, setUseMem] = useState(true);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [fileInfo, setFileInfo] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [busy, setBusy] = useState(false);
  const [error, setErrorText] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | undefined>(undefined);
  const setError = (m: string | null, kind?: string) => {
    setErrorText(m);
    setErrorKind(m === null ? undefined : kind);
  };
  const [asked, setAsked] = useState('');
  const [res, setRes] = useState<BreakdownResponse | null>(null);
  const [ms, setMs] = useState(0);
  // one-click run
  const [stage, setStage] = useState('');
  const [progress, setProgress] = useState<Record<string, BatchProgress>>({});
  const [sceneTotal, setSceneTotal] = useState(0);
  const [stats, setStats] = useState<Stats>(zero());
  const [projectId, setProjectId] = useState<string | null>(null);
  // The generated project lives here (and on the server) until the person opens it: opening it would replace this dialog.
  const [local, setLocal] = useState<Project | null>(null);
  const localRef = useRef<{ project: Project; etag: string } | null>(null);
  const [finishedAt, setFinishedAt] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const ctl = useRef<AbortController | null>(null);
  const t0 = useRef(0);
  const statsRef = useRef<Stats>(zero());

  useEffect(() => { void useAiSettings.getState().load(); }, []);
  const refreshSettings = () => void useAiSettings.getState().load();
  const configured = settings?.status.configured === true;
  // no AI configured: the rule generator is the default (and the only choice)
  const useRule = engine === 'rule' || !configured;
  const firstEngine = useRule ? ('rule' as const) : undefined;
  const who = whoLabel(useRule, settings?.status.provider);
  const withoutAi = noAi(aiState);

  const chapters = useMemo(() => detectChapters(splitParagraphs(text)), [text]);

  const run = async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    setAsked('先分场看看');
    const t = performance.now();
    try {
      setRes(await runBreakdown({ text, title, refresh, engine: firstEngine }));
      setMs(Math.round(performance.now() - t));
      setPhase('review');
    } catch (e) {
      setRes(null);
      setPhase('input');
      setError(e instanceof DirectorApiError ? e.message : (e as Error).message, e instanceof DirectorApiError ? e.kind : undefined);
    } finally {
      setBusy(false);
      refreshSettings();
    }
  };

  /** 「建项目，稍后生成」: the project gets the breakdown's skeleton; the editor opens with the breakdown card and a 「生成全部场景」 card. */
  const create = async () => {
    if (!res) return;
    setBusy(true);
    try {
      const r = await createProject(res.project);
      useAiFlow.getState().queue(r.project.id, [
        breakdownEntry({ who, userText: '先分场看看', scenes: r.project.scenes.map((s) => s.title), cast: r.project.cast.length, warnings: res.warnings.length }),
        skeletonEntry({ who, scenes: r.project.scenes.length }),
      ]);
      useProject.getState().open(r.project, r.etag);
      onCreated(r.project.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  /** Breakdown (once) -> project -> the scenes that are not directed yet. Safe to call again after a cancel or a failure. */
  const full = async () => {
    setPhase('full');
    setBusy(true);
    setError(null);
    setFinishedAt(0);
    if (!projectId) setAsked('分场并生成整部演出');
    ctl.current = new AbortController();
    if (!projectId) {
      statsRef.current = zero();
      t0.current = performance.now();
    }
    const results: Parameters<typeof applyAndSave>[1] = [];
    try {
      const retry = new Set(Object.values(progress).filter((p) => p.state === 'error').map((p) => p.sceneId));
      const out = await runOneClick({ text, title, engine: firstEngine, useMem, local: localRef.current, retry, signal: ctl.current.signal }, {
        onStage: setStage,
        onBreakdown: (bd) => {
          statsRef.current = addRuns(statsRef.current, bd.runs);
          setStats({ ...statsRef.current, ms: Math.round(performance.now() - t0.current) });
          setRes(bd);
        },
        onCreated: (created) => {
          localRef.current = created;
          setLocal(created.project);
          setProjectId(created.project.id);
        },
        onPlan: (current, todo) => {
          setSceneTotal(current.scenes.length);
          setProgress(Object.fromEntries(current.scenes.filter((s) => !todo.includes(s.id)).map((s) => [s.id, { sceneId: s.id, title: s.title, state: 'done' as const, cached: false }])));
        },
        onProgress: (p) => setProgress((x) => ({ ...x, [p.sceneId]: p })),
        onResult: (r) => {
          results.push(r);
          statsRef.current = addRuns(statsRef.current, r.runs);
          setStats({ ...statsRef.current, ms: Math.round(performance.now() - t0.current) });
        },
      });
      if (out.aborted) setError(`已取消：保留已完成的 ${results.length} 个场景。点「继续生成剩余场景」只生成其余（已完成的不会重做）。`, 'aborted');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e instanceof DirectorApiError ? e.message : (e as Error).message, e instanceof DirectorApiError ? e.kind : undefined);
    } finally {
      // whatever finished is applied (one undo step) and saved, also after a cancel or a failure
      if (results.length > 0 && localRef.current) {
        try {
          const saved = await applyAndSave(localRef.current, results);
          localRef.current = saved;
          setLocal(saved.project);
        } catch (e) {
          setError(`保存失败：${(e as Error).message}`);
        }
      }
      statsRef.current = { ...statsRef.current, ms: Math.round(performance.now() - t0.current) };
      setStats({ ...statsRef.current, ms: Math.round(performance.now() - t0.current) });
      setFinishedAt(Date.now());
      setStage('');
      setBusy(false);
      ctl.current = null;
      refreshSettings();
    }
  };

  const bgName = (id: string) => catalog?.backgrounds.find((b) => b.id === id)?.name ?? id;
  const modelLabel = (id: string) => {
    const m = catalog?.models.find((x) => x.id === id);
    return m ? costumeLabel(m.costumeInfo) : id;
  };
  const nameOf = (key: string) => catalog?.characters.find((c) => c.key === key)?.name ?? key;
  const provider = res?.runs[0]?.provider;
  const originLabel = provider === 'rule' ? '规则生成（非 AI）' : provider === 'fixture' ? '测试回放（非 AI）' : `${provider === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${res?.runs[0]?.model}`;
  const failed = Object.values(progress).filter((p) => p.state === 'error');
  const succeeded = Object.values(progress).filter((p) => p.state === 'done');
  const undirected = local ? local.scenes.filter(isUndirectedScene).map((s) => s.id) : [];
  // a scene that failed is still to do, whatever its skeleton beats look like
  const remaining = new Set([...undirected, ...failed.map((p) => p.sceneId)]).size;
  const aborted = errorKind === 'aborted';
  const hasFailure = failed.length > 0 || (error !== null && !aborted);
  /** Only a run that really produced every scene may say so. */
  const allDone = !!local && remaining === 0 && !hasFailure && !aborted;
  const hint = fixHint(failed[0]?.kind ?? errorKind);
  const warnings = useMemo(() => (phase === 'full' && local ? continuityOf(local, catalog) : []), [phase, local, catalog]);
  const doneCount = Object.values(progress).filter((p) => p.state === 'done').length;
  const runWho = useRule ? '规则' : provider === 'fixture' ? '回放' : 'AI';
  const progressState = busy ? 'running' : allDone ? 'done' : hasFailure ? 'failed' : aborted ? 'cancelled' : 'partial';
  const progressTone: CardTone = progressState === 'done' ? 'ok' : progressState === 'failed' ? 'bad' : progressState === 'running' ? 'hint' : 'warn';
  const progressLabel = progressState === 'failed' && succeeded.length > 0 ? '部分失败' : { running: '生成中', done: '完成', failed: '失败', cancelled: '已取消', partial: '未完成' }[progressState];

  const openEditor = async (id: string) => {
    try {
      const r = await loadProject(id);
      // the editor's stream starts with these two cards (it is delivered when the editor opens this project), and the assistant is told about them
      const total = sceneTotal || r.project.scenes.length;
      const notes = [
        ...failed.map((p) => `失败：${p.title}：${p.message ?? ''}`),
        ...continuityOf(r.project, catalog).map((w) => `连续性：${w.message}`),
      ];
      const titles = r.project.scenes.map((s) => s.title);
      if (doneCount > 0) {
        useAiFlow.getState().queue(id, [
          breakdownEntry({ who: runWho, userText: '分场并生成整部演出', scenes: titles, cast: r.project.cast.length, warnings: res?.warnings.length ?? 0 }),
          generateEntry({ who: runWho, done: doneCount, total, failed: failed.length, warnings: continuityOf(r.project, catalog).length, notes }),
        ]);
      } else if (titles.length > 0) {
        useAiFlow.getState().queue(id, [
          breakdownEntry({ who: runWho, userText: '分场并生成整部演出', scenes: titles, cast: r.project.cast.length, warnings: res?.warnings.length ?? 0 }),
          skeletonEntry({ who: runWho, scenes: titles.length }),
        ]);
      }
      useProject.getState().open(r.project, r.etag);
      onCreated(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const showComposer = phase !== 'full';
  return (
    <Modal title="从小说开始" onClose={onClose} testid="ai-breakdown-dialog" xl>
      <div className="onboard-flow" data-testid="onboard-flow">
        <section className="onboard-src" aria-label="原文">
          <input className="text" placeholder="项目标题" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="ai-title" readOnly={!!projectId} />
          <textarea ref={source} className="text ai-source" placeholder="粘贴小说 / 剧本文本（或载入 .txt / .md，自动识别 UTF-8 / GBK）…" value={text} onChange={(e) => setText(e.target.value)} data-testid="ai-source" readOnly={!!projectId} />
          <p className="hint" data-testid="ai-source-info">
            {text.length > 0 ? `${[...text].length} 字 · ${splitParagraphs(text).length} 段 · ${chapters.length > 0 ? `检测到 ${chapters.length} 个章节标题` : '未检测到章节标题'}${fileInfo ? ` · ${fileInfo}` : ''}` : ' '}
          </p>
          <div>
            <button className="btn" disabled={!!projectId} onClick={() => file.current?.click()}>载入 .txt / .md…</button>
            <input ref={file} type="file" accept=".txt,.md,text/plain,text/markdown" hidden data-testid="ai-file" onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) {
                const r = await readTextFile(f);
                setText(normalizeNovel(r.text));
                setFileInfo(`${f.name} · ${r.encoding}`);
                if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
              }
            }} />
          </div>
        </section>
        <section className="onboard-ai" aria-label="AI">
          {settings && (
            <p className={`onboard-status ${settings.status.verified === 'ok' ? 'ok' : configured && settings.status.verified !== 'failed' ? 'hint' : 'warn'}`} data-testid="ai-status">
              <span title={settings.status.message}>{withoutAi ? '未配置 AI：不影响使用，选「规则生成（非 AI）」就能分场、生成。' : settings.status.message}</span>
              {' '}<button className="btn-s" onClick={() => setShowSettings(true)} data-testid="ai-open-settings">AI 设置</button>
            </p>
          )}
          <div className="ai-stream onboard-stream">
            {!asked && !error && <p className="hint ai-empty">粘贴或打开小说，然后点「先分场看看」（先看分场，再决定建项目）或「分场并生成全部」（一步做完整部演出）。{withoutAi ? '没有配置 AI 也可以：规则生成不需要 key。' : ''}</p>}
            {asked && <UserBubble text={asked} />}
            {error && phase !== 'full' && (
              <AiCard state="failed" title="没有完成" who={who} stateLabel="失败" tone="bad">
                <pre className="bad ai-error" data-testid="ai-error">{error}</pre>
                {fixHint(errorKind) && (
                  <p className="warn" data-testid="ai-fix">
                    {fixHint(errorKind)!.text}{' '}
                    {fixHint(errorKind)!.settings && <button className="btn-s" onClick={() => setShowSettings(true)} data-testid="ai-fix-settings">打开 AI 设置</button>}
                  </p>
                )}
              </AiCard>
            )}
            {phase === 'review' && res && (
              <AiCard
                state="pending" title={`分场 · ${res.project.scenes.length} 场`} who={provider === 'rule' ? '规则' : provider === 'fixture' ? '回放' : 'AI'} stateLabel="待确认" tone="warn"
                bodyTestId="breakdown-view"
                said={`${res.project.scenes.length} 个场景 · ${res.project.cast.length} 个角色。先看看分得对不对：不满意就改原文重分，满意就建项目（稍后生成）或直接生成全部。`}
                meta={<>{res.cached && <span className="badge" data-testid="ai-cached">缓存</span>}</>}
                actions={(
                  <>
                    <button className="btn primary" disabled={busy} onClick={() => void create()} data-testid="ai-create">建项目，稍后生成</button>
                    <button className="btn" disabled={busy || !text.trim()} onClick={() => void full()} data-testid="ai-review-full">生成全部</button>
                    <button className="btn" disabled={busy} onClick={() => void run(true)} data-testid="ai-rebreak">重新分场</button>
                    <button className="btn" disabled={busy} onClick={() => source.current?.focus()} data-testid="ai-edit-source">改原文重分</button>
                  </>
                )}
                detail={res.warnings.length > 0 ? (
                  <ul className="ai-warn">{res.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                ) : undefined}
                detailLabel={`${res.warnings.length} 条自动修复 / 警告`}
              >
                <p className="hint">{originLabel} · {res.runs.length} 次调用 · {ms} ms</p>
                {res.breakdown.cast.some((c) => c.characterKey === null) && (
                  <p className="hint" data-testid="unmapped">未映射角色（仅旁白）：{res.breakdown.cast.filter((c) => c.characterKey === null).map((c) => c.nameInText).join('、')}</p>
                )}
                <ol className="bd-scenes">
                  {res.breakdown.scenes.map((s, i) => (
                    <li key={i} data-testid="bd-scene">
                      <strong>{s.title}</strong> <span className="hint">段落 {s.startParagraph}–{s.endParagraph} · {s.timeOfDay}{s.isPerformance ? ` · 正式演出（${s.band ?? ''}）` : ''}</span>
                      <div>背景：{bgName(s.location.backgroundId)} <span className="hint">（{s.location.reason}）</span></div>
                      <div>在场：{s.presentCast.map(nameOf).join('、')}</div>
                      <ul className="bd-wardrobe">
                        {s.wardrobe.map((w) => <li key={w.characterKey}>{nameOf(w.characterKey)}：{modelLabel(w.modelId)} <span className="hint">{w.reason}</span></li>)}
                      </ul>
                    </li>
                  ))}
                </ol>
              </AiCard>
            )}
            {phase === 'full' && (
              <AiCard
                state={progressState} title={`生成演出${sceneTotal > 0 ? ` · ${doneCount}/${sceneTotal}` : ''}`} who={runWho} stateLabel={progressLabel} tone={progressTone}
                bodyTestId="full-view" bodyAttrs={{ 'data-project': projectId ?? '' }}
                actions={(
                  <>
                    {busy && <button className="btn danger" onClick={() => ctl.current?.abort()} data-testid="full-cancel">停止</button>}
                    {!busy && remaining > 0 && local && <button className="btn primary" onClick={() => void full()} data-testid="full-resume">{failed.length > 0 ? `重试失败的 ${failed.length} 场` : `继续生成剩余 ${remaining} 场`}</button>}
                    {!busy && !local && hasFailure && <button className="btn primary" onClick={() => void full()} data-testid="full-retry">重试</button>}
                    {!busy && !local && hasFailure && <button className="btn" onClick={() => { setError(null); setPhase('input'); }} data-testid="full-back">返回修改</button>}
                    {!busy && projectId && <a className="btn" href={`/play/${projectId}`} target="_blank" rel="noreferrer" data-testid="full-play">放映</a>}
                    {!busy && projectId && <button className="btn primary" onClick={() => void openEditor(projectId)} data-testid="full-edit">进入编辑器继续</button>}
                  </>
                )}
              >
                <p className={!busy && hasFailure ? 'bad' : 'hint'} data-testid="full-stage">
                  {stage || (busy ? '' : allDone ? '全部场景已生成'
                    : !local ? (aborted ? '已取消' : '生成失败（未能分场）')
                    : failed.length > 0 ? `生成未完成：${succeeded.length} 个场景成功，${failed.length} 个失败`
                    : hasFailure ? '生成失败' : `还有 ${remaining} 个场景没有生成`)}
                </p>
                {sceneTotal > 0 && (
                  <div data-testid="full-meter">
                    <div className="ai-meter"><i style={{ width: `${Math.round((doneCount / sceneTotal) * 100)}%` }} /></div>
                    <span className="hint">{doneCount} / {sceneTotal} 个场景</span>
                  </div>
                )}
                <ul className="ai-progress" data-testid="full-progress">
                  {Object.values(progress).map((p) => (
                    <li key={p.sceneId} className={p.state === 'error' ? 'bad' : p.state === 'done' ? 'ok' : ''} data-state={p.state}>
                      {p.state === 'start' ? '生成中…' : p.state === 'done' ? `完成${p.cached ? '（缓存）' : ''}` : `失败：${p.message}`} · {p.title}
                    </li>
                  ))}
                </ul>
                <p className="hint" data-testid="full-stats">
                  <span className={`src ${useRule ? 'src-rule' : 'src-ai'}`}>{useRule ? '规则' : 'AI'}</span>
                  {' '}{useRule ? '规则运算，没有调用模型' : `${stats.calls} 次调用（缓存命中 ${stats.cached}，修复 ${stats.repairs}）`} · 输入 {stats.inTok} / 输出 {stats.outTok} tokens · {Math.round(stats.ms / 100) / 10} s
                </p>
                {error && <pre className="bad ai-error" data-testid="ai-error">{error}</pre>}
                {!busy && finishedAt > 0 && failed.length > 0 && (
                  <div className="bad" data-testid="full-failures">
                    <strong>{failed.length} 个场景生成失败：</strong>
                    <ul>{failed.map((p) => <li key={p.sceneId} data-testid="full-failed-scene">{p.title}：{p.message}</li>)}</ul>
                    {succeeded.length > 0 && <p className="ok" data-testid="full-succeeded">已成功 {succeeded.length} 个：{succeeded.map((p) => p.title).join('、')}</p>}
                  </div>
                )}
                {!busy && finishedAt > 0 && hint && hasFailure && (
                  <p className="warn" data-testid="full-fix">
                    {hint.text}{' '}
                    {hint.settings && <button className="btn-s" onClick={() => setShowSettings(true)} data-testid="full-open-settings">打开 AI 设置</button>}
                  </p>
                )}
                {!busy && finishedAt > 0 && allDone && (
                  <div data-testid="full-done">
                    {warnings.length === 0 ? <p className="ok">连续性检查：未发现问题</p> : (
                      <details open>
                        <summary data-testid="full-continuity">连续性检查：{warnings.length} 条提示</summary>
                        <ul className="ai-warn">{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
                      </details>
                    )}
                  </div>
                )}
              </AiCard>
            )}
          </div>
          {showComposer && (
            <div className="onboard-composer">
              <label className="srow" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><span>引擎</span>
                <select value={useRule ? 'rule' : 'ai'} onChange={(e) => setEngine(e.target.value as Engine)} data-testid="ai-engine">
                  <option value="ai" disabled={!configured}>AI 模型{configured ? '' : '（未配置）'}</option>
                  <option value="rule">规则生成（非 AI）</option>
                </select>
              </label>
              {!useRule && <DirectorMemoryLine projectId={null} on={useMem} setOn={setUseMem} />}
              <span className="grow" />
              <button className="btn" disabled={busy || text.trim() === ''} onClick={() => void run(false)} data-testid="ai-breakdown">{busy ? '分场中…' : '先分场看看'}</button>
              <button className="btn primary" disabled={busy || text.trim() === ''} onClick={() => void full()} data-testid="ai-full">分场并生成全部</button>
            </div>
          )}
          {showComposer && useRule && <p className="hint onboard-status" data-testid="ai-rule-hint">规则生成（非 AI）不需要 key：按章节与关键词分场、匹配背景和服装、识别对白与说话人。结果标注为「规则」，不是 AI。</p>}
        </section>
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onChanged={(s) => useAiSettings.getState().set(s)} />}
    </Modal>
  );
}
