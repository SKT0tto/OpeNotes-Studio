/** The largest box of the given aspect (width / height) that fits inside `availW` x `availH`; never stretched, never cropped. */
export function fitAspect(availW: number, availH: number, aspect: number): { width: number; height: number } {
  if (!(availW > 0) || !(availH > 0) || !(aspect > 0) || !Number.isFinite(availW + availH + aspect)) return { width: 0, height: 0 };
  let width = availW;
  let height = width / aspect;
  if (height > availH) {
    height = availH;
    width = height * aspect;
  }
  return { width, height };
}
