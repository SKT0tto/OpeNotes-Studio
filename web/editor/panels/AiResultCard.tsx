/**
 * One scene's proposal inside a generation card: provenance, the diff against the current scene (grouped by scope, each group can be ticked),
 * and the verbs 应用全部 / 应用所选 / 拒绝 / 微调. The card shell around it is `ai/AiCard.tsx`; this is only the scene's own part.
 */
import { Fragment, useMemo } from 'react';
import { DIFF_LABEL, type DiffScope } from '@shared/director/diff';
import { shownState, type Card, type ShownState } from './ai/genTurn';
import { clip } from '@shared/agent/compact';

export type { Card, CardState } from './ai/genTurn';

export const providerLabel = (provider: string, model: string) =>
  provider === 'rule' ? '规则生成（非 AI）' : provider === 'fixture' ? '测试回放（非 AI）' : `${provider === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${model}`;

const ORDER: DiffScope[] = ['structure', 'camera', 'performance', 'costume', 'staging', 'fx'];

const STATE_TEXT: Record<ShownState, string> = { pending: '待确认', accepted: '已应用', rejected: '已拒绝', undone: '已撤销' };

export function SceneResult({ card, live, open, single = false, onToggle, onAccept, onReject, onRefine }: {
  card: Card;
  /** Is this undo step still applied? (a result whose step is gone reads 已撤销) */
  live: (stepId: number) => boolean;
  /** Start unfolded (one scene, or few). */
  open: boolean;
  /** The only scene of its card: the card header already says who / what / state, so this heading shrinks to the facts. */
  single?: boolean;
  onToggle: (scope: DiffScope) => void;
  onAccept: (all: boolean) => void;
  onReject: () => void;
  /** 「微调」: selects this scene and puts 「第N场：」 in the input (nothing is sent). */
  onRefine?: () => void;
}) {
  const { result: r, diff } = card;
  const run = r.runs[0];
  const tokens = r.runs.reduce((n, x) => n + x.usage.inputTokens + x.usage.outputTokens, 0);
  const ms = r.runs.reduce((n, x) => n + x.ms, 0);
  const isRule = run?.provider === 'rule';
  const shown = shownState(card, live);
  const scopes = useMemo(() => ORDER.filter((s) => (diff.counts[s] ?? 0) > 0), [diff]);
  const selectable = scopes.filter((s) => s !== 'structure');
  const allChecked = selectable.every((s) => card.checked.includes(s));
  const nSel = selectable.filter((s) => card.checked.includes(s)).length;
  // nothing differs from the scene as it is: there is nothing to confirm, so the result is settled (no 待确认, no 应用)
  const unchanged = shown === 'pending' && r.applied && diff.items.length === 0;
  const stateText = unchanged ? '没有变化' : shown === 'pending' && !r.applied ? '未应用（锁定冲突）' : STATE_TEXT[shown];
  const tone = shown === 'accepted' ? 'ok' : shown === 'pending' ? (unchanged ? 'hint' : r.applied ? 'warn' : 'bad') : 'hint';
  return (
    <details className={`ai-result ai-card-${shown}${single ? ' single' : ''}`} open={open} data-testid="ai-result" data-scene={r.sceneId} data-state={shown === 'undone' ? 'undone' : card.state}>
      <summary className="ai-result-head">
        <strong>{card.title}</strong>
        <span className={`src ${isRule ? 'src-rule' : 'src-ai'}`} data-testid="ai-origin">{isRule ? '规则' : run?.provider === 'fixture' ? '回放' : 'AI'}</span>
        <span className={tone} data-testid="ai-state">{stateText}</span>
        {r.cached && <span className="badge" data-testid="ai-cached" title="输入没有变化，直接用了上次的结果；想要不同的结果请点「换一版」">缓存</span>}
        {diff.items.length > 0 && <span className="hint">{diff.items.length} 项变化</span>}
      </summary>
      {r.conflicts.length > 0 && <ul className="bad" data-testid="ai-conflicts">{r.conflicts.map((c, i) => <li key={i}>{c.label}</li>)}</ul>}
      {r.report.protectedKept.length > 0 && (
        <details>
          <summary className="hint" data-testid="ai-kept">保留了 {r.report.protectedKept.length} 项锁定 / 人工内容（跳过，不会被改）</summary>
          <ul className="ai-warn">{r.report.protectedKept.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </details>
      )}
      {r.applied && shown !== 'pending' && scopes.length > 0 && (
        <p className="hint ai-diff-line">{scopes.map((sc) => `${DIFF_LABEL[sc]} ${diff.counts[sc]}`).join(' · ')}</p>
      )}
      {unchanged && <p className="hint" data-testid="ai-unchanged">与当前内容没有差别，没有需要应用的改动。</p>}
      {r.applied && shown === 'pending' && !unchanged && (
        <div className="ai-diff" data-testid="ai-diff">
          {scopes.length === 0 ? <p className="hint">与当前内容没有差别。</p> : (
            <>
              <p className="hint">
                将被改 {diff.items.length} 项{diff.structural ? '（含台词结构变化：台词结构只能整体应用；其余范围可单独选择，只作用于台词没变的句子）' : '（可按范围选择）'}
                {Object.values(diff.ruleFilled).reduce((a, b) => a + (b ?? 0), 0) > 0 && ` · 规则补位 ${Object.values(diff.ruleFilled).reduce((a, b) => a + (b ?? 0), 0)} 个关键帧`}
              </p>
              {scopes.map((s) => (
                <details key={s} className="ai-diff-scope" data-testid={`ai-diff-${s}`}>
                  <summary>
                    {card.state === 'pending' && (
                      <input type="checkbox" disabled={s === 'structure'} checked={s !== 'structure' && card.checked.includes(s)} onClick={(e) => e.stopPropagation()} onChange={() => onToggle(s)} data-testid={`ai-check-${s}`} />
                    )}
                    {' '}{DIFF_LABEL[s]} <span className="badge">{diff.counts[s]}</span>
                  </summary>
                  <table className="ai-diff-table">
                    <tbody>
                      {diff.items.filter((i) => i.scope === s).slice(0, 80).map((i, k) => (
                        <Fragment key={k}>
                          <tr className="diff-head"><td className="where">{i.where}</td><td>{i.field}</td></tr>
                          <tr><td colSpan={2} className="diff-vals"><span className="del">{i.before}</span> → <span className="add">{i.after}</span></td></tr>
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </details>
              ))}
            </>
          )}
        </div>
      )}
      {r.splits && r.splits.length > 0 && <SplitSection splits={r.splits} />}
      {r.warnings.length > 0 && (
        <details>
          <summary data-testid="ai-warnings">{r.warnings.length} 条修复 / 警告</summary>
          <ul className="ai-warn">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      {(card.state === 'pending' || onRefine) && (
        <div className="ai-actions">
          {card.state === 'pending' && r.applied && !unchanged && (
            <>
              <button className="btn primary" onClick={() => onAccept(true)} data-testid="ai-accept-all">应用全部</button>
              {selectable.length > 0 && (diff.structural || selectable.length > 1) && <button className="btn" disabled={nSel === 0 || (!diff.structural && allChecked)} onClick={() => onAccept(false)} data-testid="ai-accept-sel">应用所选 ({nSel})</button>}
              <button className="btn" onClick={onReject} data-testid="ai-reject">拒绝</button>
            </>
          )}
          {onRefine && <button className="btn" onClick={onRefine} data-testid="ai-refine-assistant" title="选中这一场，并在输入框里写上「第N场：」，由你补充要求；不会自动发送">微调</button>}
        </div>
      )}
      <details className="ai-detail">
        <summary>{isRule ? '规则给出的演出意图' : '模型给出的演出意图'}（{r.direction.beats.length} 个节拍） · {run ? providerLabel(run.provider, run.model) : ''} · {r.runs.length} 次调用 · {ms} ms{tokens > 0 ? ` · ${tokens} tokens` : ''}{r.runs.some((x) => x.repaired) ? ' · 含一次修复调用' : ''}</summary>
        {!isRule && <p className="hint">{r.direction.reason}</p>}
        <pre className="ai-json" data-testid="ai-intent">{JSON.stringify(r.direction, null, 1)}</pre>
      </details>
    </details>
  );
}

const BY_LABEL = { ai: 'AI 拆分', retry: 'AI 拆分（重试）', rule: '规则拆分' } as const;

/** 「长句拆分 N」: the long lines this result cut into consecutive lines: the original line, its pieces, who cut it and why there. */
function SplitSection({ splits }: { splits: NonNullable<Card['result']['splits']> }) {
  return (
    <details className="ai-splits" data-testid="ai-splits">
      <summary>长句拆分 <span className="badge" data-testid="ai-splits-count">{splits.length}</span> <span className="hint">放不进对话框的台词，按语义拆成连续几句</span></summary>
      <ul>
        {splits.map((sp) => (
          <li key={sp.beatId} data-testid="ai-split" data-by={sp.by}>
            <span className="from">「{clip(sp.pieces.map((p) => p.text).join(''), 36)}」 → {sp.pieces.length} 句 · {BY_LABEL[sp.by]}</span>
            {sp.pieces.map((p, i) => (
              <span key={i} className="piece" data-testid="ai-split-piece">{i + 1}. {p.text}{p.why ? <span className="why"> · {p.why}</span> : null}</span>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}
