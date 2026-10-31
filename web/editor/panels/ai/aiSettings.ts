/**
 * The AI settings as the AI panel needs them: loaded once and shared (the panel, the 「生成」 popover, the composer and the settings dialog
 * all read this one copy instead of each fetching its own). `configured` is only false once the settings really said so.
 */
import { create } from 'zustand';
import type { PublicLlmSettings } from '@shared/schema/settings';
import { fetchLlmSettings } from '../../../llmApi';

interface AiSettingsState {
  settings: PublicLlmSettings | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  set(settings: PublicLlmSettings): void;
}

let inflight: Promise<void> | null = null;

export const useAiSettings = create<AiSettingsState>((set, get) => ({
  settings: null,
  loading: true,
  error: null,
  load() {
    if (inflight) return inflight;
    if (get().settings === null) set({ loading: true });
    inflight = fetchLlmSettings()
      .then((settings) => set({ settings, error: null }), (e: Error) => set({ settings: null, error: e.message }))
      .finally(() => {
        set({ loading: false });
        inflight = null;
      });
    return inflight;
  },
  set(settings) {
    set({ settings, error: null, loading: false });
  },
}));

/** Shown (tooltip and notice) when pictures would be dropped. */
export const BLIND_NOTICE = '当前 AI 看不到图片：请在 AI 设置里配置能看图的模型或视觉模型';

/**
 * True only when the server knows attached pictures would be dropped (vision off, no separate vision model configured, or a main model
 * whose endpoint says it takes no pictures). Unknown capability (`canSee` null) is not blind: the picture is accepted.
 */
export const cannotSeeImages = (s: Pick<AiSettingsState, 'settings' | 'loading' | 'error'>): boolean => !s.loading && !s.error && s.settings !== null && s.settings.status.configured && s.settings.vision.canSee === false;

/** True only when the settings are known and no AI is configured: the free-text box is then disabled and generation defaults to the rule generator. */
export const noAi = (s: Pick<AiSettingsState, 'settings' | 'loading' | 'error'>): boolean => !s.loading && !s.error && s.settings !== null && !s.settings.status.configured;
