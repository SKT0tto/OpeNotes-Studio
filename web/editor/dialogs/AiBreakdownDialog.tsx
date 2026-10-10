/**
 * "AI 拆解 / 一键生成": paste or import a novel (txt / md, UTF-8 or GBK). Either review the breakdown first and create the project,
 * or generate the whole performance in one go (breakdown -> project -> every scene, 3 at a time, cancellable and resumable).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { detectChapters, splitParagraphs } from '@shared/director/paragraphs';
import { mergeLocks } from '@shared/director/mergeLocks';
import type { CompactCatalog } from '@shared/schema/assets';
import type { PublicLlmSettings } from '@shared/schema/settings';
import { costumeLabel } from '@shared/catalog/costume';
import { DirectorApiError, postBreakdown, postScenes, type BatchProgress, type BreakdownResponse, type RunInfo, type SceneResponse } from '../../directorApi';
import { fetchLlmSettings } from '../../llmApi';
import type { Project } from '@shared/schema/project';
import { createProject, loadProject, saveProject } from '../../projectsApi';
import { useProject } from '../../store/projectStore';
import { readTextFile, normalizeNovel } from '../../textImport';
import { Modal } from '../ui';
import { continuityOf } from '../panels/AiPanel';
import { SettingsDialog } from './SettingsDialog';

type Engine = 'ai' | 'rule';
type Phase = 'input' | 'review' | 'full';

interface Stats { calls: number; cached: number; inTok: number; outTok: number; repairs: number; ms: number }
const zero = (): Stats => ({ calls: 0, cached: 0, inTok: 0, outTok: 0, repairs: 0, ms: 0 });
const addRuns = (s: Stats, runs: RunInfo[]): Stats => runs.reduce((a, r) => ({
  calls: a.calls + (r.cached ? 0 : 1), cached: a.cached + (r.cached ? 1 : 0), inTok: a.inTok + (r.cached ? 0 : r.usage.inputTokens), outTok: a.outTok + (r.cached ? 0 : r.usage.outputTokens), repairs: a.repairs + (r.repaired ? 1 : 0), ms: a.ms,
}), s);

const directed = (b: { meta: { source: string; reason?: string | undefined } }) => !(b.meta.source === 'rule' && b.meta.reason?.startsWith('原文段落'));

export function AiBreakdownDialog({ catalog, onClose, onCreated }: { catalog: CompactCatalog | null; onClose: () => void; onCreated: (id: string) => void }) {
  const [settings, setSettings] = useState<PublicLlmSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [engine, setEngine] = useState<Engine>('ai');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [fileInfo, setFileInfo] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const ctl = useRef<AbortController | null>(null);
  const t0 = useRef(0);
  const statsRef = useRef<Stats>(zero());

  useEffect(() => {
    fetchLlmSettings().then(setSettings, () => setSettings(null));
  }, []);
  const configured = settings?.status.configured === true;
  const useRule = engine === 'rule' || !configured;
  const eng = useRule ? ({ engine: 'rule' } as const) : undefined;

  const chapters = useMemo(() => detectChapters(splitParagraphs(text)), [text]);

  const run = async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    const t = performance.now();
    try {
      setRes(await postBreakdown(text, title.trim() || '未命名项目', refresh, undefined, eng?.engine));
      setMs(Math.round(performance.now() - t));
      setPhase('review');
    } catch (e) {
      setRes(null);
      setError(e instanceof DirectorApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!res) return;
    setBusy(true);
    try {
      const r = await createProject(res.project);
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
    ctl.current = new AbortController();
    const signal = ctl.current.signal;
    if (!projectId) {
      statsRef.current = zero();
      t0.current = performance.now();
    }
    const results: SceneResponse[] = [];
    try {
      let id = projectId;
      if (!id) {
        setStage('拆解全文（场景 / 角色 / 背景 / 服装）…');
        const bd = await postBreakdown(text, title.trim() || '未命名项目', false, signal, eng?.engine);
        statsRef.current = addRuns(statsRef.current, bd.runs);
        setStats({ ...statsRef.current, ms: Math.round(performance.now() - t0.current) });
        setRes(bd);
        const r = await createProject(bd.project);
        localRef.current = { project: r.project, etag: r.etag };
        setLocal(r.project);
        id = r.project.id;
        setProjectId(id);
      }
      const current = localRef.current!.project;
      const todo = current.scenes.filter((s) => s.beats.length === 0 || s.beats.every((b) => !directed(b))).map((s) => s.id);
      setSceneTotal(current.scenes.length);
      setProgress(Object.fromEntries(current.scenes.filter((s) => !todo.includes(s.id)).map((s) => [s.id, { sceneId: s.id, title: s.title, state: 'done' as const, cached: false }])));
      if (todo.length > 0) {
        setStage(`逐场景生成演出（${todo.length} 个场景，并发 3）…`);
        try {
          await postScenes(current, { scopes: ['scene'], sceneIds: todo, ...(eng ? { engine: eng.engine } : {}) }, (p) => {
            setProgress((x) => ({ ...x, [p.sceneId]: p }));
            if (p.state === 'done' && p.result) {
              results.push(p.result);
              statsRef.current = addRuns(statsRef.current, p.result.runs);
              setStats({ ...statsRef.current, ms: Math.round(performance.now() - t0.current) });
            }
          }, signal);
        } catch (e) {
          if ((e as Error).name !== 'AbortError') throw e;
          setError(`已取消：保留已完成的 ${results.length} 个场景。点「继续生成剩余场景」只生成其余（已完成的不会重做）。`);
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e instanceof DirectorApiError ? e.message : (e as Error).message);
    } finally {
      // whatever finished is applied (one undo step) and saved, also after a cancel or a failure
      if (results.length > 0 && localRef.current) {
        const next = JSON.parse(JSON.stringify(localRef.current.project)) as Project;
        for (const r of results) {
          const k = next.scenes.findIndex((x) => x.id === r.sceneId);
          if (k < 0) continue;
          const merged = mergeLocks(next.scenes[k]!, r.scene, { scopes: ['scene'] });
          if (merged.applied) next.scenes[k] = merged.scene;
        }
        try {
          const saved = await saveProject(next, localRef.current.etag);
          localRef.current = { project: saved.project, etag: saved.etag };
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
    }
  };

  const openEditor = async (id: string) => {
    try {
      const r = await loadProject(id);
      useProject.getState().open(r.project, r.etag);
      onCreated(id);
    } catch (e) {
      setError((e as Error).message);
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
  const remaining = local ? local.scenes.filter((s) => s.beats.length === 0 || s.beats.every((b) => !directed(b))).length : 0;
  const warnings = useMemo(() => (phase === 'full' && local ? continuityOf(local, catalog) : []), [phase, local, catalog]);
  const doneCount = Object.values(progress).filter((p) => p.state === 'done').length;

  return (
    <Modal title="AI 拆解 / 一键生成：从小说创建项目" onClose={onClose} testid="ai-breakdown-dialog" wide>
      <div className="settings-form">
        {settings && (
          <p className={configured ? 'ok' : 'warn'} data-testid="ai-status">
            {settings.status.message}
            {' '}<button className="btn-s" onClick={() => setShowSettings(true)} data-testid="ai-open-settings">AI 设置</button>
          </p>
        )}
        {phase === 'input' && (
          <>
            <input className="text" placeholder="项目标题" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="ai-title" />
            <textarea className="text ai-source" rows={12} placeholder="粘贴小说 / 剧本文本（或载入 .txt / .md，自动识别 UTF-8 / GBK）…" value={text} onChange={(e) => setText(e.target.value)} data-testid="ai-source" />
            <p className="hint" data-testid="ai-source-info">
              {text.length > 0 ? `${[...text].length} 字 · ${splitParagraphs(text).length} 段 · ${chapters.length > 0 ? `检测到 ${chapters.length} 个章节标题` : '未检测到章节标题'}${fileInfo ? ` · ${fileInfo}` : ''}` : ' '}
            </p>
            <div className="modal-actions">
              <label className="srow" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><span>引擎</span>
                <select value={useRule ? 'rule' : 'ai'} onChange={(e) => setEngine(e.target.value as Engine)} data-testid="ai-engine">
                  <option value="ai" disabled={!configured}>AI 模型{configured ? '' : '（未配置）'}</option>
                  <option value="rule">规则导演（非 AI）</option>
                </select>
              </label>
              <button className="btn" onClick={() => file.current?.click()}>载入 .txt / .md…</button>
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
              <button className="btn" disabled={busy || text.trim() === ''} onClick={() => void run(false)} data-testid="ai-breakdown">{busy ? '拆解中…' : useRule ? '规则拆解（先审阅）' : 'AI 拆解（先审阅）'}</button>
              <button className="btn primary" disabled={busy || text.trim() === ''} onClick={() => void full()} data-testid="ai-full">一键生成完整演出</button>
            </div>
            {useRule && <p className="hint" data-testid="ai-rule-hint">规则导演不需要 key：按章节与关键词分场景、匹配背景和服装、识别对白与说话人。结果标注为「规则」，不是 AI。</p>}
          </>
        )}
        {error && <pre className="bad ai-error" data-testid="ai-error">{error}</pre>}
        {phase === 'review' && res && (
          <div data-testid="breakdown-view">
            <p className="hint">
              <span className={`src ${provider === 'rule' ? 'src-rule' : 'src-ai'}`}>{provider === 'rule' ? '规则' : provider === 'fixture' ? '回放' : 'AI'}</span> {originLabel}
              {' · '}{res.runs.length} 次调用 · {ms} ms{res.cached && <span className="badge" data-testid="ai-cached">缓存</span>}
              {' · '}{res.project.scenes.length} 个场景 · {res.project.cast.length} 个角色
            </p>
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
            {res.warnings.length > 0 && (
              <details open>
                <summary data-testid="ai-warnings">{res.warnings.length} 条自动修复 / 警告</summary>
                <ul className="ai-warn">{res.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}
            <div className="modal-actions">
              <button className="btn" disabled={busy} onClick={() => { setRes(null); setPhase('input'); }}>返回修改文本</button>
              <button className="btn" disabled={busy} onClick={() => void run(true)}>重新拆解（忽略缓存）</button>
              <button className="btn primary" disabled={busy} onClick={() => void create()} data-testid="ai-create">创建项目并继续</button>
            </div>
          </div>
        )}
        {phase === 'full' && (
          <div data-testid="full-view" data-project={projectId ?? ""}>
            <p className="hint" data-testid="full-stage">{stage || (busy ? '' : remaining === 0 ? '全部场景已生成' : `还有 ${remaining} 个场景没有生成`)}</p>
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
            {!busy && finishedAt > 0 && (
              <div data-testid="full-done">
                {warnings.length === 0 ? <p className="ok">连续性检查：未发现问题</p> : (
                  <details open>
                    <summary data-testid="full-continuity">连续性检查：{warnings.length} 条提示</summary>
                    <ul className="ai-warn">{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
            <div className="modal-actions">
              {busy && <button className="btn danger" onClick={() => ctl.current?.abort()} data-testid="full-cancel">取消</button>}
              {!busy && remaining > 0 && <button className="btn" onClick={() => void full()} data-testid="full-resume">继续生成剩余场景（{remaining}）</button>}
              {!busy && projectId && <a className="btn primary" href={`/play/${projectId}`} target="_blank" rel="noreferrer" data-testid="full-play">放映</a>}
              {!busy && projectId && <button className="btn" onClick={() => void openEditor(projectId)} data-testid="full-edit">在编辑器中精修</button>}
            </div>
          </div>
        )}
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onChanged={setSettings} />}
    </Modal>
  );
}
