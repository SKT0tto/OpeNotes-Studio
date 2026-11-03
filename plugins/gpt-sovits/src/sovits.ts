/** Client of GPT-SoVITS `api_v2.py`. Every failure becomes a `SovitsError` with a Chinese message that is safe to show. */
import type { VoiceProfile } from './schema';

export class SovitsError extends Error {
  constructor(message: string, readonly kind: 'unreachable' | 'rejected' | 'aborted' | 'timeout') {
    super(message);
    this.name = 'SovitsError';
  }
}

export interface TtsRequest {
  text: string;
  textLang: string;
  profile: Pick<VoiceProfile, 'promptText' | 'promptLang' | 'speed'> & { refAudioPath: string };
}

const base = (endpoint: string) => endpoint.trim().replace(/\/+$/, '');

async function call(endpoint: string, pathAndQuery: string, init: RequestInit & { timeoutMs?: number }, signal?: AbortSignal): Promise<Response> {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), init.timeoutMs ?? 300_000);
  try {
    return await fetch(`${base(endpoint)}${pathAndQuery}`, { ...init, signal: ctl.signal });
  } catch {
    if (signal?.aborted) throw new SovitsError('已取消', 'aborted');
    if (ctl.signal.aborted) throw new SovitsError('GPT-SoVITS 响应超时（合成太久没有返回）', 'timeout');
    throw new SovitsError(`连不上 GPT-SoVITS（${base(endpoint)}）：请确认已启动 api_v2.py，且地址、端口正确`, 'unreachable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The text of a failed response: its JSON `message` (+ `Exception`) when it has one. */
async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { message?: unknown; Exception?: unknown; detail?: unknown };
    const parts = [j.message, j.Exception, typeof j.detail === 'string' ? j.detail : undefined].filter((x): x is string => typeof x === 'string' && x !== '');
    if (parts.length > 0) return parts.join('：');
  } catch { /* not JSON */ }
  return text.trim().slice(0, 200) || `HTTP ${res.status}`;
}

/** Reachability: any HTTP answer from the address counts (api_v2 has no health route; `/` answers 404). */
export async function testConnection(endpoint: string, signal?: AbortSignal): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  try {
    const res = await call(endpoint, '/', { method: 'GET', timeoutMs: 8000 }, signal);
    await res.arrayBuffer().catch(() => undefined);
    return { ok: true, message: `已连接 GPT-SoVITS（${base(endpoint)}）` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function setWeights(endpoint: string, kind: 'gpt' | 'sovits', weightsPath: string, signal?: AbortSignal): Promise<void> {
  const res = await call(endpoint, `/set_${kind}_weights?weights_path=${encodeURIComponent(weightsPath)}`, { method: 'GET', timeoutMs: 120_000 }, signal);
  if (!res.ok) throw new SovitsError(`GPT-SoVITS 拒绝加载${kind === 'gpt' ? ' GPT ' : ' SoVITS '}权重（${weightsPath}）：${await reason(res)}`, 'rejected');
  await res.arrayBuffer().catch(() => undefined);
}

/** Synthesises one line; returns the WAV bytes. */
export async function tts(endpoint: string, req: TtsRequest, signal?: AbortSignal): Promise<Uint8Array> {
  const body = {
    text: req.text, text_lang: req.textLang,
    ref_audio_path: req.profile.refAudioPath, prompt_lang: req.profile.promptLang,
    ...(req.profile.promptText ? { prompt_text: req.profile.promptText } : {}),
    speed_factor: req.profile.speed, media_type: 'wav', streaming_mode: false, text_split_method: 'cut5', batch_size: 1,
  };
  const res = await call(endpoint, '/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 300_000 }, signal);
  if (!res.ok) throw new SovitsError(`GPT-SoVITS 合成失败：${await reason(res)}`, 'rejected');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 64) throw new SovitsError('GPT-SoVITS 返回了空的音频', 'rejected');
  return bytes;
}

