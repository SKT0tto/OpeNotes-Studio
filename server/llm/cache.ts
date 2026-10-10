import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LlmError, TruncatedError, stableStringify, type LlmProvider, type LlmUsage, type StructuredRequest, type StructuredResult } from './provider';

interface Entry {
  data: unknown;
  raw: string;
  usage: LlmUsage;
  createdAt: number;
  provider: string;
  model: string;
  schemaName: string;
  /** Marker: this request was cut off at this many output tokens (a repeat with no more room is not sent again). */
  truncatedAt?: number;
}

/** `data/llm-cache/<sha256>.json`: the key covers provider, model, prompt version, schema and the normalised input. */
export class LlmCache {
  constructor(private readonly dir: string) {}

  static key(provider: Pick<LlmProvider, 'id' | 'model'>, promptVersion: string, req: StructuredRequest<unknown>): string {
    return createHash('sha256')
      .update(stableStringify([provider.id, provider.model, promptVersion, req.schemaName, req.system, req.cacheablePrefix ?? '', req.input]))
      .digest('hex');
  }

  private file(key: string) {
    return path.join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<Entry | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(key), 'utf8')) as Entry;
    } catch {
      return null;
    }
  }

  async set(key: string, e: Entry): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(key)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(e));
    await fs.rename(tmp, this.file(key));
  }
}

export interface CachedCall<T> extends StructuredResult<T> {
  key: string;
  ms: number;
}

/** Cache in front of any provider: a hit sends no request; only successful, schema-valid results are stored. */
export async function generateCached<T>(
  provider: LlmProvider,
  cache: LlmCache | null,
  promptVersion: string,
  req: StructuredRequest<T>,
  opts: { refresh?: boolean } = {},
): Promise<CachedCall<T>> {
  const t0 = Date.now();
  const key = LlmCache.key(provider, promptVersion, req as StructuredRequest<unknown>);
  if (cache && !opts.refresh) {
    const hit = await cache.get(key);
    if (hit?.truncatedAt !== undefined && req.maxTokens <= hit.truncatedAt) throw new TruncatedError();
    if (hit && hit.truncatedAt === undefined) {
      const ok = req.schema.safeParse(hit.data);
      if (ok.success) return { data: ok.data, usage: hit.usage, cached: true, raw: hit.raw, warnings: [], key, ms: Date.now() - t0 };
    }
  }
  let r;
  try {
    r = await provider.generateStructured(req);
  } catch (e) {
    if (cache && e instanceof LlmError && e.kind === 'truncated') {
      await cache.set(key, { data: null, raw: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, createdAt: Date.now(), provider: provider.id, model: provider.model, schemaName: req.schemaName, truncatedAt: req.maxTokens }).catch(() => {});
    }
    throw e;
  }
  if (cache) await cache.set(key, { data: r.data, raw: r.raw, usage: r.usage, createdAt: Date.now(), provider: provider.id, model: provider.model, schemaName: req.schemaName }).catch(() => {});
  return { ...r, cached: false, key, ms: Date.now() - t0 };
}
