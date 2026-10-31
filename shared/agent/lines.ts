/**
 * How a line sits in the dialogue area, for the assistant: the one measurement (`fitsDialog`, the same the DialogBox and the director use),
 * resolved with the layers a beat really has (project -> scene -> beat style).
 */
import type { Beat, Project, Scene } from '../schema/project';
import { fitsDialog, type DialogMetrics } from '../style/dialogLayout';
import { resolveStyle } from '../style/ournotes';
import { TEXT_KINDS } from '../timeline/time';

export interface BeatLineInfo {
  /** Lines the text takes. */
  lines: number;
  /** The dialogue area's `maxLines`. */
  max: number;
  /** More lines than the area has AND not expanded: the viewer loses text. */
  over: boolean;
  /** The beat is expanded (`overflow: 'expand'`). */
  expanded: boolean;
}

export const dialogMetricsOf = (project: Project, scene: Scene, beat: Beat): DialogMetrics => resolveStyle(project.style, scene.style, beat.style).values.dialog;

/** Null for a beat that shows no text in the dialogue area (pause, silent, establishing ...) or has none. */
export function beatLineInfo(project: Project, scene: Scene, beat: Beat): BeatLineInfo | null {
  if (!TEXT_KINDS.includes(beat.kind) || beat.text.trim() === '') return null;
  const style = dialogMetricsOf(project, scene, beat);
  const f = fitsDialog(beat.text, style, beat.variant);
  const expanded = beat.overflow === 'expand';
  return { lines: f.lines, max: f.max, over: f.over && !expanded, expanded };
}

/** 「超长：3/2 行」 / 「展开 3 行」 for the scene table, or '' when the line is fine. */
export function lineFlag(info: BeatLineInfo | null): string {
  if (!info) return '';
  if (info.expanded) return `展开:${info.lines}行`;
  return info.over ? `超长:${info.lines}/${info.max}行` : '';
}
