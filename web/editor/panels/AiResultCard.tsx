/** One scene's proposal from the AI / rule director: provenance, cost, the diff against the current scene, accept / reject per scope. */
import { Fragment, useMemo } from 'react';
import { DIFF_LABEL, type DiffScope, type SceneDiff } from '@shared/director/diff';
import type { SceneResponse } from '../../directorApi';

export type CardState = 'pending' | 'accepted' | 'rejected';
export interface Card {
  sceneId: string;
  title: string;
  result: SceneResponse;
  diff: SceneDiff;
  /** Scopes of the request (what the run was allowed to change). */
  scopes: string[];
  state: CardState;
  checked: DiffScope[];
}

export const providerLabel = (provider: string, model: string) =>
  provider === 'rule' ? '规则生成（非 AI）' : provider === 'fixture' ? '测试回放（非 AI）' : `${provider === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${model}`;

const ORDER: DiffScope[] = ['structure', 'camera', 'performance', 'costume', 'staging', 'fx'];

export function AiResultCard({ card, onToggle, onAccept, onReject, onRefine }: {
  card: Card;
  onToggle: (scope: DiffScope) => void;
  onAccept: (all: boolean) => void;
  onReject: () => void;
  /** 「让助手微调这一场」: opens the assistant on this scene (selects it, focuses the input; nothing is sent). */
  onRefine?: () => void;
}) {
  const { result: r, diff } = card;
  const run = r.runs[0];
  const tokens = r.runs.reduce((n, x) => n + x.usage.inputTokens + x.usage.outputTokens, 0);
  const ms = r.runs.reduce((n, x) => n + x.ms, 0);
  const isRule = run?.provider === 'rule';
  const scopes = useMemo(() => ORDER.filter((s) => (diff.counts[s] ?? 0) > 0), [diff]);
  const selectable = scopes.filter((s) => s !== 'structure');
  const allChecked = selectable.every((s) => card.checked.includes(s));
  const nSel = selectable.filter((s) => card.checked.includes(s)).length;
  return (
    <li className={`ai-result ai-card-${card.state}`} data-testid="ai-result" data-scene={r.sceneId} data-state={card.state}>
      <div className="ai-result-head">
        <strong>{card.title}</strong>
        <span className={`src ${isRule ? 'src-rule' : 'src-ai'}`} data-testid="ai-origin">{isRule ? '规则' : run?.provider === 'fixture' ? '回放' : 'AI'}</span>
        <span className={card.state === 'accepted' ? 'ok' : card.state === 'rejected' ? 'hint' : r.applied ? 'warn' : 'bad'} data-testid="ai-state">
          {card.state === 'accepted' ? '已接受' : card.state === 'rejected' ? '已拒绝' : r.applied ? '待确认' : '未应用（锁定冲突）'}
        </span>
        {r.cached && <span className="badge" data-testid="ai-cached" title="输入没有变化，直接用了上次的结果；想要不同的结果请点「换一版」">缓存</span>}
        <span className="hint">{run ? providerLabel(run.provider, run.model) : ''} · {r.runs.length} 次调用 · {ms} ms{tokens > 0 ? ` · ${tokens} tokens` : ''}{r.runs.some((x) => x.repaired) ? ' · 含一次修复调用' : ''}</span>
        {onRefine && <button className="btn-s" onClick={onRefine} data-testid="ai-refine-assistant" title="选中这一场并把光标放进 AI 助手的输入框；不会自动发送">让助手微调这一场</button>}
      </div>
      {isRule && <p className="hint" data-testid="ai-rule-note">规则生成（非 AI）：对白按引号识别，说话人按名字匹配，镜头按固定节奏。可手改，也可配置 AI 后重新生成。</p>}
      {r.conflicts.length > 0 && <ul className="bad" data-testid="ai-conflicts">{r.conflicts.map((c, i) => <li key={i}>{c.label}</li>)}</ul>}
      {r.report.protectedKept.length > 0 && (
        <details>
          <summary className="hint" data-testid="ai-kept">保留了 {r.report.protectedKept.length} 项锁定 / 人工内容（跳过，不会被改）</summary>
          <ul className="ai-warn">{r.report.protectedKept.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </details>
      )}
      {r.applied && (
        <div className="ai-diff" data-testid="ai-diff">
          {scopes.length === 0 ? <p className="hint">与当前内容没有差别。</p> : (
            <>
              <p className="hint">
                将被改 {diff.items.length} 项{diff.structural ? '（含台词结构变化：台词结构只能整体接受；其余范围可单独选择，只作用于台词没变的句子）' : '（可按范围选择）'}
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
          {card.state === 'pending' && (
            <div className="ai-buttons">
              <button className="btn primary" onClick={() => onAccept(true)} data-testid="ai-accept-all">全部接受</button>
              {selectable.length > 0 && (diff.structural || selectable.length > 1) && <button className="btn" disabled={nSel === 0 || (!diff.structural && allChecked)} onClick={() => onAccept(false)} data-testid="ai-accept-sel">接受选中的范围</button>}
              <button className="btn" onClick={onReject} data-testid="ai-reject">拒绝</button>
            </div>
          )}
        </div>
      )}
      {r.warnings.length > 0 && (
        <details>
          <summary data-testid="ai-warnings">{r.warnings.length} 条修复 / 警告</summary>
          <ul className="ai-warn">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      <details>
        <summary>{isRule ? '规则给出的演出意图' : '模型给出的演出意图'}（{r.direction.beats.length} 个节拍）</summary>
        <p className="hint">{r.direction.reason}</p>
        <pre className="ai-json" data-testid="ai-intent">{JSON.stringify(r.direction, null, 1)}</pre>
      </details>
    </li>
  );
}
