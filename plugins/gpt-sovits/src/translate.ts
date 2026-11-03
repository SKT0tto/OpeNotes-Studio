/**
 * Japanese spoken text for voiced lines, per scene, through the same provider and cache as the director.
 * Each call returns `{lines:[{id, ja}]}`; an id the model skipped, or an answer that is not Japanese-looking text, is asked for again once,
 * then reported as failed (the line stays unvoiced; nothing is invented).
 */
import type { z } from 'zod';
import type { PluginServerContext } from '../../../shared/plugins/api';
import { VOICE_JA_PROMPT_VERSION, VOICE_JA_SCHEMA_NAME, VOICE_JA_SYSTEM, VoiceTranslationSchema, type VoiceJaInput, type VoiceJaLine } from './prompt';

/** The studio's structured-JSON call (`ctx.llm.callJson`); tests pass a stub. */
export type CallJson = PluginServerContext['llm']['callJson'];

/** Lines per call. */
export const VOICE_LINES_PER_CALL = 25;
/** Thinking models spend part of `max_tokens` on reasoning. */
const THINKING_ALLOWANCE = 4096;

export interface TranslateArgs {
  callJson: CallJson;
  refresh?: boolean | undefined;
  signal?: AbortSignal | undefined;
  scene: { title: string; mood: string };
  /** The scene's lines in order, context lines included (`translate:false`). */
  lines: VoiceJaLine[];
}
export interface TranslateResult {
  ja: Map<string, string>;
  /** id -> why it has no translation. */
  failed: Map<string, string>;
}

/** Cleans a model answer down to the spoken words; null when it is not Japanese (no kana at all). */
export function cleanJa(raw: string): string | null {
  const t = raw.trim().replace(/^[「『（(［[【]+/, '').replace(/[」』）)］\]】]+$/, '').replace(/\s+/g, ' ').trim();
  return /[ぁ-んァ-ヶー]/.test(t) ? t : null;
}

export function voiceBudget(textLengths: readonly number[]): number {
  const need = textLengths.reduce((s, n) => s + 60 + 3 * n, 0);
  return THINKING_ALLOWANCE + Math.ceil(2 * need);
}

export async function translateLines(a: TranslateArgs): Promise<TranslateResult> {
  const ja = new Map<string, string>();
  const failed = new Map<string, string>();
  const todo = a.lines.filter((l) => l.translate);
  const characters = [...new Map(a.lines.map((l) => [l.speaker, { key: l.speaker, name: l.name }])).values()];

  const ask = async (ids: string[]): Promise<Map<string, string>> => {
    const idSet = new Set(ids);
    const first = a.lines.findIndex((l) => idSet.has(l.id));
    const last = a.lines.length - 1 - [...a.lines].reverse().findIndex((l) => idSet.has(l.id));
    const window = a.lines.slice(Math.max(0, first - 3), last + 3);
    const input: VoiceJaInput = { scene: a.scene, characters, lines: window.map((l) => ({ ...l, translate: idSet.has(l.id) })) };
    const r = await a.callJson<z.infer<typeof VoiceTranslationSchema>>({
      system: VOICE_JA_SYSTEM, user: input, schema: VoiceTranslationSchema, schemaName: VOICE_JA_SCHEMA_NAME, promptVersion: VOICE_JA_PROMPT_VERSION,
      maxTokens: voiceBudget(window.filter((l) => idSet.has(l.id)).map((l) => [...l.text].length)), signal: a.signal, refresh: a.refresh,
    });
    const out = new Map<string, string>();
    for (const l of r.data.lines) {
      if (!idSet.has(l.id) || out.has(l.id)) continue;
      const c = cleanJa(l.ja);
      if (c) out.set(l.id, c);
    }
    return out;
  };

  for (let i = 0; i < todo.length; i += VOICE_LINES_PER_CALL) {
    const ids = todo.slice(i, i + VOICE_LINES_PER_CALL).map((l) => l.id);
    const got = new Map<string, string>();
    let lastError = '';
    for (let attempt = 0; attempt < 2 && got.size < ids.length; attempt++) {
      const missing = ids.filter((id) => !got.has(id));
      try {
        for (const [k, v] of await ask(missing)) got.set(k, v);
      } catch (e) {
        if (a.signal?.aborted || ['aborted', 'auth', 'not_configured'].includes((e as { kind?: string }).kind ?? '')) throw e;
        lastError = (e as Error).message;
      }
    }
    for (const id of ids) {
      const v = got.get(id);
      if (v) ja.set(id, v);
      else failed.set(id, lastError ? `翻译失败：${lastError}` : '模型没有给出这一句的日语译文');
    }
  }
  return { ja, failed };
}
