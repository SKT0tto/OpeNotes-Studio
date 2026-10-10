/** Editor view state that is not part of the project: panels, tools, overlays, key selection, mute / solo, clipboard. */
import { create } from 'zustand';
import type { AnyKey, Channel, TrackTarget } from '@shared/project/mutate';

export type InspectorTab = 'project' | 'scene' | 'beat' | 'actor' | 'shot' | 'key' | 'style';
export interface ClipKey {
  target: TrackTarget;
  channel: Channel;
  /** Seconds after the first copied key. */
  dt: number;
  key: Pick<AnyKey, 'value' | 'duration' | 'ease'>;
}
export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'warn';
  /** Optional button (e.g. 解锁 on a refused edit). */
  action?: { label: string; run: () => void };
}

interface UiState {
  centerView: 'preview' | 'storyboard';
  tool: 'select' | 'camera';
  overlays: { safe: boolean; thirds: boolean; eyeLine: boolean; ref: boolean };
  ref: { url: string; opacity: number; diff: boolean } | null;
  inspectorTab: InspectorTab;
  /** Selected key ids of the scene on the timeline. */
  keySel: string[];
  /** Muted / soloed track ids (preview only; the project is untouched). */
  muted: string[];
  solo: string[];
  /** Timeline groups opened / closed by hand or by selecting a person (group id -> open). */
  openGroups: Record<string, boolean>;
  /** Timeline zoom in pixels per second. */
  pps: number;
  clip: ClipKey[];
  toast: Toast | null;
  styleUnit: 'H' | 'px';
  helpOpen: boolean;
  /** Playback speed of the preview (also set by L). */
  rate: number;
  /** Storyboard card multi-selection (beat ids). */
  cards: string[];
  set(p: Partial<Omit<UiState, 'set'>>): void;
}

export const useUi = create<UiState>((set) => ({
  centerView: 'preview',
  tool: 'select',
  overlays: { safe: false, thirds: false, eyeLine: false, ref: true },
  ref: null,
  inspectorTab: 'beat',
  keySel: [],
  muted: [],
  solo: [],
  openGroups: {},
  pps: 60,
  clip: [],
  toast: null,
  styleUnit: 'H',
  helpOpen: false,
  rate: 1,
  cards: [],
  set: (p) => set(p),
}));

let toastId = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Short message in the status bar / toast area (locked units, refused edits). */
export function notify(text: string, tone: Toast['tone'] = 'warn', action?: Toast['action']): void {
  const id = ++toastId;
  useUi.getState().set({ toast: { id, text, tone, ...(action ? { action } : {}) } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (useUi.getState().toast?.id === id) useUi.getState().set({ toast: null });
  }, action ? 6000 : 2800);
}
