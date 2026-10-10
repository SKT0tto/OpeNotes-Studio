import fs from 'node:fs/promises';
import type { MotionStats, ParamStat } from '../../shared/schema/assets';

interface Curve {
  Id?: string;
  Segments?: number[];
}
interface Motion3 {
  Meta?: { Duration?: number; Fps?: number; Loop?: boolean };
  Curves?: Curve[];
}

/** Extract (time, value) end points from a motion3 segment array (types 0/1/2/3). */
export function curvePoints(segments: number[]): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  if (segments.length < 2) return pts;
  pts.push([segments[0]!, segments[1]!]);
  let i = 2;
  while (i < segments.length) {
    const type = segments[i]!;
    // linear / stepped / inverse-stepped carry one point, bezier carries three (last is the end point).
    const n = type === 1 ? 3 : 1;
    const end = i + 1 + (n - 1) * 2;
    if (end + 1 >= segments.length) break;
    pts.push([segments[end]!, segments[end + 1]!]);
    i += 1 + n * 2;
  }
  return pts;
}

export function paramStat(segments: number[] | undefined): ParamStat | null {
  if (!segments) return null;
  const pts = curvePoints(segments);
  if (pts.length === 0) return null;
  const first = pts[0]![1];
  const span = pts[pts.length - 1]![0] - pts[0]![0];
  if (pts.length < 2 || span <= 0) return { first, mean: first };
  let area = 0;
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1]!;
    const [t1, v1] = pts[i]!;
    area += ((v0 + v1) / 2) * (t1 - t0);
  }
  return { first, mean: area / span };
}

export function computeMotionStats(motion: Motion3): MotionStats {
  const byId = new Map<string, number[]>();
  for (const c of motion.Curves ?? []) if (c.Id && c.Segments) byId.set(c.Id, c.Segments);
  return {
    duration: motion.Meta?.Duration ?? 0,
    fps: motion.Meta?.Fps ?? 30,
    loop: motion.Meta?.Loop ?? false,
    angleX: paramStat(byId.get('ParamAngleX')),
    bodyAngleX: paramStat(byId.get('ParamBodyAngleX')),
    eyeBallX: paramStat(byId.get('ParamEyeBallX')),
  };
}

/** Read one motion3.json; null when missing or unparsable. */
export async function readMotionStats(file: string): Promise<MotionStats | null> {
  try {
    return computeMotionStats(JSON.parse(await fs.readFile(file, 'utf8')) as Motion3);
  } catch {
    return null;
  }
}
