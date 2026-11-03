/** A tiny stand-in for GPT-SoVITS `api_v2.py`: /set_*_weights and /tts (a sine wave about 0.12 s per character). */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { makeWav } from '../../../../shared/voice/wav';

export interface FakeSovits {
  url: string;
  /** Every call, in order. */
  calls: Array<{ path: string; query?: Record<string, string>; body?: Record<string, unknown> }>;
  /** Make the next /tts calls fail with this 400 message (once per entry). */
  failNext(message: string): void;
  /** Texts for which /tts answers 400. */
  failText: Set<string>;
  /** Use a streaming-style header (bogus data size). */
  bogusHeader: boolean;
  /** Milliseconds each /tts call takes. */
  delayMs: number;
  close(): Promise<void>;
}

export async function startFakeSovits(): Promise<FakeSovits> {
  const calls: FakeSovits['calls'] = [];
  const failures: string[] = [];
  const state = { failText: new Set<string>(), bogusHeader: false, delayMs: 0 };
  const app = express();
  app.use(express.json());
  for (const kind of ['gpt', 'sovits']) {
    app.get(`/set_${kind}_weights`, (req, res) => {
      calls.push({ path: `/set_${kind}_weights`, query: req.query as Record<string, string> });
      if (typeof req.query.weights_path !== 'string' || req.query.weights_path.includes('missing')) return void res.status(400).json({ message: 'weights not found' });
      res.json({ message: 'success' });
    });
  }
  app.post('/tts', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    calls.push({ path: '/tts', body });
    if (state.delayMs > 0) await new Promise((r) => setTimeout(r, state.delayMs));
    const text = String(body.text ?? '');
    const forced = failures.shift();
    if (forced || state.failText.has(text)) return void res.status(400).json({ message: 'tts failed', Exception: forced ?? 'forced' });
    for (const k of ['text', 'text_lang', 'ref_audio_path', 'prompt_lang']) if (typeof body[k] !== 'string' || body[k] === '') return void res.status(400).json({ message: `${k} is required` });
    const rate = 16000;
    const n = Math.max(1, Math.round(0.12 * [...text].length * rate));
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000);
    res.type('audio/wav').send(Buffer.from(makeWav(samples, rate, { bogusSize: state.bogusHeader })));
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    failNext: (m) => void failures.push(m),
    failText: state.failText,
    get bogusHeader() { return state.bogusHeader; },
    set bogusHeader(v: boolean) { state.bogusHeader = v; },
    get delayMs() { return state.delayMs; },
    set delayMs(v: number) { state.delayMs = v; },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
