/**
 * Pictures for the assistant: an image is downscaled to a JPEG data URL; a short video is sampled into a few frames (the models take
 * pictures, not video), each labelled with its time. Everything stays in the browser until the instruction is sent.
 */
import { MAX_FRAMES, videoSampleTimes } from '@shared/agent/frames';
import type { AgentAttachment } from './store/agentStore';

/** Longest side of a picture sent to the model. */
export const ATTACH_MAX_SIDE = 1280;
/** Frames taken from one video. */
export const VIDEO_FRAMES = 4;
/** Videos longer than this are refused (sample a short clip instead). */
export const VIDEO_MAX_SECONDS = 120;

function draw(src: CanvasImageSource, w: number, h: number): string {
  const k = Math.min(1, ATTACH_MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

async function imageFile(file: File, label: string): Promise<AgentAttachment> {
  const bmp = await createImageBitmap(file);
  try {
    return { dataUrl: draw(bmp, bmp.width, bmp.height), label };
  } finally {
    bmp.close();
  }
}

async function videoFile(file: File, name: string): Promise<AgentAttachment[]> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise<void>((ok, bad) => { v.onloadedmetadata = () => ok(); v.onerror = () => bad(new Error('这个视频无法读取（格式不受浏览器支持）')); });
    if (!(v.duration <= VIDEO_MAX_SECONDS)) throw new Error(`视频太长（${Math.round(v.duration)} 秒），请截一段 ${VIDEO_MAX_SECONDS} 秒以内的`);
    const out: AgentAttachment[] = [];
    for (const t of videoSampleTimes(v.duration, VIDEO_FRAMES)) {
      await new Promise<void>((ok) => { v.onseeked = () => ok(); v.currentTime = t; });
      out.push({ dataUrl: draw(v, v.videoWidth, v.videoHeight), label: `${name} ${t.toFixed(1)}s` });
    }
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Files (picked, dropped or pasted) -> attachments, at most `room` of them. Unsupported files are skipped with a reason. */
export async function filesToAttachments(files: File[], room = MAX_FRAMES): Promise<{ items: AgentAttachment[]; problems: string[] }> {
  const items: AgentAttachment[] = [];
  const problems: string[] = [];
  let n = 0;
  for (const f of files) {
    if (items.length >= room) { problems.push(`最多 ${MAX_FRAMES} 张图（视频按 ${VIDEO_FRAMES} 帧算）`); break; }
    try {
      if (f.type.startsWith('image/')) items.push(await imageFile(f, `附图${++n}`));
      else if (f.type.startsWith('video/')) items.push(...(await videoFile(f, `视频${++n}`)).slice(0, room - items.length));
      else problems.push(`${f.name} 不是图片或视频`);
    } catch (e) {
      problems.push(`${f.name}：${(e as Error).message}`);
    }
  }
  return { items, problems };
}
