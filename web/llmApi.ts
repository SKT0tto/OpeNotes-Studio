import type { LlmSettingsPatch, PublicLlmSettings } from '@shared/schema/settings';

export interface TestOutcome {
  ok: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  error?: { kind: string; message: string };
}

export async function fetchLlmSettings(): Promise<PublicLlmSettings> {
  const res = await fetch('/api/llm/settings');
  if (!res.ok) throw new Error(`设置读取失败：HTTP ${res.status}`);
  return (await res.json()) as PublicLlmSettings;
}

export async function saveLlmSettings(patch: LlmSettingsPatch): Promise<PublicLlmSettings> {
  const res = await fetch('/api/llm/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`设置保存失败：HTTP ${res.status}`);
  return (await res.json()) as PublicLlmSettings;
}

export async function testLlm(): Promise<TestOutcome> {
  const res = await fetch('/api/llm/test', { method: 'POST' });
  if (!res.ok) return { ok: false, error: { kind: 'server', message: `HTTP ${res.status}` } };
  return (await res.json()) as TestOutcome;
}
