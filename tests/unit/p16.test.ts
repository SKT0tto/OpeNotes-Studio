import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmCache, generateCached } from '../../server/llm/cache';
import { TruncatedError, zeroUsage, type LlmProvider, type StructuredRequest } from '../../server/llm/provider';
import { z } from 'zod';
import { alignToOld, diffScene } from '../../shared/director/diff';
import { validateDirection } from '../../shared/director/validate';
import { SceneDirectionSchema } from '../../shared/schema/ai';
import { recordedDirection, sceneCtx, skeleton } from './helpers/directorFlow';

describe('M2: a truncated request is remembered', () => {
  it('is not sent again with the same room, but is with more', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trunc-'));
    let sent = 0;
    const provider = {
      id: 'openai', model: 'm', test: async () => ({ model: 'm', latencyMs: 0 }),
      generateStructured: async (r: StructuredRequest<unknown>) => {
        sent++;
        if (r.maxTokens < 3000) throw new TruncatedError();
        return { data: { a: 1 }, raw: '{"a":1}', usage: zeroUsage(), warnings: [] };
      },
    } as unknown as LlmProvider;
    const cache = new LlmCache(dir);
    const req = (maxTokens: number): StructuredRequest<{ a: number }> => ({ system: 's', input: { x: 1 }, schema: z.object({ a: z.number() }), schemaName: 'T', maxTokens });
    await expect(generateCached(provider, cache, 'v1', req(1000))).rejects.toBeInstanceOf(TruncatedError);
    await expect(generateCached(provider, cache, 'v1', req(1000))).rejects.toBeInstanceOf(TruncatedError);
    expect(sent).toBe(1);
    const ok = await generateCached(provider, cache, 'v1', req(4000));
    expect(ok.data).toEqual({ a: 1 });
    expect(sent).toBe(2);
    expect((await generateCached(provider, cache, 'v1', req(1000))).cached).toBe(true); // the good answer now serves every repeat
    expect(sent).toBe(2);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('H2: an insert needs something to show', () => {
  it('becomes cu when the line has no gesture, prop or instrument; stays with a prop (and gets a target)', () => {
    const project = skeleton();
    const ctx = sceneCtx(project, project.scenes[0]!);
    const d = SceneDirectionSchema.parse(JSON.parse(JSON.stringify(recordedDirection(0))));
    const dlg = d.beats.filter((b) => b.kind === 'dialogue');
    dlg[0]!.shot = { ...dlg[0]!.shot, type: 'insert' };
    dlg[0]!.actors.forEach((a) => { a.motion = null; });
    dlg[0]!.text = dlg[0]!.text.replace(/手|指|琴|吉他|杯/g, '');
    dlg[1]!.shot = { ...dlg[1]!.shot, type: 'insert' };
    dlg[1]!.text = `${dlg[1]!.text}她握紧了手。`;
    const v = validateDirection(d, ctx);
    const b0 = v.value.beats.find((b) => b.text === dlg[0]!.text)!;
    const b1 = v.value.beats.find((b) => b.text === dlg[1]!.text)!;
    expect(b0.shot.type).toBe('cu');
    expect(v.warnings.join('\n')).toContain('插入镜头');
    expect(b1.shot.type).toBe('insert');
    expect(b1.shot.insertTarget).toBe('hands');
  });
});

describe('M1/M3: partial accept and readable names', () => {
  it('alignToOld gives same-text beats the old ids; diff shows names, not ids', () => {
    const project = skeleton();
    const old = project.scenes[0]!;
    const withText = { ...old, beats: old.beats.map((b, i) => ({ ...b, text: b.text || `第${i}句`, id: b.id })) };
    const fresh = JSON.parse(JSON.stringify(withText)) as typeof withText;
    fresh.beats = fresh.beats.map((b) => ({ ...b, id: `x_${b.id}` }));
    const al = alignToOld(withText, fresh);
    expect(al.beats.map((b) => b.id)).toEqual(withText.beats.map((b) => b.id));
    const d = diffScene(withText, fresh, { cast: (id) => `角色${id}`, model: () => '便服' });
    expect(d.structural).toBe(true);
    expect(JSON.stringify(d.items)).not.toMatch(/exp_|mtn_|\bmcu\b|\bcut\b/);
  });
});
