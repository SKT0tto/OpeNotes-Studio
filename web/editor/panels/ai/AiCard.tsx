/**
 * The one card of the AI panel: a generation result, an assistant change set and the first-run dialog's cards all use this shell, so that
 * they look and behave the same: title, source badge (AI / 规则 / 回放), state, 「AI 说」, the body (groups / diff), one row of actions with the
 * same verbs (应用全部 / 应用所选 / 拒绝 / 撤销这次 / 换一版 / 微调), and a 「详情」 fold for the run record.
 */
import type { ReactNode } from 'react';

export type CardTone = 'ok' | 'warn' | 'bad' | 'hint';

export interface AiCardProps {
  /** `data-state` of the shell: pending / applied / partial / undone / rejected / running / failed / done … */
  state: string;
  title: ReactNode;
  /** AI / 规则 / 回放 */
  who?: string | undefined;
  /** The state as the person reads it (待确认 / 已应用 / 已撤销 …). */
  stateLabel?: string | undefined;
  tone?: CardTone | undefined;
  /** 「AI 说」 line. */
  said?: ReactNode;
  /** Right of the state: small grey facts (provider, calls, ms). */
  meta?: ReactNode;
  /** Right under 「AI 说」 (batch actions that are about the whole card, like 应用全部 N 场). */
  topActions?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Content of the 「详情」 fold; the fold is left out when empty. */
  detail?: ReactNode;
  detailLabel?: string;
  saidTestId?: string;
  titleTestId?: string;
  /** The body element (carries the legacy test id of the card kind). */
  bodyTestId?: string;
  bodyAttrs?: Record<string, string | undefined>;
  /** Collapsed to its header line (the first-run dialog's cards in the editor stream). */
  collapsible?: { summary: ReactNode };
  className?: string;
}

export function whoClass(who: string | undefined): string {
  return who === '规则' ? 'src-rule' : 'src-ai';
}

export function AiCard(p: AiCardProps) {
  const body = (
    <>
      {p.said !== undefined && p.said !== null && <div className="ai-said" data-testid={p.saidTestId}><span className="agent-tag">AI 说</span>{p.said}</div>}
      {p.topActions && <div className="ai-actions">{p.topActions}</div>}
      {p.children}
      {p.actions && <div className="ai-actions">{p.actions}</div>}
      {p.detail && (
        <details className="ai-detail" data-testid="ai-detail">
          <summary>{p.detailLabel ?? '详情'}</summary>
          {p.detail}
        </details>
      )}
    </>
  );
  const head = (
    <div className="ai-card-head">
      <span className="ai-card-who" data-testid={p.who === 'AI' ? 'ai-badge' : undefined}>AI</span>
      <strong className="ai-card-title" data-testid={p.titleTestId}>{p.title}</strong>
      {p.who && p.who !== 'AI' && <span className={`src ${whoClass(p.who)}`} data-testid="ai-badge">{p.who}</span>}
      {p.stateLabel && <span className={`ai-card-state ${p.tone ?? 'hint'}`} data-testid="ai-card-state">{p.stateLabel}</span>}
      {p.meta && <span className="hint ai-card-meta">{p.meta}</span>}
    </div>
  );
  return (
    <div className={`ai-card${p.className ? ` ${p.className}` : ''}`} data-testid="ai-card" data-state={p.state}>
      {p.collapsible ? (
        <details className="ai-card-fold">
          <summary>{head}<span className="hint ai-card-summary">{p.collapsible.summary}</span></summary>
          <div className="ai-card-body" data-testid={p.bodyTestId} {...p.bodyAttrs}>{body}</div>
        </details>
      ) : (
        <>
          {head}
          <div className="ai-card-body" data-testid={p.bodyTestId} {...p.bodyAttrs}>{body}</div>
        </>
      )}
    </div>
  );
}
