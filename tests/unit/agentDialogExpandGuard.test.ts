import { describe, expect, it, vi } from 'vitest';
import { clone } from '../../shared/project/mutate';
import { cat, directedProject } from './helpers/directorFlow';

// Until the assistant's `dialog_expand` op exists (S6), no real op writes `overflow`. The guard in checkOp is generic: it looks at the
// simulated result, so a stand-in apply that sets the field exercises exactly the path every future op (single, batch, script) goes through.
vi.mock('../../shared/agent/apply', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../shared/agent/apply')>();
  return {
    ...real,
    applyOp: (project: Parameters<typeof real.applyOp>[0], op: Parameters<typeof real.applyOp>[1], ctx: Parameters<typeof real.applyOp>[2]) => {
      const out = real.applyOp(project, op, ctx);
      if (op.op === 'beat_set' && op.set.emotion === 'sad' && op.reason === 'expand-stand-in') {
        const b = project.scenes.find((s) => s.id === op.sceneId)!.beats.find((x) => x.id === op.beatId)!;
        b.overflow = 'expand';
      }
      return out;
    },
  };
});

const { checkOp, DIALOG_EXPAND_NOT_ASKED } = await import('../../shared/agent/check');
const { AgentOpSchema } = await import('../../shared/agent/ops');

const P = directedProject();
const S = P.scenes[2]!;
const ctx = { catalog: cat };
const standIn = { op: 'beat_set', sceneId: S.id, beatId: S.beats[1]!.id, set: { emotion: 'sad' }, reason: 'expand-stand-in' };

describe('checkOp: overflow can only be set on an explicit request', () => {
  it('rejects an op that leaves a beat expanded when the user did not ask', () => {
    const r = checkOp(P, standIn, ctx);
    expect(r.status).toBe('invalid');
    expect(r.problems[0]).toContain(DIALOG_EXPAND_NOT_ASKED);
    expect(checkOp(P, standIn, { ...ctx, allowDialogExpand: false }).status).toBe('invalid');
  });
  it('lets it through when the request allows it', () => {
    expect(checkOp(P, standIn, { ...ctx, allowDialogExpand: true }).status).not.toBe('invalid');
  });
  it('a beat that was already expanded is not new: other ops on it are fine', () => {
    const p = clone(P);
    p.scenes[2]!.beats[1]!.overflow = 'expand';
    expect(checkOp(p, standIn, ctx).status).not.toBe('invalid');
  });
  it('beat_set cannot carry an overflow field at all (strict schema), also inside a batch-style raw op', () => {
    const raw = { op: 'beat_set', sceneId: S.id, beatId: S.beats[1]!.id, set: { overflow: 'expand' } };
    expect(AgentOpSchema.safeParse(raw).success).toBe(false);
    expect(checkOp(P, raw, { ...ctx, allowDialogExpand: true }).status).toBe('invalid');
    expect(checkOp(P, { ...raw, set: { text: 'x', splitFrom: 'b' } }, ctx).status).toBe('invalid');
  });
  it('an ordinary edit is unaffected', () => {
    expect(checkOp(P, { op: 'beat_set', sceneId: S.id, beatId: S.beats[1]!.id, set: { emotion: 'sad' } }, ctx).status).toBe('ok');
  });
});
