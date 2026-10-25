/** 「实时」 auto-apply: only a small, safe change set of the scene the user is in may go in without a preview. */
import { liveForbidden, type AgentOp } from './ops';

export const LIVE_MAX_OPS = 6;

export interface LiveInput {
  /** The scene that was selected when the instruction was sent. */
  sceneId: string | null | undefined;
  /** Scenes of a multi-selection; ops in any of them count as "the scene the user is in". */
  selectedScenes?: string[] | undefined;
  applied: Array<{ tool: string; op: AgentOp; warnings: string[]; overwrote: string[] }>;
  pending: number;
  question: boolean;
  unverified: number;
  stopped: string;
}

/** `auto` = apply without asking; otherwise `reasons` says why the card is shown instead (「不满足实时条件：…」). */
export function liveDecision(i: LiveInput): { auto: boolean; reasons: string[] } {
  const why: string[] = [];
  if (i.applied.length === 0) why.push('没有改动');
  if (i.question) why.push('助手在向你提问');
  if (i.pending > 0) why.push('有需要你确认的锁定 / 手改内容');
  if (i.stopped !== 'done') why.push('本轮没有正常结束');
  if (i.unverified > 0) why.push('有改动没能回读确认');
  const scenes = new Set([...(i.sceneId ? [i.sceneId] : []), ...(i.selectedScenes ?? [])]);
  if (scenes.size === 0 || i.applied.some((a) => !scenes.has(a.op.sceneId))) why.push('改动不止当前场景');
  if (i.applied.length > LIVE_MAX_OPS) why.push(`超过 ${LIVE_MAX_OPS} 项改动`);
  if (i.applied.some((a) => liveForbidden(a.op))) why.push('包含进出场 / 背景 / 结构 / 锁定改动');
  if (i.applied.some((a) => a.tool === 'regenerate_scene_camera')) why.push('包含整场镜头重导');
  if (i.applied.some((a) => a.tool === 'run_script')) why.push('包含 AI 写的脚本（先看一眼脚本再应用）');
  if (i.applied.some((a) => a.overwrote.length > 0)) why.push('会覆盖手改内容');
  if (i.applied.some((a) => a.warnings.length > 0)) why.push('有改动经过了自动修正');
  return { auto: why.length === 0, reasons: why };
}
