/**
 * Frames for the assistant's eyes: what `capture_frames` asks the renderer for, and where in the timeline each picture is taken.
 * Pure: the browser (or a headless page) maps the requests onto its compiled project with `frameTimes` and grabs the stage there.
 */
import type { CompiledProject } from '../timeline/types';

/** One picture: at a beat (`at` = where inside it: start / mid / end, or seconds after its start) or at an absolute time. */
export type FrameRequest = { beatId: string; at?: 'start' | 'mid' | 'end' | number | undefined; label: string } | { time: number; label: string };
export interface CaptureRequest {
  frames: FrameRequest[];
  /** Width of each picture in pixels (16:9); the renderer downscales the stage to it. */
  width: number;
}
export interface CapturedFrame {
  label: string;
  /** `data:image/jpeg;base64,...` */
  dataUrl: string;
}
/** At most this many pictures per call (and per user message): pictures are the most expensive input there is. */
export const MAX_FRAMES = 8;
export const FRAME_WIDTHS = [320, 480, 640, 960] as const;
export const DEFAULT_FRAME_WIDTH = 480;

export interface FramePlan {
  /** 1-based scene / beat numbers for the label. */
  requests: FrameRequest[];
  problems: string[];
}

/**
 * Turn the tool's arguments into frame requests: each beat once at its middle, or `samples` pictures spread over the beat (a camera move,
 * an entrance: first, middle, last ...), plus absolute times. `beatNo` names a beat for the label.
 */
export function planFrames(a: { beatIds?: string[] | undefined; times?: number[] | undefined; samples?: number | undefined }, beatNo: (id: string) => string | null): FramePlan {
  const requests: FrameRequest[] = [];
  const problems: string[] = [];
  const n = Math.max(1, Math.min(4, Math.round(a.samples ?? 1)));
  for (const id of a.beatIds ?? []) {
    const name = beatNo(id);
    if (!name) { problems.push(`台词 ${id} 不存在`); continue; }
    if (n === 1) requests.push({ beatId: id, at: 'mid', label: `${name}（中间）` });
    else for (let i = 0; i < n; i++) { const f = Math.round((0.08 + (0.84 * i) / (n - 1)) * 100) / 100; requests.push({ beatId: id, at: f, label: `${name}（${Math.round(f * 100)}%）` }); }
  }
  for (const t of a.times ?? []) requests.push({ time: Math.max(0, t), label: `${t.toFixed(1)} 秒` });
  if (requests.length > MAX_FRAMES) problems.push(`一次最多 ${MAX_FRAMES} 张，只取了前 ${MAX_FRAMES} 张`);
  return { requests: requests.slice(0, MAX_FRAMES), problems };
}

/**
 * Seconds of each request on a compiled project. A numeric `at` below 1 is a fraction of the beat (as `planFrames` writes it);
 * 1 or more is seconds after the beat starts. A beat that does not exist gives null.
 */
export function frameTimes(compiled: Pick<CompiledProject, 'scenes' | 'duration'>, requests: FrameRequest[]): Array<number | null> {
  const beats = new Map(compiled.scenes.flatMap((s) => s.beats.map((b) => [b.id, b] as const)));
  const eps = 0.04;
  return requests.map((r) => {
    if ('time' in r) return Math.min(Math.max(0, r.time), Math.max(0, compiled.duration - eps));
    const b = beats.get(r.beatId);
    if (!b) return null;
    const len = Math.max(0, b.end - b.start);
    const at = r.at ?? 'mid';
    const t = at === 'start' ? b.start + Math.min(0.15, len / 4) : at === 'end' ? b.end - Math.min(0.15, len / 4) : at === 'mid' ? b.start + len / 2 : at < 1 ? b.start + len * at : b.start + at;
    return Math.min(Math.max(b.start, t), Math.max(b.start, b.end - eps));
  });
}

/** Times to sample a user's video at: `n` frames spread over it, avoiding the very first and last frame. */
export function videoSampleTimes(duration: number, n: number): number[] {
  const k = Math.max(1, Math.min(MAX_FRAMES, n));
  if (!(duration > 0)) return [0];
  if (k === 1) return [duration / 2];
  return Array.from({ length: k }, (_, i) => Math.round((duration * (0.05 + (0.9 * i) / (k - 1))) * 100) / 100);
}
