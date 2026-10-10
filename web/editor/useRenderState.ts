import { useEffect, useState } from 'react';
import type { RenderState } from '@shared/timeline/types';
import type { Player } from '../engine/Player';

export type Geo = ReturnType<Player['geometry']>;

/**
 * The latest render state and the on-screen boxes of the people. Updates once per animation frame at most and only
 * while the player is not playing (handles and field values are for editing a still frame).
 */
export function useRenderState(player: { current: Player | null }, ready: boolean): { state: RenderState | null; geo: Geo; stageBg: ReturnType<Player['stageBgGetter']> } {
  const [snap, setSnap] = useState<{ state: RenderState | null; geo: Geo; stageBg: ReturnType<Player['stageBgGetter']> }>({ state: null, geo: [], stageBg: null });
  useEffect(() => {
    const p = player.current;
    if (!ready || !p) return;
    let raf = 0;
    let last = 0;
    const update = () => {
      raf = 0;
      setSnap({ state: p.state, geo: p.isPlaying ? [] : p.geometry(), stageBg: p.stageBgGetter() });
    };
    const unsub = p.subscribe(() => {
      // while playing nothing here is editable: refresh a few times a second instead of every frame
      if (p.isPlaying) {
        const now = performance.now();
        if (now - last < 250) return;
        last = now;
      }
      if (!raf) raf = requestAnimationFrame(update);
    });
    update();
    return () => {
      unsub();
      cancelAnimationFrame(raf);
    };
  }, [player, ready]);
  return snap;
}
