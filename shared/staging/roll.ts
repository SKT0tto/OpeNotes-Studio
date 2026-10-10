/** Dutch angle: the picture is rotated about its centre; scaling by this factor keeps the frame corners covered. */
export function rollCoverScale(rollDeg: number, aspect: number): number {
  const a = (Math.abs(rollDeg) * Math.PI) / 180;
  if (a < 1e-9) return 1;
  // A w x h rectangle rotated by a covers the w x h frame when scaled by cos(a) + sin(a) * max(w/h, h/w).
  return Math.cos(a) + Math.sin(a) * Math.max(aspect, 1 / aspect);
}
