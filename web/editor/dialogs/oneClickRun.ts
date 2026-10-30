/**
 * The first-run requests of the home dialog, out of the component so that their parameters can be locked by unit tests: the breakdown
 * (「先分场看看」) and the one-click run (「分场并生成全部」: breakdown once -> project -> the scenes that are not directed yet, 3 at a time,
 * cancellable and resumable). The calls and their argument order are the ones the dialog always made.
 */
import { mergeLocks } from '@shared/director/mergeLocks';
import type { Project } from '@shared/schema/project';
import { postBreakdown, postScenes, type BatchProgress, type BreakdownResponse, type SceneResponse } from '../../directorApi';
import { createProject, saveProject } from '../../projectsApi';
import { oneClickText } from '../../store/agentNotes';
import { makeEntry, type OnboardEntry } from '../../store/aiFlow';
import { isDirectedBeat } from '../panels/directorRun';

export type FirstRunEngine = 'rule' | undefined;

/** The requests, injectable so that tests run without a server. */
export interface OneClickApi {
  postBreakdown: typeof postBreakdown;
  postScenes: typeof postScenes;
  createProject: typeof createProject;
  saveProject: typeof saveProject;
}
export const realOneClickApi: OneClickApi = { postBreakdown, postScenes, createProject, saveProject };

export const UNTITLED = '未命名项目';

/** A scene that still has only the breakdown's skeleton lines (or none). */
export const isUndirectedScene = (s: Project['scenes'][number]): boolean => s.beats.length === 0 || s.beats.every((b) => !isDirectedBeat(b));

/** 「先分场看看」 / 「重新分场」: the breakdown request. `engine` is 'rule' for the rule generator, undefined for the AI. */
export function runBreakdown(input: { text: string; title: string; refresh: boolean; engine: FirstRunEngine }, api: OneClickApi = realOneClickApi): Promise<BreakdownResponse> {
  return api.postBreakdown(input.text, input.title.trim() || UNTITLED, input.refresh, undefined, input.engine);
}

export interface OneClickInput {
  text: string;
  title: string;
  engine: FirstRunEngine;
  /** AI engine only: should the saved style memories be used (false sends `useMemories:false`). */
  useMem: boolean;
  /** The project a former run already created (a resume continues in it). */
  local: { project: Project; etag: string } | null;
  /** Scenes that failed last time: they are redone even when they look generated. */
  retry: ReadonlySet<string>;
  signal: AbortSignal;
}
export interface OneClickHooks {
  onStage(text: string): void;
  onBreakdown(bd: BreakdownResponse): void;
  onCreated(created: { project: Project; etag: string }): void;
  /** The scenes of the project and which of them this run generates. */
  onPlan(current: Project, todo: string[]): void;
  onProgress(p: BatchProgress): void;
  onResult(r: SceneResponse): void;
}
export interface OneClickOutcome {
  local: { project: Project; etag: string };
  /** The run was cancelled while generating scenes (what finished is kept). */
  aborted: boolean;
}

/**
 * Breakdown (once) -> project -> the scenes that are not directed yet. Safe to call again after a cancel or a failure. Throws on a failed
 * breakdown / save / batch request (an AbortError of the batch itself is `aborted`, not a throw).
 */
export async function runOneClick(input: OneClickInput, hooks: OneClickHooks, api: OneClickApi = realOneClickApi): Promise<OneClickOutcome> {
  let local = input.local;
  if (!local) {
    hooks.onStage('分场（场景 / 角色 / 背景 / 服装）…');
    const bd = await api.postBreakdown(input.text, input.title.trim() || UNTITLED, false, input.signal, input.engine);
    hooks.onBreakdown(bd);
    const r = await api.createProject(bd.project);
    local = { project: r.project, etag: r.etag };
    hooks.onCreated(local);
  }
  const current = local.project;
  const todo = current.scenes.filter((s) => input.retry.has(s.id) || isUndirectedScene(s)).map((s) => s.id);
  hooks.onPlan(current, todo);
  let aborted = false;
  if (todo.length > 0) {
    hooks.onStage(`逐场景生成演出（${todo.length} 个场景，并发 3）…`);
    try {
      await api.postScenes(current, { scopes: ['scene'], sceneIds: todo, ...(input.engine ? { engine: input.engine } : input.useMem ? {} : { useMemories: false }) }, (p) => {
        hooks.onProgress(p);
        if (p.state === 'done' && p.result) hooks.onResult(p.result);
      }, input.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') throw e;
      aborted = true;
    }
  }
  return { local, aborted };
}

/** What finished is applied to the project (the lock-enforcing merge, one save) and saved, also after a cancel or a failure. */
export async function applyAndSave(local: { project: Project; etag: string }, results: SceneResponse[], api: OneClickApi = realOneClickApi): Promise<{ project: Project; etag: string }> {
  const next = JSON.parse(JSON.stringify(local.project)) as Project;
  for (const r of results) {
    const k = next.scenes.findIndex((x) => x.id === r.sceneId);
    if (k < 0) continue;
    const merged = mergeLocks(next.scenes[k]!, r.scene, { scopes: ['scene'] });
    if (merged.applied) next.scenes[k] = merged.scene;
  }
  const saved = await api.saveProject(next, local.etag);
  return { project: saved.project, etag: saved.etag };
}

// ---------------------------------------------------------------------------------------------------------- hand-over to the editor

/** The breakdown as the first card of the editor's stream (what the dialog showed, folded to one line). */
export function breakdownEntry(p: { who: string; userText: string; scenes: string[]; cast: number; warnings: number }): OnboardEntry {
  const names = p.scenes.map((t, i) => `第${i + 1}场「${t}」`);
  return makeEntry({
    kind: 'breakdown', userText: p.userText, title: `分场 · ${p.scenes.length} 场`, who: p.who, state: 'done',
    summary: `${p.scenes.length} 个场景 · ${p.cast} 个角色${p.warnings > 0 ? ` · ${p.warnings} 条自动修复 / 警告` : ''}`,
    lines: names,
    historyText: `分场（${p.who}）：从小说拆出 ${p.scenes.length} 个场景、${p.cast} 个角色：${names.slice(0, 6).join('、')}${names.length > 6 ? `等 ${names.length} 场` : ''}`,
  });
}

/** The one-click generation as the second card. */
export function generateEntry(p: { who: string; done: number; total: number; failed: number; warnings: number; notes: string[]; userText?: string }): OnboardEntry {
  const rest = p.total - p.done;
  return makeEntry({
    kind: 'generate', ...(p.userText ? { userText: p.userText } : {}), title: `生成演出 · ${p.done}/${p.total} 场`, who: p.who, state: p.failed > 0 ? 'partial' : rest > 0 ? 'partial' : 'done',
    summary: `${p.done} 场已生成${p.failed > 0 ? `，${p.failed} 场失败` : rest > 0 ? `，还有 ${rest} 场没生成` : ''} · 连续性提示 ${p.warnings} 条`,
    lines: p.notes, canResume: p.failed > 0 || rest > 0,
    historyText: oneClickText({ who: p.who, done: p.done, total: p.total, failed: p.failed, warnings: p.warnings }),
  });
}

/** After the review path: the project has the skeleton only; the card offers 「生成全部场景」. */
export function skeletonEntry(p: { who: string; scenes: number }): OnboardEntry {
  return makeEntry({
    kind: 'skeleton', title: `已建 ${p.scenes} 场骨架`, who: p.who, state: 'pending', canGenerateAll: true,
    summary: `已建 ${p.scenes} 场骨架，还没生成演出。点「生成全部场景」让${p.who === '规则' ? '规则生成' : ' AI '}逐场生成，也可以在输入框旁的「生成 ▾」里选一场。`,
    lines: [],
    historyText: `已建 ${p.scenes} 场骨架，还没有生成演出（用户之后可以让 AI 生成全部场景）`,
  });
}
