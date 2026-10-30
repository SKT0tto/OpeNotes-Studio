/**
 * The generation logic of the AI panel, out of the components: the options (`controls`), the requests, and the generation turns that go into
 * the panel's one stream (`ai/genTurn.ts`): progress, the proposals as cards, applying / rejecting. It used to live in a component that was
 * mounted only while its tab was in front, so switching tabs aborted a run and dropped a result nobody had accepted yet. In a store it survives
 * the panel being hidden, collapsed or re-mounted; leaving the project (or the editor) ends it (`reset`).
 *
 * Nothing about the requests changed: the same `postScene` / `postScenes` calls with the same options, in the same key order (`refresh` is
 * only present for 「换一版」). Applying still runs through the lock-enforcing `mergeLocks` inside one `applyEdit` = one undo step.
 */
import { create } from 'zustand';
import { costumeLabelZh } from '@shared/catalog/labels';
import { catalogLookups, checkContinuity } from '@shared/director/continuity';
import { alignToOld, diffScene, type DiffScope } from '@shared/director/diff';
import { mergeLocks } from '@shared/director/mergeLocks';
import { SCOPE_LABEL, type ScopeName } from '@shared/director/scope';
import type { CompactCatalog } from '@shared/schema/assets';
import type { Project } from '@shared/schema/project';
import { DirectorApiError, postScene, postScenes, type SceneResponse } from '../../directorApi';
import { nextOrder } from '../../store/aiFlow';
import { useProject } from '../../store/projectStore';
import { notify } from '../../store/uiStore';
import type { Card, Engine, GenTurn, LogLine, RunOptions } from './ai/genTurn';

export type { Card, CardState, Engine, GenTurn, LogLine, RunOptions } from './ai/genTurn';

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
  /** What 「生成」 acts on: the selected scene (or, with `onlyBeat`, the selected lines), every scene, or only those not generated yet. */
  target: 'scene' | 'all' | 'missing';
  engine: Engine;
  scope: ScopeName;
  onlyBeat: boolean;
  overwriteUser: boolean;
  preview: boolean;
  useMem: boolean;
}
export const DEFAULT_CONTROLS: DirectorControls = { target: 'scene', engine: 'ai', scope: 'scene', onlyBeat: false, overwriteUser: false, preview: true, useMem: true };

/** 「规则 / 回放 / AI」: who made the proposal. */
export const whoLabel = (useRule: boolean, provider: string | null | undefined): string => (useRule ? '规则' : provider === 'fixture' ? '回放' : 'AI');
/** The rule generator is used when it was picked or when no AI is configured. */
export const usesRule = (engine: Engine, configured: boolean): boolean => engine === 'rule' || !configured;

/** A line the generator wrote itself (the rule generator's skeleton lines quote the source paragraph); anything else counts as generated. */
export const isDirectedBeat = (b: { meta: { source: string; reason?: string | undefined } }): boolean => !(b.meta.source === 'rule' && b.meta.reason?.startsWith('原文段落'));
/** Has this scene been generated (by the AI, the rule generator or by hand) rather than only broken down? */
export const isDirectedScene = (s: { beats: Array<{ meta: { source: string; reason?: string | undefined } }> }): boolean => s.beats.length > 0 && s.beats.some(isDirectedBeat);

interface DirectorState {
  projectId: string | null;
  controls: DirectorControls;
  busy: boolean;
  /** The generation turns of this project, oldest first (the stream interleaves them with the assistant's turns by `order`). */
  turns: GenTurn[];
  setControls(patch: Partial<DirectorControls>): void;
  /** Called with the open project's id: another project ends the run and clears the turns. */
  bindProject(id: string | null): void;
  /** Abort a running request and clear the turns; the options stay (they are the person's settings, not results). */
  reset(): void;
  /** The project was left (the editor closed or another project opened): `reset`, the options back to their defaults, and forget which project it was. */
  unbind(): void;
  run(all: boolean, options: RunOptions | undefined, env: DirectorEnv, api?: DirectorApi): Promise<void>;
  cancel(): void;
  accept(turnId: number, sceneId: string, all: boolean): void;
  acceptAll(turnId: number): void;
  reject(turnId: number, sceneId: string): void;
  rejectAll(turnId: number): void;
  toggleScope(turnId: number, sceneId: string, scope: DiffScope): void;
  /** 「撤销这次」: undo the newest application of the turn, when it is still the top of the undo stack. */
  undo(turnId: number): void;
  /** Drop a turn (a command that was routed here by mistake); cancels it when it is running. */
  discard(turnId: number): void;
}

let ctl: AbortController | null = null;
/** Bumped by `reset`: a request that was started before it must not write into the store any more. */
let generation = 0;
let turnSeq = 0;

export const useDirectorRun = create<DirectorState>((set, get) => {
  const patchTurn = (id: number, f: (t: GenTurn) => GenTurn) => set((s) => ({ turns: s.turns.map((t) => (t.id === id ? f(t) : t)) }));
  const turnOf = (id: number) => get().turns.find((t) => t.id === id);
  const say = (id: number, kind: LogLine['kind'], text: string) => patchTurn(id, (t) => ({ ...t, log: [...t.log.slice(-60), { at: Date.now(), kind, text }] }));

  /** Applies proposals to the CURRENT scenes through the lock-enforcing merge; one undo step. */
  const applyCards = (turnId: number, list: Array<{ card: Card; scopes: ScopeName[] }>, label: string, partial = false) => {
    const turn = turnOf(turnId);
    if (!turn) return;
    const conflicts: string[] = [];
    const done: string[] = [];
    const before = useProject.getState().undoId;
    const ok = useProject.getState().applyEdit((d) => {
      for (const { card, scopes } of list) {
        const k = d.scenes.findIndex((s) => s.id === card.sceneId);
        if (k < 0) continue;
        const cur = JSON.parse(JSON.stringify(d.scenes[k])) as Project['scenes'][number];
        const merged = mergeLocks(cur, partial ? alignToOld(cur, card.result.scene) : card.result.scene, {
          scopes, ...(turn.beatIds ? { beatIds: turn.beatIds } : {}), overwriteUser: turn.overwrite,
        });
        if (merged.applied) {
          d.scenes[k] = merged.scene as never;
          done.push(card.sceneId);
        } else conflicts.push(...merged.conflicts.map((c) => c.label));
      }
    }, label);
    const after = useProject.getState().undoId;
    const stepId = ok && after !== null && after !== before ? after : undefined;
    if (ok) {
      patchTurn(turnId, (t) => {
        const cards = { ...t.cards };
        for (const { card } of list) if (cards[card.sceneId] && done.includes(card.sceneId)) cards[card.sceneId] = { ...cards[card.sceneId]!, state: 'accepted', ...(stepId !== undefined ? { stepId } : {}) };
        return { ...t, cards, steps: stepId !== undefined ? [...t.steps, { stepId, sceneIds: done }] : t.steps };
      });
    }
    if (conflicts.length > 0) patchTurn(turnId, (t) => ({ ...t, error: `锁定冲突，没有应用：\n${conflicts.join('\n')}` }));
    else if (ok) notify(`${label}（Ctrl+Z 可撤销）`, 'info');
  };

  const intake = (turnId: number, snapshot: Project, results: SceneResponse[], runPreview: boolean, catalog: CompactCatalog | null) => {
    const turn = turnOf(turnId);
    if (!turn) return;
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
      fresh[r.sceneId] = { sceneId: r.sceneId, title: old.title, result: r, diff, scopes: turn.scopes, state: 'pending', checked: Object.keys(diff.counts) as DiffScope[] };
      say(turnId, 'info', `${old.title}：${r.runs.length} 次调用，${r.runs.reduce((n, x) => n + x.ms, 0)} ms，${diff.items.length} 项变化${r.splits?.length ? `，拆分 ${r.splits.length} 句长台词（${[['ai', 'AI'], ['retry', '重试后 AI'], ['rule', '按标点']].map(([k, n]) => [n, r.splits!.filter((x) => x.by === k).length] as const).filter(([, c]) => c > 0).map(([n, c]) => `${n} ${c}`).join('，')}）` : ''}${r.warnings.length ? `，${r.warnings.length} 条修复/警告` : ''}${r.runs.some((x) => x.repaired) ? '，含修复调用' : ''}`);
    }
    // the cards in scene order, whatever order the answers came in
    const order = new Map(snapshot.scenes.map((s, i) => [s.id, i]));
    const sorted = Object.fromEntries(Object.entries(fresh).sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
    patchTurn(turnId, (t) => ({ ...t, cards: sorted }));
    if (!runPreview) applyCards(turnId, Object.values(sorted).filter((c) => c.result.applied).map((card) => ({ card, scopes: turn.scopes })), `${turn.who} 生成：${turn.label}`);
    else if (Object.values(sorted).some((c) => !c.result.applied)) patchTurn(turnId, (t) => ({ ...t, error: '有场景因锁定冲突没有应用，详见结果。' }));
  };

  return {
    projectId: null,
    controls: { ...DEFAULT_CONTROLS },
    busy: false,
    turns: [],

    setControls(patch) {
      set((s) => ({ controls: { ...s.controls, ...patch } }));
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
      set({ busy: false, turns: [] });
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
      // 「还没生成的场景」: the scenes that are only broken down, in one batch request (the one-click generation's request)
      const batchIds = options.batchIds;
      if (!snapshot?.source.text || (!all && !multi && !batchIds && !runScene)) return;
      const wide = all || !!batchIds;
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
      const scopes: ScopeName[] = wide ? ['scene'] : [runScope];
      const beatIds = !wide ? options.beatIds ?? (runOnlyBeat && selection.beatId ? [selection.beatId] : undefined) : undefined;
      const label = all ? '全部场景' : batchIds ? `${batchIds.length} 个还没生成的场景` : multi ? `${multi.length} 个场景 · ${SCOPE_LABEL[runScope]}` : `${runScene?.title ?? ''} · ${SCOPE_LABEL[runScope]}${beatIds ? '（所选台词）' : ''}`;
      const no = (id: string) => (snapshot.scenes.findIndex((s) => s.id === id) + 1) || 0;
      const verb = options.refresh ? '换一版：' : '';
      const redo = all ? snapshot.scenes.some(isDirectedScene) : batchIds ? false : multi ? multi.some((id) => { const s = snapshot.scenes.find((x) => x.id === id); return !!s && isDirectedScene(s); }) : !!runScene && isDirectedScene(runScene);
      const userText = options.userText
        ?? (all ? `${verb}${redo ? '重新生成' : '生成'}全部场景`
          : batchIds ? `${verb}生成还没生成的 ${batchIds.length} 个场景`
          : multi ? `${verb}重新生成 ${multi.length} 个场景 · ${SCOPE_LABEL[runScope]}`
            : `${verb}${redo ? '重新生成' : '生成'} 第${no(runScene!.id)}场「${runScene!.title}」· ${SCOPE_LABEL[runScope]}${beatIds ? `（选中的 ${beatIds.length} 句）` : ''}`);
      const turnId = ++turnSeq;
      const turn: GenTurn = {
        id: turnId, order: nextOrder(), userText, ...(options.userText ? { routed: options.userText } : {}), who: runWho, label, scopes,
        ...(beatIds ? { beatIds } : {}), overwrite: runOverwrite, all,
        request: {
          ...(all ? {} : batchIds ? { batchIds } : multi ? { sceneIds: multi } : { sceneId: runScene!.id }), scope: runScope, preview: runPreview, overwriteUser: runOverwrite, onlyBeat: runOnlyBeat,
          ...(beatIds ? { beatIds } : {}), engine: runUseRule ? 'rule' : 'ai',
        },
        sceneIds: all ? snapshot.scenes.map((s) => s.id) : batchIds ?? multi ?? [runScene!.id],
        status: 'running', preview: runPreview, progress: {}, total: 0, cards: {}, log: [], error: null, steps: [],
      };
      set((s) => ({ busy: true, turns: [...s.turns, turn] }));
      const eng = runUseRule ? ({ engine: 'rule' } as const) : c.useMem ? {} : { useMemories: false };
      // only 「换一版」 sends `refresh`; every other request is byte-identical to what it always was
      const fresh = options.refresh === true ? ({ refresh: true } as const) : {};
      const titleOf = (id: string) => snapshot.scenes.find((s) => s.id === id)?.title ?? id;
      const got: SceneResponse[] = [];
      let failed: string | null = null;
      try {
        if (wide) {
          patchTurn(turnId, (t) => ({ ...t, total: batchIds ? batchIds.length : snapshot.scenes.length }));
          say(turnId, 'info', `开始生成${batchIds ? `${batchIds.length} 个还没生成的场景` : '全部场景'}（${runWho}，并发 3）`);
          try {
            await api.postScenes(snapshot, { scopes, ...(batchIds ? { sceneIds: batchIds } : {}), overwriteUser: runOverwrite, ...eng, ...fresh }, (p) => {
              if (!alive()) return;
              patchTurn(turnId, (t) => ({ ...t, progress: { ...t.progress, [p.sceneId]: p } }));
              if (p.state === 'done' && p.result) got.push(p.result);
              if (p.state === 'error') say(turnId, 'error', `${titleOf(p.sceneId)}：${p.message ?? ''}`);
            }, signal);
          } catch (e) {
            if ((e as Error).name !== 'AbortError') throw e;
            if (alive()) say(turnId, 'info', `已取消：保留已完成的 ${got.length} 个场景，可再次点击继续（已完成的有缓存，不会重复调用）`);
          }
        } else if (multi) {
          patchTurn(turnId, (t) => ({ ...t, total: multi.length }));
          say(turnId, 'info', `开始：${multi.length} 个场景 · ${SCOPE_LABEL[runScope]}（${runWho}，逐场景依次请求）`);
          for (const id of multi) {
            const title = titleOf(id);
            if (signal.aborted) break;
            patchTurn(turnId, (t) => ({ ...t, progress: { ...t.progress, [id]: { sceneId: id, title, state: 'start' } } }));
            try {
              const result = await api.postScene(snapshot, id, { scopes, overwriteUser: runOverwrite, ...eng, ...fresh }, signal);
              got.push(result);
              if (alive()) patchTurn(turnId, (t) => ({ ...t, progress: { ...t.progress, [id]: { sceneId: id, title, state: 'done', result } } }));
            } catch (e) {
              if ((e as Error).name === 'AbortError') {
                if (alive()) say(turnId, 'info', `已取消：保留已完成的 ${got.length} 个场景`);
                break;
              }
              const msg = e instanceof DirectorApiError ? e.message : (e as Error).message;
              if (alive()) {
                patchTurn(turnId, (t) => ({ ...t, progress: { ...t.progress, [id]: { sceneId: id, title, state: 'error', message: msg } }, error: `${title}：${msg}\n已停止，保留已完成的 ${got.length} 个场景。` }));
                say(turnId, 'error', `${title}：${msg}`);
              }
              break;
            }
          }
        } else if (runScene) {
          patchTurn(turnId, (t) => ({ ...t, total: 1 }));
          say(turnId, 'info', '开始：' + runScene.title + ' · ' + SCOPE_LABEL[runScope] + '（' + runWho + '）');
          got.push(await api.postScene(snapshot, runScene.id, { scopes, ...(beatIds ? { beatIds } : {}), overwriteUser: runOverwrite, ...eng, ...fresh }, signal));
        }
        if (alive()) intake(turnId, snapshot, got, runPreview, env.catalog);
      } catch (e) {
        if (!alive()) return;
        if ((e as Error).name !== 'AbortError') {
          const msg = e instanceof DirectorApiError ? `${e.message}${e.problems.length ? `\n${e.problems.join('\n')}` : ''}` : (e as Error).message;
          failed = msg;
          patchTurn(turnId, (t) => ({ ...t, error: msg }));
          say(turnId, 'error', msg.split('\n')[0]!);
        } else say(turnId, 'info', '已取消');
      } finally {
        if (alive()) {
          const aborted = signal.aborted;
          patchTurn(turnId, (t) => ({ ...t, status: failed !== null && Object.keys(t.cards).length === 0 ? 'failed' : aborted ? 'cancelled' : 'done' }));
          set({ busy: false });
        }
        if (ctl === mineCtl) ctl = null;
      }
    },

    accept(turnId, sceneId, all) {
      const turn = turnOf(turnId);
      const card = turn?.cards[sceneId];
      if (!turn || !card) return;
      const scopes: ScopeName[] = all ? turn.scopes : (card.checked.filter((s) => s !== 'structure') as ScopeName[]);
      applyCards(turnId, [{ card, scopes }], `${turn.who}：应用「${card.title}」${all ? '' : '（部分范围）'}`, !all);
    },

    acceptAll(turnId) {
      const turn = turnOf(turnId);
      if (!turn) return;
      const pend = Object.values(turn.cards).filter((c) => c.state === 'pending' && c.result.applied);
      if (pend.length > 0) applyCards(turnId, pend.map((card) => ({ card, scopes: turn.scopes })), `${turn.who}：应用 ${pend.length} 个场景的演出`);
    },

    reject(turnId, sceneId) {
      patchTurn(turnId, (t) => (t.cards[sceneId] ? { ...t, cards: { ...t.cards, [sceneId]: { ...t.cards[sceneId]!, state: 'rejected' } } } : t));
    },

    rejectAll(turnId) {
      patchTurn(turnId, (t) => ({ ...t, cards: Object.fromEntries(Object.entries(t.cards).map(([k, v]) => [k, v.state === 'pending' ? { ...v, state: 'rejected' as const } : v])) }));
    },

    toggleScope(turnId, sceneId, scope) {
      patchTurn(turnId, (t) => {
        const c = t.cards[sceneId];
        if (!c) return t;
        return { ...t, cards: { ...t.cards, [sceneId]: { ...c, checked: c.checked.includes(scope) ? c.checked.filter((x) => x !== scope) : [...c.checked, scope] } } };
      });
    },

    undo(turnId) {
      const turn = turnOf(turnId);
      const st = useProject.getState();
      const last = turn?.steps.at(-1);
      if (!last || st.undoId !== last.stepId) return;
      st.undo();
    },

    discard(turnId) {
      const turn = turnOf(turnId);
      if (!turn) return;
      if (turn.status === 'running') ctl?.abort();
      set((s) => ({ turns: s.turns.filter((t) => t.id !== turnId) }));
    },
  };
});
