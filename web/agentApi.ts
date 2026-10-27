import type { AgentSelection } from '@shared/agent/compact';
import type { OpRecord, ToolStats } from '@shared/agent/tools';
import type { HistoryTurn } from '@shared/agent/history';
import type { CaptureRequest } from '@shared/agent/frames';
import type { Project } from '@shared/schema/project';
import type { Verification } from '@shared/agent/verify';
import type { MemoryEvent } from '@shared/agent/memory';
import { answerCapture } from './agentFrames';

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
export type AgentStreamEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'op'; record: OpRecord }
  | { type: 'usage'; usage: Usage; total: Usage }
  | { type: 'ask'; question: string; options: string[] }
  | { type: 'memory'; event: MemoryEvent };

/** The final answer of a turn (see server/agent/loop.ts AgentTurnResult). */
export interface AgentProposal {
  genId: string;
  summary: string;
  applied: OpRecord[];
  pending: OpRecord[];
  question: { question: string; options: string[] } | null;
  unverified: number[];
  claimedWithoutOps: string | null;
  usage: Usage;
  regenUsage: Usage;
  steps: number;
  mode: 'tools' | 'json';
  stats: ToolStats;
  verification?: Verification;
  /** Long-term memory saved / updated / forgotten / proposed in this turn. */
  memory?: MemoryEvent[];
  stopped: string;
  elapsedMs: number;
  model?: string;
}

export class AgentApiError extends Error {
  constructor(public readonly kind: string, message: string) {
    super(message);
  }
}

export interface TurnBody {
  project: Project;
  selection: AgentSelection;
  instruction: string;
  history: HistoryTurn[];
  /** Pictures the user attached (data URLs; videos already sampled into frames). */
  attachments?: Array<{ dataUrl: string; label: string }>;
  /** This page can render frames for `capture_frames` (the editor stage is up). */
  canCapture?: boolean;
}

/** One agent turn: events are reported as they arrive; resolves with the proposal. */
export async function postAgentTurn(body: TurnBody, onEvent: (e: AgentStreamEvent) => void, signal?: AbortSignal): Promise<AgentProposal> {
  const res = await fetch('/api/agent/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => null)) as { error?: { kind?: string; message?: string } } | null;
    throw new AgentApiError(j?.error?.kind ?? 'server', j?.error?.message ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let proposal: AgentProposal | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (\w+)/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || !data) continue;
      const json = JSON.parse(data) as Record<string, unknown>;
      if (ev === 'proposal') proposal = json as unknown as AgentProposal;
      else if (ev === 'capture') void answerCapture(json as unknown as { reqId: string; project: Project; req: CaptureRequest });
      else if (ev === 'failed') throw new AgentApiError(String(json.kind ?? 'server'), String(json.message ?? '失败'));
      else if (ev !== 'done') onEvent(json as unknown as AgentStreamEvent);
    }
  }
  if (!proposal) throw new AgentApiError('server', '连接中断，没有收到结果');
  return proposal;
}

/** A copy of the project in the server's history before an agent run (fire and forget; unsaved projects only get the in-memory snapshot). */
export async function postSnapshot(project: Project): Promise<void> {
  await fetch(`/api/projects/${encodeURIComponent(project.id)}/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project) }).catch(() => {});
}
