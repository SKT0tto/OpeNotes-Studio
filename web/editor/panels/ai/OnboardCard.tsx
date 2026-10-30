/**
 * The first-run dialog's cards as the editor's stream shows them: the breakdown and the generation progress (a one-line summary, unfold for the
 * scene list / what failed / continuity notes), and, after the review path, 「已建 N 场骨架，还没生成演出」 with the 「生成全部场景」 button.
 * Same `AiCard` shell as every other card; they are the first entries of the conversation that continues in the editor.
 */
import { useAiFlow, type OnboardEntry } from '../../../store/aiFlow';
import { useProject } from '../../../store/projectStore';
import { useDirectorRun, type DirectorEnv } from '../directorRun';
import { missingScenes } from './generateActions';
import { AiCard, type CardTone } from './AiCard';
import { UserBubble } from './GenerateCard';

const STATE_TEXT: Record<OnboardEntry['state'], string> = { done: '完成', partial: '部分完成', failed: '失败', cancelled: '已取消', pending: '还没生成' };
const TONE: Record<OnboardEntry['state'], CardTone> = { done: 'ok', partial: 'warn', failed: 'bad', cancelled: 'hint', pending: 'warn' };

export function OnboardTurn({ entry, env }: { entry: OnboardEntry; env: DirectorEnv }) {
  const busy = useDirectorRun((s) => s.busy);
  const project = useProject((s) => s.project);
  const missing = project ? missingScenes(project) : [];
  // the card keeps its button only while there is something left to generate
  const pendingWork = (entry.canGenerateAll || entry.canResume) && missing.length > 0;
  const resume = () => void useDirectorRun.getState().run(false, { batchIds: missing }, env);
  const generate = () => {
    useAiFlow.getState().dismiss(entry.id);
    void useDirectorRun.getState().run(true, {}, env);
  };
  return (
    <div className="ai-turn" data-testid="ai-turn" data-kind="onboard">
      {entry.userText && <UserBubble text={entry.userText} />}
      <AiCard
        state={entry.state} title={entry.title} who={entry.who} stateLabel={STATE_TEXT[entry.state]} tone={TONE[entry.state]}
        bodyTestId="ai-onboard-card" bodyAttrs={{ 'data-kind': entry.kind }}
        collapsible={pendingWork ? undefined : { summary: entry.summary }}
        said={pendingWork ? entry.summary : undefined}
        actions={!pendingWork ? undefined : entry.canGenerateAll ? <button className="btn primary" disabled={busy} onClick={generate} data-testid="ai-onboard-generate-all">生成全部场景</button>
          : <button className="btn primary" disabled={busy} onClick={resume} data-testid="ai-onboard-resume">继续生成剩余 {missing.length} 场</button>}
        detail={entry.lines.length > 0 ? <ul className="ai-warn">{entry.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : undefined}
      />
    </div>
  );
}
