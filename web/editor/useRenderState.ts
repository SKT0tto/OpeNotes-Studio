import { useEffect, useState } from 'react';
import type { RenderState } from '@shared/timeline/types';
import type { Player } from '../engine/Player';

export type Geo = ReturnType<Player['geometry']>;

/**
 * The latest render state and the on-screen boxes of the people. Updates once per animation frame at most while paused, and on the
 * player's slow clock (see Player.subscribeSlow) while playing (handles and field values are for editing a still frame).
 */
export function useRenderState(player: { current: Player | null }, ready: boolean): { state: RenderState | null; geo: Geo; stageBg: ReturnType<Player['stageBgGetter']> } {
  const [snap, setSnap] = useState<{ state: RenderState | null; geo: Geo; stageBg: ReturnType<Player['stageBgGetter']> }>({ state: null, geo: [], stageBg: null });
  useEffect(() => {
    const p = player.current;
    if (!ready || !p) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      setSnap({ state: p.state, geo: p.isPlaying ? [] : p.geometry(), stageBg: p.stageBgGetter() });
    };
    // while the clock runs nothing here is editable: the player's slow clock (a couple of times a second) refreshes it
    const unsub = p.subscribeSlow(() => {
      // playing: update inside the player's event, so this and the host's state change land in the same React commit
      if (p.isPlaying) {
        if (raf) cancelAnimationFrame(raf);
        update();
      } else if (!raf) raf = requestAnimationFrame(update);
    });
    update();
    return () => {
      unsub();
      cancelAnimationFrame(raf);
    };
  }, [player, ready]);
  return snap;
}
