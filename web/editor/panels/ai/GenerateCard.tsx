/**
 * A generation turn in the AI panel's stream: the 「你」 bubble (what was asked) and one card, which is first a progress bar with one line per
 * scene and then the result (one section per scene, a diff you can tick, 应用全部 / 应用所选 / 拒绝), later 已应用 / 已撤销. The same `AiCard`
 * shell as the assistant's change cards.
 */
import { SCOPE_LABEL } from '@shared/director/scope';
import { useProject, stepIsLive } from '../../../store/projectStore';
import { SceneResult } from '../AiResultCard';
import { useDirectorRun, type DirectorEnv } from '../directorRun';
import { AiCard, type CardTone } from './AiCard';
import { TURN_STATE_LABEL, isUnchanged, turnState, undoableStep, type GenTurn, type TurnState } from './genTurn';

const TONE: Record<TurnState, CardTone> = { running: 'hint', failed: 'bad', cancelled: 'hint', empty: 'hint', unchanged: 'hint', pending: 'warn', applied: 'ok', partial: 'warn', undone: 'hint', rejected: 'hint', conflict: 'bad' };

export function UserBubble({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="ai-user-wrap">
      <div className="agent-user ai-user-bubble" data-testid="ai-user-bubble">{text}</div>
      {children}
    </div>
  );
}

export function GenerateTurn({ turn, env, onRefine, onRouteUndo, onOpenSettings }: {
  turn: GenTurn;
  env: DirectorEnv;
  /** Opens the AI settings (the rule card offers it when no AI model is set up). */
  onOpenSettings?: () => void;
  onRefine: (sceneId: string) => void;
  /** The typed command was routed here by mistake: drop the turn and send the words to the assistant. */
  onRouteUndo: (turn: GenTurn) => void;
}) {
  const d = useDirectorRun.getState();
  const project = useProject((s) => s.project)!;
  const topId = useProject((s) => s.undoId);
  useProject((s) => s.histRev); // re-render when the undo stack changes: 已应用 becomes 已撤销 after Ctrl+Z
  const live = stepIsLive;
  const state = turnState(turn, live);
  const cards = Object.values(turn.cards);
  const pending = cards.filter((c) => c.state === 'pending' && c.result.applied && !isUnchanged(c));
  const finished = Object.values(turn.progress).filter((p) => p.state !== 'start').length;
  const no = (id: string) => project.scenes.findIndex((s) => s.id === id) + 1;
  const first = turn.sceneIds[0];
  const firstScene = project.scenes.find((s) => s.id === first);
  const scopeText = turn.scopes.map((s) => SCOPE_LABEL[s]).join(' / ');
  const title = turn.all ? `全部场景 · ${turn.sceneIds.length} 场` : turn.sceneIds.length > 1 ? turn.label : `第${no(first ?? '') || '?'}场「${firstScene?.title ?? ''}」· ${scopeText}${turn.beatIds ? `（选中的 ${turn.beatIds.length} 句）` : ''}`;
  const undoStep = undoableStep(turn, topId);
  const hasSteps = turn.steps.length > 0;
  const aiTurn = turn.who !== '规则';
  const stateLabel = TURN_STATE_LABEL[state];
  const nUndone = cards.filter((c) => c.state === 'accepted' && c.stepId !== undefined && !live(c.stepId)).length;
  const routable = !!turn.routed && !hasSteps;
  const busy = useDirectorRun((s) => s.busy);
  // 「AI 说」: the model's own reason for one scene. A rule result is not the AI speaking: it gets a plain, honest note instead (the rule
  // engine's reason text is for the run record only)
  const isRule = turn.who === '规则';
  const reason = !isRule && cards.length === 1 ? cards[0]!.result.direction.reason : '';
  const said = isRule
    ? <>{env.configured ? '这次用的是规则生成（非 AI）' : '还没有设置 AI 模型，这次用规则生成（非 AI）排好了'}：对白按引号识别，说话人按名字匹配，镜头按固定节奏。可以手改。{!env.configured && onOpenSettings && <>{' '}<button className="btn-link" onClick={onOpenSettings} data-testid="ai-rule-setup">设置 AI</button>{' '}后可重新生成。</>}</>
    : reason || (cards.length > 1 ? `生成好了 ${cards.length} 个场景，先看差异，再决定应用哪些。` : '生成好了，先看差异，再决定应用哪些。');

  const topActions = pending.length > 1 ? (
    <span data-testid="ai-batchbar" className="ai-batchbar">
      <button className="btn primary" onClick={() => d.acceptAll(turn.id)} data-testid="ai-accept-batch">应用全部 {pending.length} 场</button>
      <button className="btn" onClick={() => d.rejectAll(turn.id)} data-testid="ai-reject-batch">全部拒绝</button>
    </span>
  ) : undefined;
  const actions = (
    <>
      {hasSteps && <button className="btn" disabled={undoStep === null} onClick={() => d.undo(turn.id)} data-testid="ai-card-undo" title={undoStep === null ? (nUndone === cards.length ? '这次的改动已经撤销' : '只能撤销最近一步；先撤销它后面的修改') : '撤销这次应用的改动（等于 Ctrl+Z）'}>撤销这次</button>}
      {aiTurn && turn.status === 'done' && cards.length > 0 && (
        <button className="btn" disabled={busy} onClick={() => void d.run(turn.all, { ...turn.request, refresh: true }, env)} data-testid="ai-fresh" title="忽略缓存，向模型重新要一个结果（会再调用一次模型）">换一版</button>
      )}
    </>
  );
  const hasActions = hasSteps || (aiTurn && turn.status === 'done' && cards.length > 0);
  const failedScenes = Object.values(turn.progress).some((p) => p.state === 'error');
  const showProgress = Object.keys(turn.progress).length > 1 && (turn.status === 'running' || failedScenes) || (turn.status === 'running' && Object.keys(turn.progress).length > 0);

  return (
    <div className="ai-turn" data-testid="ai-turn" data-kind="generate">
      <UserBubble text={turn.userText}>
        {routable && (
          <div className="hint ai-route" data-testid="ai-route-note">
            按生成处理 · {env.configured
              ? <button className="btn-link" data-testid="ai-route-undo" onClick={() => onRouteUndo(turn)}>改成发给 AI</button>
              : <span data-testid="ai-route-noai" title="发给 AI 需要 AI 模型：先到「AI 设置」配置">发给 AI 需要先设置 AI 模型</span>}
          </div>
        )}
      </UserBubble>
      <AiCard
        state={state} title={title} who={turn.who} stateLabel={stateLabel} tone={TONE[state]}
        bodyTestId="ai-panel" bodyAttrs={{ 'data-turn': String(turn.id) }}
        saidLabel={isRule ? null : undefined} saidTestId={isRule ? 'ai-rule-note' : undefined}
        said={state === 'applied' || state === 'pending' || state === 'unchanged' || state === 'partial' || state === 'undone' ? said : undefined}
        topActions={topActions} actions={hasActions ? actions : undefined}
        detail={turn.log.length > 0 ? (
          <ul className="ai-log" data-testid="ai-log">
            {turn.log.map((l, i) => <li key={i} className={l.kind === 'error' ? 'bad' : ''}>{new Date(l.at).toLocaleTimeString()} {l.text}</li>)}
          </ul>
        ) : undefined}
        detailLabel={`运行记录（${turn.log.length}）`}
      >
        {turn.status === 'running' && turn.total > 0 && (
          <div data-testid="ai-meter">
            <div className="ai-meter"><i style={{ width: `${Math.round((finished / turn.total) * 100)}%` }} /></div>
            <span className="hint">{finished} / {turn.total} 个场景</span>
          </div>
        )}
        {turn.status === 'running' && Object.keys(turn.progress).length === 0 && <p className="hint">请求中…（每个场景一次模型调用；有放不下的长台词时再调用一次来拆分）</p>}
        {Object.keys(turn.progress).length > 1 || (turn.status === 'running' && Object.keys(turn.progress).length > 0) ? (
          <details open={showProgress} className="ai-progress-fold">
            <summary className="hint">逐场状态 · {finished} / {turn.total}</summary>
            <ul className="ai-progress" data-testid="ai-progress">
              {Object.values(turn.progress).map((p) => (
                <li key={p.sceneId} className={p.state === 'error' ? 'bad' : p.state === 'done' ? 'ok' : ''} data-state={p.state}>
                  {p.state === 'start' ? (p.phase === 'split' ? `拆分长句（${p.count ?? 0} 句）…` : '生成中…') : p.state === 'done' ? `完成${p.cached ? '（缓存）' : ''}` : `失败：${p.message}`} · {p.title}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {turn.error && <pre className="bad ai-error" data-testid="ai-error">{turn.error}</pre>}
        {cards.length > 0 && (
          <div className="ai-results" data-testid="ai-results">
            {cards.map((c) => (
              <SceneResult
                key={c.sceneId} card={c} live={live} open={cards.length <= 3} single={cards.length === 1}
                onToggle={(s) => d.toggleScope(turn.id, c.sceneId, s)} onAccept={(all) => d.accept(turn.id, c.sceneId, all)} onReject={() => d.reject(turn.id, c.sceneId)}
                onRefine={() => onRefine(c.sceneId)}
              />
            ))}
          </div>
        )}
      </AiCard>
    </div>
  );
}
