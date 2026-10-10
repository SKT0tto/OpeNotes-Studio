/**
 * AI director panel: generate / regenerate scenes, whole scenes or one scope; every proposal is shown as a diff against the
 * current scene and accepted or rejected per scope (one undo step each); progress, cancel, the run log and the continuity
 * check of the whole project.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { costumeLabelZh } from '@shared/catalog/labels';
import { catalogLookups, checkContinuity } from '@shared/director/continuity';
import { alignToOld, diffScene, type DiffScope } from '@shared/director/diff';
import { mergeLocks } from '@shared/director/mergeLocks';
import { SCOPE_LABEL, SCOPE_NAMES, type ScopeName } from '@shared/director/scope';
import type { CompactCatalog } from '@shared/schema/assets';
import type { Project } from '@shared/schema/project';
import type { PublicLlmSettings } from '@shared/schema/settings';
import { DirectorApiError, postScene, postScenes, type BatchProgress, type SceneResponse } from '../../directorApi';
import { fetchLlmSettings } from '../../llmApi';
import { useProject } from '../../store/projectStore';
import { notify } from '../../store/uiStore';
import { SettingsDialog } from '../dialogs/SettingsDialog';
import { useCatalog } from '../useCatalog';
import { AiResultCard, type Card } from './AiResultCard';

interface LogLine { at: number; kind: 'info' | 'error'; text: string }
type Engine = 'ai' | 'rule';

export function continuityOf(project: Project, catalog: CompactCatalog | null) {
  return checkContinuity(project, catalogLookups(catalog));
}

export function AiPanel() {
  const project = useProject((s) => s.project)!;
  const selection = useProject((s) => s.selection);
  const catalog = useCatalog();
  const [settings, setSettings] = useState<PublicLlmSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [engine, setEngine] = useState<Engine>('ai');
  const [preview, setPreview] = useState(true);
  const [scope, setScope] = useState<ScopeName>('scene');
  const [onlyBeat, setOnlyBeat] = useState(false);
  const [overwriteUser, setOverwriteUser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<string, BatchProgress>>({});
  const [total, setTotal] = useState(0);
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const meta = useRef<{ scopes: ScopeName[]; beatIds?: string[]; overwrite: boolean; label: string }>({ scopes: ['scene'], overwrite: false, label: '' });

  const reload = useCallback(() => {
    fetchLlmSettings().then(setSettings, () => setSettings(null));
  }, []);
  useEffect(reload, [reload]);

  const scene = project.scenes.find((s) => s.id === selection.sceneId) ?? project.scenes[0];
  const configured = settings?.status.configured === true;
  const useRule = engine === 'rule' || !configured;
  const canGenerate = !busy && !!project.source.text && project.scenes.length > 0;
  const who = useRule ? '规则' : settings?.status.provider === 'fixture' ? '回放' : 'AI';
  const castName = useCallback((id: string) => project.cast.find((c) => c.id === id)?.displayName ?? id, [project.cast]);
  const titleOf = (id: string) => project.scenes.find((s) => s.id === id)?.title ?? id;
  const say = (kind: LogLine['kind'], text: string) => setLog((l) => [...l.slice(-60), { at: Date.now(), kind, text }]);

  /** Applies proposals to the CURRENT scenes through the lock-enforcing merge; one undo step. */
  const applyCards = (list: Array<{ card: Card; scopes: ScopeName[] }>, label: string, partial = false) => {
    const conflicts: string[] = [];
    const done: string[] = [];
    useProject.getState().applyEdit((d) => {
      for (const { card, scopes } of list) {
        const k = d.scenes.findIndex((s) => s.id === card.sceneId);
        if (k < 0) continue;
        const cur = JSON.parse(JSON.stringify(d.scenes[k])) as Project['scenes'][number];
        const merged = mergeLocks(cur, partial ? alignToOld(cur, card.result.scene) : card.result.scene, {
          scopes, ...(meta.current.beatIds ? { beatIds: meta.current.beatIds } : {}), overwriteUser: meta.current.overwrite,
        });
        if (merged.applied) {
          d.scenes[k] = merged.scene as never;
          done.push(card.sceneId);
        } else conflicts.push(...merged.conflicts.map((c) => c.label));
      }
    }, label);
    setCards((c) => {
      const next = { ...c };
      for (const { card } of list) if (next[card.sceneId] && done.includes(card.sceneId)) next[card.sceneId] = { ...next[card.sceneId]!, state: 'accepted' };
      return next;
    });
    if (conflicts.length > 0) setError(`锁定冲突，没有应用：\n${conflicts.join('\n')}`);
    else notify(`${label}（Ctrl+Z 可撤销）`, 'info');
  };

  const accept = (card: Card, all: boolean) => {
    const scopes: ScopeName[] = all ? meta.current.scopes : (card.checked.filter((s) => s !== 'structure') as ScopeName[]);
    applyCards([{ card, scopes }], `${who}：接受「${card.title}」${all ? '' : '（部分范围）'}`, !all);
  };
  const acceptAll = () => {
    const pend = Object.values(cards).filter((c) => c.state === 'pending' && c.result.applied);
    if (pend.length > 0) applyCards(pend.map((card) => ({ card, scopes: meta.current.scopes })), `${who}：接受 ${pend.length} 个场景的演出`);
  };
  const reject = (id: string) => setCards((c) => ({ ...c, [id]: { ...c[id]!, state: 'rejected' } }));
  const rejectAll = () => setCards((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.state === 'pending' ? { ...v, state: 'rejected' as const } : v])));
  const toggle = (id: string, s: DiffScope) => setCards((c) => ({ ...c, [id]: { ...c[id]!, checked: c[id]!.checked.includes(s) ? c[id]!.checked.filter((x) => x !== s) : [...c[id]!.checked, s] } }));

  const intake = (snapshotScenes: Project['scenes'], results: SceneResponse[]) => {
    const fresh: Record<string, Card> = {};
    for (const r of results) {
      const old = snapshotScenes.find((s) => s.id === r.sceneId);
      if (!old) continue;
      const diff = diffScene(old, alignToOld(old, r.scene), {
        cast: castName,
        model: (id) => {
          const m = catalog?.models.find((x) => x.id === id);
          return m ? costumeLabelZh(m.costumeInfo, m.costume) : id;
        },
      });
      fresh[r.sceneId] = { sceneId: r.sceneId, title: old.title, result: r, diff, scopes: meta.current.scopes, state: 'pending', checked: Object.keys(diff.counts) as DiffScope[] };
      say('info', `${old.title}：${r.runs.length} 次调用，${r.runs.reduce((n, x) => n + x.ms, 0)} ms，${diff.items.length} 项变化${r.warnings.length ? `，${r.warnings.length} 条修复/警告` : ''}${r.runs.some((x) => x.repaired) ? '，含修复调用' : ''}`);
    }
    setCards((c) => ({ ...c, ...fresh }));
    if (!preview) applyCards(Object.values(fresh).filter((c) => c.result.applied).map((card) => ({ card, scopes: meta.current.scopes })), `${who} 生成：${meta.current.label}`);
    else if (Object.values(fresh).some((c) => !c.result.applied)) setError('有场景因锁定冲突没有应用，详见结果。');
  };

  const run = async (all: boolean) => {
    setBusy(true);
    setError(null);
    setProgress({});
    setCards({});
    ctl.current = new AbortController();
    const scopes: ScopeName[] = all ? ['scene'] : [scope];
    const snapshot = useProject.getState().project!;
    const beatIds = !all && onlyBeat && selection.beatId ? [selection.beatId] : undefined;
    meta.current = { scopes, ...(beatIds ? { beatIds } : {}), overwrite: overwriteUser, label: all ? '全部场景' : `${scene?.title ?? ''} · ${SCOPE_LABEL[scope]}${beatIds ? '（所选台词）' : ''}` };
    const eng = useRule ? ({ engine: 'rule' } as const) : {};
    const got: SceneResponse[] = [];
    try {
      if (all) {
        setTotal(snapshot.scenes.length);
        say('info', `开始生成全部场景（${who}，并发 3）`);
        try {
          await postScenes(snapshot, { scopes, overwriteUser, ...eng }, (p) => {
            setProgress((x) => ({ ...x, [p.sceneId]: p }));
            if (p.state === 'done' && p.result) got.push(p.result);
            if (p.state === 'error') say('error', `${titleOf(p.sceneId)}：${p.message ?? ''}`);
          }, ctl.current.signal);
        } catch (e) {
          if ((e as Error).name !== 'AbortError') throw e;
          say('info', `已取消：保留已完成的 ${got.length} 个场景，可再次点击继续（已完成的有缓存，不会重复调用）`);
        }
      } else if (scene) {
        setTotal(1);
        say('info', `开始：${scene.title} · ${SCOPE_LABEL[scope]}（${who}）`);
        got.push(await postScene(snapshot, scene.id, { scopes, ...(beatIds ? { beatIds } : {}), overwriteUser, ...eng }, ctl.current.signal));
      }
      intake(snapshot.scenes, got);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        const msg = e instanceof DirectorApiError ? `${e.message}${e.problems.length ? `\n${e.problems.join('\n')}` : ''}` : (e as Error).message;
        setError(msg);
        say('error', msg.split('\n')[0]!);
      } else say('info', '已取消');
    } finally {
      setBusy(false);
      ctl.current = null;
    }
  };

  const pending = Object.values(cards).filter((c) => c.state === 'pending' && c.result.applied);
  const warnings = useMemo(() => continuityOf(project, catalog), [project, catalog]);
  const finished = Object.values(progress).filter((p) => p.state !== 'start').length;

  return (
    <div className="ai-panel" data-testid="ai-panel">
      {settings && (
        <p className={settings?.status.verified === 'ok' ? 'ok' : configured && settings?.status.verified !== 'failed' ? 'hint' : 'warn'} data-testid="ai-status">
          {settings.status.message}
          {' '}<button className="btn-s" onClick={() => setShowSettings(true)} data-testid="ai-open-settings">AI 设置</button>
        </p>
      )}
      {!project.source.text && <p className="hint" data-testid="ai-no-source">这个项目没有原文（不是由 AI 拆解创建的），不能用 AI 导演。请在项目列表里用「AI 拆解」创建项目。</p>}
      <div className="ai-controls">
        <label className="srow"><span>引擎</span>
          <select value={useRule ? 'rule' : 'ai'} onChange={(e) => setEngine(e.target.value as Engine)} data-testid="ai-engine">
            <option value="ai" disabled={!configured}>AI 模型{configured ? '' : '（未配置）'}</option>
            <option value="rule">规则导演（非 AI，无需 key）</option>
          </select>
        </label>
        <label className="srow"><span>范围</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as ScopeName)} data-testid="ai-scope">
            {SCOPE_NAMES.map((n) => <option key={n} value={n}>{SCOPE_LABEL[n]}</option>)}
          </select>
        </label>
        <label className="chk"><input type="checkbox" checked={onlyBeat} disabled={!selection.beatId} onChange={(e) => setOnlyBeat(e.target.checked)} data-testid="ai-only-beat" /> 只重做选中的台词</label>
        <label className="chk"><input type="checkbox" checked={overwriteUser} onChange={(e) => setOverwriteUser(e.target.checked)} data-testid="ai-overwrite" /> 也覆盖我手改过的内容（锁定的永不覆盖）</label>
        <label className="chk"><input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} data-testid="ai-preview" /> 先预览差异，再逐项接受 / 拒绝</label>
        <div className="ai-buttons">
          <button className="btn primary" disabled={!canGenerate || !scene} onClick={() => void run(false)} data-testid="ai-regen-scene">
            {scene && scene.beats.some((b) => b.meta.source !== 'rule') ? '重新生成' : '生成演出'}：{scene?.title ?? '—'}
          </button>
          <button className="btn" disabled={!canGenerate} onClick={() => void run(true)} data-testid="ai-gen-all">生成全部场景演出</button>
          {busy && <button className="btn danger" onClick={() => ctl.current?.abort()} data-testid="ai-cancel">取消</button>}
        </div>
        {useRule && <p className="hint" data-testid="ai-rule-hint">规则导演：对白按引号识别、说话人按名字匹配、镜头按固定节奏，产物标注为「规则」，不是 AI。</p>}
      </div>
      {busy && total > 0 && (
        <div data-testid="ai-meter">
          <div className="ai-meter"><i style={{ width: `${Math.round((finished / total) * 100)}%` }} /></div>
          <span className="hint">{finished} / {total} 个场景</span>
        </div>
      )}
      {Object.keys(progress).length > 0 && (
        <ul className="ai-progress" data-testid="ai-progress">
          {Object.values(progress).map((p) => (
            <li key={p.sceneId} className={p.state === 'error' ? 'bad' : p.state === 'done' ? 'ok' : ''} data-state={p.state}>
              {p.state === 'start' ? '生成中…' : p.state === 'done' ? `完成${p.cached ? '（缓存）' : ''}` : `失败：${p.message}`} · {p.title}
            </li>
          ))}
        </ul>
      )}
      {busy && Object.keys(progress).length === 0 && <p className="hint">请求中…（每个场景只调用一次模型）</p>}
      {error && <pre className="bad ai-error" data-testid="ai-error">{error}</pre>}
      {pending.length > 1 && (
        <div className="ai-batchbar" data-testid="ai-batchbar">
          <button className="btn primary" onClick={acceptAll} data-testid="ai-accept-batch">接受全部 {pending.length} 个场景</button>
          <button className="btn" onClick={rejectAll}>全部拒绝</button>
        </div>
      )}
      <ul className="ai-results">
        {Object.values(cards).map((c) => (
          <AiResultCard key={c.sceneId} card={c} onToggle={(s) => toggle(c.sceneId, s)} onAccept={(all) => accept(c, all)} onReject={() => reject(c.sceneId)} />
        ))}
      </ul>
      {project.scenes.length > 0 && (
        <details open={warnings.length > 0} data-testid="ai-continuity">
          <summary>{warnings.length === 0 ? '连续性检查：未发现问题' : `连续性检查：${warnings.length} 条提示（点击定位）`}</summary>
          <ul className="ai-warn ai-continuity">
            {warnings.map((w, i) => (
              <li key={i} onClick={() => useProject.getState().select({ sceneId: w.sceneId, ...(w.beatId ? { beatId: w.beatId } : {}) })} data-testid="ai-cont-item">{w.message}</li>
            ))}
          </ul>
        </details>
      )}
      {log.length > 0 && (
        <details>
          <summary>运行记录（{log.length}）</summary>
          <ul className="ai-log" data-testid="ai-log">
            {log.map((l, i) => <li key={i} className={l.kind === 'error' ? 'bad' : ''}>{new Date(l.at).toLocaleTimeString()} {l.text}</li>)}
          </ul>
        </details>
      )}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} onChanged={setSettings} />}
    </div>
  );
}
