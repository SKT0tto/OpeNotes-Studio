/**
 * The assistant's eyes in the browser: `capture_frames` asks the server, the server asks this page (an SSE `capture` event), and the page
 * renders the requested moments of the assistant's sandbox project on the editor's stage and posts the pictures back. The stage owner
 * (usePlayerHost) registers the grabber; without one the assistant is told it cannot see the stage.
 */
import type { CaptureRequest, CapturedFrame } from '@shared/agent/frames';
import type { Project } from '@shared/schema/project';

export type FrameGrabber = (project: Project, req: CaptureRequest) => Promise<CapturedFrame[]>;
let grabber: FrameGrabber | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function registerFrameGrabber(g: FrameGrabber): () => void {
  grabber = g;
  return () => {
    if (grabber === g) grabber = null;
  };
}
export const hasFrameGrabber = (): boolean => grabber !== null;

/** One capture at a time (they share the stage). */
export function grabFrames(project: Project, req: CaptureRequest): Promise<CapturedFrame[]> {
  const g = grabber;
  if (!g) return Promise.reject(new Error('编辑器的舞台还没有准备好'));
  const run = queue.then(() => g(project, req));
  queue = run.catch(() => {});
  return run;
}

/** Answer a `capture` event of an agent turn. */
export async function answerCapture(e: { reqId: string; project: Project; req: CaptureRequest }): Promise<void> {
  let body: unknown;
  try {
    body = { frames: await grabFrames(e.project, e.req) };
  } catch (err) {
    body = { error: (err as Error).message };
  }
  await fetch(`/api/agent/frames/${encodeURIComponent(e.reqId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
}

if (import.meta.env.DEV) (window as unknown as { __studioAgentGrab?: typeof grabFrames }).__studioAgentGrab = grabFrames;
