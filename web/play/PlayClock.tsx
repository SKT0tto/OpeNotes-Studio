/**
 * Playhead readouts that follow the player straight from its render events and write the DOM themselves: during playback they cost no
 * React commit at all (the host state in `usePlayerHost` only changes a couple of times a second).
 */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Player } from '../engine/Player';

export const fmtClock = (s: number, decimals = 1) => `${Math.floor(s / 60)}:${(s % 60).toFixed(decimals).padStart(decimals + 3, '0')}`;

/** Calls `write(t)` after every render of the component and on every frame the player draws. */
function useFollowPlayer(playerRef: RefObject<Player | null>, ready: boolean, write: (t: number) => void): void {
  useLayoutEffect(() => write(playerRef.current?.t ?? 0));
  useLayoutEffect(() => {
    const p = playerRef.current;
    if (!ready || !p) return;
    return p.subscribe((s) => write(s.t));
  }, [playerRef, ready, write]);
}

export function PlayTime({ playerRef, ready, duration, decimals = 1, withDuration = false, className, testId }: { playerRef: RefObject<Player | null>; ready: boolean; duration: number; decimals?: number; withDuration?: boolean; className?: string; testId?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const last = useRef('');
  const write = useCallback(
    (t: number) => {
      const text = withDuration ? `${fmtClock(t, decimals)} / ${fmtClock(duration, decimals)}` : fmtClock(t, decimals);
      if (el.current && text !== last.current) el.current.textContent = last.current = text;
    },
    [decimals, duration, withDuration],
  );
  useFollowPlayer(playerRef, ready, write);
  return <span ref={el} className={className} data-testid={testId} />;
}

export function PlaySeek({ playerRef, ready, duration, onSeek, className = 'seek', testId }: { playerRef: RefObject<Player | null>; ready: boolean; duration: number; onSeek: (t: number) => void; className?: string; testId?: string }) {
  const el = useRef<HTMLInputElement>(null);
  const write = useCallback((t: number) => {
    const input = el.current;
    const v = String(Math.round(t * 100));
    if (input && input.value !== v && document.activeElement !== input) input.value = v;
  }, []);
  useFollowPlayer(playerRef, ready, write);
  return <input ref={el} type="range" aria-label="播放进度" className={className} min={0} max={Math.max(1, Math.round(duration * 100))} defaultValue={0} disabled={!ready} onChange={(e) => onSeek(Number(e.target.value) / 100)} data-testid={testId} />;
}
