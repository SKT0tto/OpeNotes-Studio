/**
 * The AI director's run state and logic, out of the panel: options, progress, the proposals (cards), the run log, accept / reject, and the
 * request itself. It used to live in the component that was mounted only while its tab was in front, so switching tabs aborted a run and
 * dropped a result nobody had accepted yet. In a store it survives the panel being hidden, collapsed or re-mounted; leaving the project
 * (or the editor) ends it (`reset`).
 *
 * Nothing about the requests changed: the same `postScene` / `postScenes` calls with the same options, in the same key order (`refresh` is
 * only present for 「换一版」). Accepting still runs through the lock-enforcing `mergeLocks` inside one `applyEdit` = one undo step.
 */
import { create } from 'zustand';
import { costumeLabelZh } from '@shared/catalog/labels';
import { catalogLookups, checkContinuity } from '@shared/director/continuity';
import { alignToOld, diffScene, DIFF_LABEL, type DiffScope } from '@shared/director/diff';
import { mergeLocks } from '@shared/director/mergeLocks';
import { SCOPE_LABEL, type ScopeName } from '@shared/director/scope';
import type { CompactCatalog } from '@shared/schema/assets';
import type { Project } from '@shared/schema/project';
import { DirectorApiError, postScene, postScenes, type BatchProgress, type SceneResponse } from '../../directorApi';
import { directorAcceptText } from '../../store/agentNotes';
import { useAgent } from '../../store/agentStore';
import { useProject } from '../../store/projectStore';
import { notify } from '../../store/uiStore';
import type { Card } from './AiResultCard';

export interface LogLine { at: number; kind: 'info' | 'error'; text: string }
export type Engine = 'ai' | 'rule';

export function continuityOf(project: Project, catalog: CompactCatalog | null) {
  return checkContinuity(project, catalogLookups(catalog));
}

/** A user-created request; consuming also invalidates it when leaving the panel. */
export interface CameraGenerationRequest {
  projectId: string;
  /** One scene (current-scene regenerate) or several, processed one request at a time. */
  sceneIds: string[];
  consume: () => boolean;
}

export interface RunOptions {
  sceneId?: string;
  /** Several scenes, one sequential request each (camera regenerate for all). */
  sceneIds?: string[];
  scope?: ScopeName;
  preview?: boolean;
  overwriteUser?: boolean;
  onlyBeat?: boolean;
  engine?: Engine;
  /** 「换一版」: ask for a new answer instead of the cached one for the same input (the request's `refresh` flag). */
  refresh?: boolean;
}

/** What the panel knows that the store does not: the AI settings and the catalog (for model labels in the diff). */
export interface DirectorEnv {
  configured: boolean;
  /** `settings.status.provider`: 'fixture' is the recorded-response test provider (shown as 回放). */
  provider: string | null | undefined;
  catalog: CompactCatalog | null;
}

/** The two requests, injectable so that tests can run the store without a server. */
export interface DirectorApi {
  postScene: typeof postScene;
  postScenes: typeof postScenes;
}
const realApi: DirectorApi = { postScene, postScenes };

export interface DirectorControls {
  engine: Engine;
  scope: ScopeName;
  onlyBeat: boolean;
  overwriteUser: boolean;
  preview: boolean;
  useMem: boolean;
}
export const DEFAULT_CONTROLS: DirectorControls = { engine: 'ai', scope: 'scene', onlyBeat: false, overwriteUser: false, preview: true, useMem: true };

interface RunMeta { scopes: ScopeName[]; beatIds?: string[]; overwrite: boolean; label: string; who: string }

/** 「规则 / 回放 / AI」: who made the proposal. */
export const whoLabel = (useRule: boolean, provider: string | null | undefined): string => (useRule ? '规则' : provider === 'fixture' ? '回放' : 'AI');
/** The rule director is used when it was picked or when no AI is configured. */
export const usesRule = (engine: Engine, configured: boolean): boolean => engine === 'rule' || !configured;

interface DirectorState {
  projectId: string | null;
  controls: DirectorControls;
  /** Is the 「生成」 section of the AI panel expanded? null = not chosen yet (open when the project has source text). */
  generateOpen: boolean | null;
  busy: boolean;
  progress: Record<string, BatchProgress>;
  total: number;
  cards: Record<string, Card>;
  log: LogLine[];
  error: string | null;
  meta: RunMeta;
  setControls(patch: Partial<DirectorControls>): void;
  setGenerateOpen(open: boolean): void;
  setError(error: string | null): void;
  /** Called with the open project's id: another project ends the run and clears the results. */
  bindProject(id: string | null): void;
  /** Abort a running request and clear the results; the options stay (they are the person's settings, not results). */
  reset(): void;
  /** The project was left (the editor closed or another project opened): `reset`, the options back to their defaults, and forget which project it was. */
  unbind(): void;
  run(all: boolean, options: RunOptions | undefined, env: DirectorEnv, api?: DirectorApi): Promise<void>;
  cancel(): void;
  accept(sceneId: string, all: boolean): void;
  acceptAll(): void;
  reject(sceneId: string): void;
  rejectAll(): void;
  toggleScope(sceneId: string, scope: DiffScope): void;
}

const OPEN_KEY = 'studio.ai.generate.open';
const readOpen = (): boolean | null => {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
};
const writeOpen = (on: boolean): void => {
  try {
    localStorage.setItem(OPEN_KEY, on ? '1' : '0');
  } catch { /* storage may be blocked; the state just is not remembered */ }
};

let ctl: AbortController | null = null;
/** Bumped by `reset`: a request that was started before it must not write into the store any more. */
let generation = 0;
const NO_META: RunMeta = { scopes: ['scene'], overwrite: false, label: '', who: 'AI' };

export const useDirectorRun = create<DirectorState>((set, get) => {
  const say = (kind: LogLine['kind'], text: string) => set((s) => ({ log: [...s.log.slice(-60), { at: Date.now(), kind, text }] }));

  /** Applies proposals to the CURRENT scenes through the lock-enforcing merge; one undo step. */
  const applyCards = (list: Array<{ card: Card; scopes: ScopeName[] }>, label: string, partial = false, scopeLabels?: string[]) => {
    const meta = get().meta;
    const conflicts: string[] = [];
    const done: string[] = [];
    useProject.getState().applyEdit((d) => {
      for (const { card, scopes } of list) {
        const k = d.scenes.findIndex((s) => s.id === card.sceneId);
        if (k < 0) continue;
        const cur = JSON.parse(JSON.stringify(d.scenes[k])) as Project['scenes'][number];
        const merged = mergeLocks(cur, partial ? alignToOld(cur, card.result.scene) : card.result.scene, {
          scopes, ...(meta.beatIds ? { beatIds: meta.beatIds } : {}), overwriteUser: meta.overwrite,
        });
        if (merged.applied) {
          d.scenes[k] = merged.scene as never;
          done.push(card.sceneId);
        } else conflicts.push(...merged.conflicts.map((c) => c.label));
      }
    }, label);
    set((s) => {
      const next = { ...s.cards };
      for (const { card } of list) if (next[card.sceneId] && done.includes(card.sceneId)) next[card.sceneId] = { ...next[card.sceneId]!, state: 'accepted' };
      return { cards: next };
    });
    if (conflicts.length > 0) set({ error: `锁定冲突，没有应用：\n${conflicts.join('\n')}` });
    else notify(`${label}（Ctrl+Z 可撤销）`, 'info');
    // the assistant remembers what was just generated and applied, so that 「刚生成的第二场节奏慢一点」 resolves
    if (done.length > 0) {
      const project = useProject.getState().project;
      useAgent.getState().noteDirector(directorAcceptText({
        who: meta.who,
        scenes: done.map((id) => ({ no: (project?.scenes.findIndex((s) => s.id === id) ?? -1) + 1, title: project?.scenes.find((s) => s.id === id)?.title ?? id })).filter((s) => s.no > 0),
        scopes: scopeLabels ?? [...new Set(list.flatMap((x) => x.scopes))].map((s) => SCOPE_LABEL[s]),
        partial,
        ...(meta.beatIds ? { onlyBeats: meta.beatIds.length } : {}),
      }));
    }
  };

  const intake = (snapshot: Project, results: SceneResponse[], runPreview: boolean, runWho: string, catalog: CompactCatalog | null) => {
    const meta = get().meta;
    const castName = (id: string) => snapshot.cast.find((c) => c.id === id)?.displayName ?? id;
    const fresh: Record<string, Card> = {};
    for (const r of results) {
      const old = snapshot.scenes.find((s) => s.id === r.sceneId);
      if (!old) continue;
      const diff = diffScene(old, alignToOld(old, r.scene), {
        cast: castName,
        model: (id) => {
          const m = catalog?.models.find((x) => x.id === id);
          return m ? costumeLabelZh(m.costumeInfo, m.costume) : id;
        },
      });
      fresh[r.sceneId] = { sceneId: r.sceneId, title: old.title, result: r, diff, scopes: meta.scopes, state: 'pending', checked: Object.keys(diff.counts) as DiffScope[] };
      say('info', `${old.title}：${r.runs.length} 次调用，${r.runs.reduce((n, x) => n + x.ms, 0)} ms，${diff.items.length} 项变化${r.warnings.length ? `，${r.warnings.length} 条修复/警告` : ''}${r.runs.some((x) => x.repaired) ? '，含修复调用' : ''}`);
    }
    set((s) => ({ cards: { ...s.cards, ...fresh } }));
    if (!runPreview) applyCards(Object.values(fresh).filter((c) => c.result.applied).map((card) => ({ card, scopes: meta.scopes })), `${runWho} 生成：${meta.label}`);
    else if (Object.values(fresh).some((c) => !c.result.applied)) set({ error: '有场景因锁定冲突没有应用，详见结果。' });
  };

  return {
    projectId: null,
    controls: { ...DEFAULT_CONTROLS },
    generateOpen: readOpen(),
    busy: false,
    progress: {},
    total: 0,
    cards: {},
    log: [],
    error: null,
    meta: NO_META,

    setControls(patch) {
      set((s) => ({ controls: { ...s.controls, ...patch } }));
    },
    setGenerateOpen(open) {
      writeOpen(open);
      set({ generateOpen: open });
    },
    setError(error) {
      set({ error });
    },

    bindProject(id) {
      if (get().projectId === id) return;
      get().reset();
      // another project: the options start over too (「覆盖我手改过的内容」 must not carry over to a project the person has not looked at)
      set({ projectId: id, controls: { ...DEFAULT_CONTROLS } });
    },

    reset() {
      generation++;
      ctl?.abort();
      ctl = null;
      set({ busy: false, progress: {}, total: 0, cards: {}, log: [], error: null, meta: NO_META });
    },

    unbind() {
      get().reset();
      set({ projectId: null, controls: { ...DEFAULT_CONTROLS } });
    },

    cancel() {
      ctl?.abort();
    },

    async run(all, options = {}, env, api = realApi) {
      if (ctl) return;
      const live = useProject.getState();
      const snapshot = live.project;
      const selection = live.selection;
      const current = snapshot?.scenes.find((s) => s.id === selection.sceneId) ?? snapshot?.scenes[0];
      const runScene = snapshot?.scenes.find((s) => s.id === (options.sceneId ?? current?.id));
      const multi = options.sceneIds;
      if (!snapshot?.source.text || (!all && !multi && !runScene)) return;
      const c = get().controls;
      const runScope = options.scope ?? c.scope;
      const runPreview = options.preview ?? c.preview;
      const runOverwrite = options.overwriteUser ?? c.overwriteUser;
      const runOnlyBeat = options.onlyBeat ?? c.onlyBeat;
      const runUseRule = options.engine ? options.engine === 'rule' : usesRule(c.engine, env.configured);
      const runWho = whoLabel(runUseRule, env.provider);
      const mine = generation;
      const alive = () => mine === generation;
      const mineCtl = new AbortController();
      ctl = mineCtl;
      const signal = mineCtl.signal;
      set({ busy: true, error: null, progress: {}, cards: {} });
      const scopes: ScopeName[] = all ? ['scene'] : [runScope];
      const beatIds = !all && runOnlyBeat && selection.beatId ? [selection.beatId] : undefined;
      set({ meta: { scopes, ...(beatIds ? { beatIds } : {}), overwrite: runOverwrite, who: runWho, label: all ? '全部场景' : multi ? `${multi.length} 个场景 · ${SCOPE_LABEL[runScope]}` : `${runScene?.title ?? ''} · ${SCOPE_LABEL[runScope]}${beatIds ? '（所选台词）' : ''}` } });
      const eng = runUseRule ? ({ engine: 'rule' } as const) : c.useMem ? {} : { useMemories: false };
      // only 「换一版」 sends `refresh`; every other request is byte-identical to what it always was
      const fresh = options.refresh === true ? ({ refresh: true } as const) : {};
      const titleOf = (id: string) => snapshot.scenes.find((s) => s.id === id)?.title ?? id;
      const got: SceneResponse[] = [];
      try {
        if (all) {
          set({ total: snapshot.scenes.length });
          say('info', `开始生成全部场景（${runWho}，并发 3）`);
          try {
            await api.postScenes(snapshot, { scopes, overwriteUser: runOverwrite, ...eng, ...fresh }, (p) => {
              if (!alive()) return;
              set((s) => ({ progress: { ...s.progress, [p.sceneId]: p } }));
              if (p.state === 'done' && p.result) got.push(p.result);
              if (p.state === 'error') say('error', `${titleOf(p.sceneId)}：${p.message ?? ''}`);
            }, signal);
          } catch (e) {
            if ((e as Error).name !== 'AbortError') throw e;
            if (alive()) say('info', `已取消：保留已完成的 ${got.length} 个场景，可再次点击继续（已完成的有缓存，不会重复调用）`);
          }
        } else if (multi) {
          set({ total: multi.length });
          say('info', `开始：${multi.length} 个场景 · ${SCOPE_LABEL[runScope]}（${runWho}，逐场景依次请求）`);
          for (const id of multi) {
            const title = titleOf(id);
            if (signal.aborted) break;
            set((s) => ({ progress: { ...s.progress, [id]: { sceneId: id, title, state: 'start' } } }));
            try {
              const result = await api.postScene(snapshot, id, { scopes, overwriteUser: runOverwrite, ...eng, ...fresh }, signal);
              got.push(result);
              if (alive()) set((s) => ({ progress: { ...s.progress, [id]: { sceneId: id, title, state: 'done', result } } }));
            } catch (e) {
              if ((e as Error).name === 'AbortError') {
                if (alive()) say('info', `已取消：保留已完成的 ${got.length} 个场景`);
                break;
              }
              const msg = e instanceof DirectorApiError ? e.message : (e as Error).message;
              if (alive()) {
                set((s) => ({ progress: { ...s.progress, [id]: { sceneId: id, title, state: 'error', message: msg } } }));
                say('error', `${title}：${msg}`);
                set({ error: `${title}：${msg}\n已停止，保留已完成的 ${got.length} 个场景。` });
              }
              break;
            }
          }
        } else if (runScene) {
          set({ total: 1 });
          say('info', '开始：' + runScene.title + ' · ' + SCOPE_LABEL[runScope] + '（' + runWho + '）');
          got.push(await api.postScene(snapshot, runScene.id, { scopes, ...(beatIds ? { beatIds } : {}), overwriteUser: runOverwrite, ...eng, ...fresh }, signal));
        }
        if (alive()) intake(snapshot, got, runPreview, runWho, env.catalog);
      } catch (e) {
        if (!alive()) return;
        if ((e as Error).name !== 'AbortError') {
          const msg = e instanceof DirectorApiError ? `${e.message}${e.problems.length ? `\n${e.problems.join('\n')}` : ''}` : (e as Error).message;
          set({ error: msg });
          say('error', msg.split('\n')[0]!);
        } else say('info', '已取消');
      } finally {
        if (alive()) set({ busy: false });
        if (ctl === mineCtl) ctl = null;
      }
    },

    accept(sceneId, all) {
      const card = get().cards[sceneId];
      if (!card) return;
      const { meta } = get();
      const scopes: ScopeName[] = all ? meta.scopes : (card.checked.filter((s) => s !== 'structure') as ScopeName[]);
      applyCards([{ card, scopes }], `${meta.who}：接受「${card.title}」${all ? '' : '（部分范围）'}`, !all, all ? undefined : card.checked.filter((s) => s !== 'structure').map((s) => DIFF_LABEL[s]));
    },

    acceptAll() {
      const { cards, meta } = get();
      const pend = Object.values(cards).filter((c) => c.state === 'pending' && c.result.applied);
      if (pend.length > 0) applyCards(pend.map((card) => ({ card, scopes: meta.scopes })), `${meta.who}：接受 ${pend.length} 个场景的演出`);
    },

    reject(sceneId) {
      set((s) => (s.cards[sceneId] ? { cards: { ...s.cards, [sceneId]: { ...s.cards[sceneId]!, state: 'rejected' } } } : s));
    },

    rejectAll() {
      set((s) => ({ cards: Object.fromEntries(Object.entries(s.cards).map(([k, v]) => [k, v.state === 'pending' ? { ...v, state: 'rejected' as const } : v])) }));
    },

    toggleScope(sceneId, scope) {
      set((s) => {
        const c = s.cards[sceneId];
        if (!c) return s;
        return { cards: { ...s.cards, [sceneId]: { ...c, checked: c.checked.includes(scope) ? c.checked.filter((x) => x !== scope) : [...c.checked, scope] } } };
      });
    },
  };
});
