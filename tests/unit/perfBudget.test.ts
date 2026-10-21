import { describe, expect, it } from 'vitest';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import { MINI_CTX, miniProject } from './helpers/synthetic';

/**
 * Generous performance budgets for the pure pipeline (not frame times: those need a GPU, see .verify / the plan in
 * dev-notes/perf-optimization-plan.md). The limits are ~10x the cost measured on a development laptop so they only trip on a real
 * regression (an accidental O(n^2), a per-call JSON clone), never on a slow CI box.
 */
const BEATS = 300;
const shotTypes = ['two_shot', 'mcu', 'cu'];
const beats = Array.from({ length: BEATS }, (_, i) => ({
  id: `b${i}`,
  kind: 'dialogue',
  speakerId: i % 2 ? 'a' : 'b',
  text: 'これはテストの台詞です。今日もいい天気ですね。',
  shot: { type: shotTypes[i % 3]!, focus: i % 2 ? ['a'] : ['a', 'b'], move: i % 4 === 0 ? 'push_in' : 'static', dof: i % 5 },
}));
const tracks = (['head', 'gaze', 'expression'] as const).flatMap((ch) =>
  ['a', 'b'].map((c) => ({
    id: `t_${ch}_${c}`,
    target: { kind: 'actor', castId: c },
    channel: ch,
    keys: beats.map((b, i) => ({
      id: `k_${ch}_${c}_${i}`,
      at: { beatId: b.id, offset: 0.1 },
      value: ch === 'head' ? { mode: 'angle', yaw: (i % 7) / 10 } : ch === 'gaze' ? { x: (i % 5) / 10, y: 0 } : { name: i % 2 ? 'exp_smile01' : 'exp_sad01' },
      duration: 0.4,
      ease: 'inOutQuad',
    })),
  })),
);

function build(system: 'classic' | 'travel') {
  const p = miniProject({ beats, tracks });
  p.settings.cameraSystem = system;
  return p;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe.each(['classic', 'travel'] as const)('perf budget (%s camera)', (system) => {
  const project = build(system);
  it('compiles a 300-line, 1800-key project within budget', () => {
    compileProject(project, MINI_CTX); // warm-up
    const runs = Array.from({ length: 5 }, () => {
      const t0 = performance.now();
      compileProject(project, MINI_CTX);
      return performance.now() - t0;
    });
    expect(median(runs)).toBeLessThan(1500);
  });
  it('evaluates a frame within budget', () => {
    const compiled = compileProject(project, MINI_CTX);
    const n = 5000;
    for (let i = 0; i < 200; i++) evaluate(compiled, (i / 200) * compiled.duration);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) evaluate(compiled, ((i * 7919) % 10000) / 10000 * compiled.duration);
    const perCallUs = ((performance.now() - t0) / n) * 1000;
    // a frame at 240 Hz has 4170 us; evaluate must stay a rounding error next to it
    expect(perCallUs).toBeLessThan(600);
  });
});
