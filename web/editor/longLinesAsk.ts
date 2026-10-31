/** The explicit request the 「拆开」 button of an assistant card sends: it must carry words the server reads as a split request (`asksForLineSplit`). */
import type { LongLine } from '@shared/agent/verify';
import type { Project } from '@shared/schema/project';

export function splitRequestText(project: Project, lines: Pick<LongLine, 'sceneId' | 'beatNo'>[]): string {
  const byScene = new Map<number, number[]>();
  for (const l of lines) {
    const no = project.scenes.findIndex((s) => s.id === l.sceneId) + 1;
    if (no > 0) byScene.set(no, [...(byScene.get(no) ?? []), l.beatNo]);
  }
  const parts = [...byScene].sort((a, b) => a[0] - b[0]).map(([no, beats]) => `第${no}场第${beats.sort((a, b) => a - b).join('、')}句`);
  return `把${parts.join('、')}放不下对话框的台词拆开，按语义拆成连续的几句`;
}
