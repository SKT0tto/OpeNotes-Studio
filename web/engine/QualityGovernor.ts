/**
 * Automatic quality fallback for slow machines (travel scenes only; a classic frame never changes).
 *
 * It looks at the *work* of a frame (CPU time from the first ticker listener to the end of the render call), never at the time between
 * two frames: a 30 fps cap (Edge's power saver) or a slow vsync stretches the interval without making the page any slower, and must not
 * look like an overloaded machine.
 *
 *  - engage: in ENGAGE_WINDOWS consecutive windows of WINDOW_MS, at least ENGAGE_SHARE of the frames took more than OVER_BUDGET_MS of work;
 *  - recover: in RECOVER_WINDOWS consecutive windows (the long wait doubles each time the fallback comes back soon after a recovery, up to
 *    BACKOFF_MAX times), at most RECOVER_SHARE of the frames took more than HEADROOM_MS - at the lowered quality there is room to spare.
 * A stall (tab switch, scene load) or a classic scene discards the window instead of counting for or against.
 */
export const GOVERNOR = {
  WINDOW_MS: 2000,
  OVER_BUDGET_MS: 16,
  ENGAGE_SHARE: 0.6,
  ENGAGE_WINDOWS: 2,
  HEADROOM_MS: 9,
  RECOVER_SHARE: 0.03,
  RECOVER_WINDOWS: 5,
  /** A frame this long (ms of wall time) is a stall, not a verdict. */
  STALL_MS: 200,
  /** Coming back within this long after a recovery counts as flapping and doubles the next wait. */
  FLAP_MS: 60_000,
  BACKOFF_MAX: 8,
} as const;

export class QualityGovernor {
  /** True while the lowered quality is in force. */
  low = false;
  private elapsed = 0;
  private frames = 0;
  private over = 0;
  private streak = 0;
  private clock = 0;
  private recoveredAt = -Infinity;
  private backoff = 1;

  /**
   * Feed one frame: `workMs` its CPU work, `dtMs` the wall time since the previous frame, `active` whether the scene is a travel scene.
   * Returns true when `low` changed.
   */
  sample(workMs: number, dtMs: number, active: boolean): boolean {
    this.clock += dtMs;
    if (!active || dtMs > GOVERNOR.STALL_MS) {
      this.clearStreak();
      return false;
    }
    this.elapsed += dtMs;
    this.frames++;
    if (workMs > (this.low ? GOVERNOR.HEADROOM_MS : GOVERNOR.OVER_BUDGET_MS)) this.over++;
    if (this.elapsed < GOVERNOR.WINDOW_MS) return false;
    const share = this.over / this.frames;
    this.reset();
    if (!this.low) {
      this.streak = share >= GOVERNOR.ENGAGE_SHARE ? this.streak + 1 : 0;
      if (this.streak < GOVERNOR.ENGAGE_WINDOWS) return false;
      this.low = true;
      this.streak = 0;
      if (this.clock - this.recoveredAt < GOVERNOR.FLAP_MS) this.backoff = Math.min(GOVERNOR.BACKOFF_MAX, this.backoff * 2);
      else this.backoff = 1;
      return true;
    }
    this.streak = share <= GOVERNOR.RECOVER_SHARE ? this.streak + 1 : 0;
    if (this.streak < GOVERNOR.RECOVER_WINDOWS * this.backoff) return false;
    this.low = false;
    this.streak = 0;
    this.recoveredAt = this.clock;
    return true;
  }

  private reset(): void {
    this.elapsed = 0;
    this.frames = 0;
    this.over = 0;
  }

  /** Forget the windows seen so far (a stall or a classic scene breaks "consecutive") without changing the state. */
  clearStreak(): void {
    this.reset();
    this.streak = 0;
  }
}
