/** Playback volume of recorded voice lines (0..1, default 1), remembered by this browser. */
import { create } from 'zustand';

const KEY = 'studio.voice.volume';
const read = (): number => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return localStorage.getItem(KEY) !== null && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
};

export const useVoicePrefs = create<{ volume: number; setVolume(v: number): void }>((set) => ({
  volume: read(),
  setVolume(v) {
    const volume = Math.min(1, Math.max(0, v));
    try {
      localStorage.setItem(KEY, String(volume));
    } catch { /* not remembered */ }
    set({ volume });
  },
}));
