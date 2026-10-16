import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asTravelProject, digest, travelGoldenInputs } from './helpers/travelGoldenInputs';

/**
 * Travel golden (version 11): the compiled JSON and the evaluated frames of the travel camera system on fixed inputs.
 * v11: an exchange between stage neighbours (adjacent slot rank) is allowed whatever the measured spacing (the maxTravelW cap stays);
 * a speaker change into cu / ecu is inferred as exchange, not reaction.
 * v10: travel two-shots pair neighbours only (the middle person stays in frame when the pair is not adjacent); wide landings
 * (group / two-shot / ms) with the same or a neighbouring person move by default, with the reason rewritten from the geometry when the
 * intent label contradicts it; an AI flow=cut is only a suggestion (honoured for reaction / rupture / a new person into cu / ecu).
 * Two-shot framing is unchanged from v9.
 * v9: narrative intent + real geometry + resting time replace ID probability; stable dialogue holds, explicit cuts remain cuts;
 * generated shot movement is intent-driven and decorative cut drift is retired. Static framing is unchanged from v8.
 * v8: classic two-shot face layout; solo medium conversations; classic background endpoints with motion-only parallax residual;
 * authored-blocking facing in both systems; default landing push disabled. Manual background zoom is respected.
 * v7 = v6 with the classic look: stage pitch 2.0 -> 1.3 heads, group head = classic groupHeadTarget(n) (travel.groupHead removed), two-shots keep only the pair
 * (the maintainer: 5 people stood far too spread out in travel; classic's spacing and head size are the reference).
 * v6 = v5 with medium shots keeping only the speaker and the previous shot's people (the original lets the others leave the stage; ms with a bystander
 * 100% -> about 15-35%, original 14-67%).
 * v5 = v4 with the longest sideways move raised from 0.7 to 1 frame width (the original moves skip-one medium shots, about 0.9 frame
 * widths, 33% of the time; at 0.7 the gate cut them before the move / cut table was asked).
 * v4: the faithful phase-3 travel system plus the gap fixes: travel groups framed wide (head 0.23 of the frame), compact-stage pitch 2.0
 * heads and parallax sigma 1.2, hashed exceptions per transition class, a visible post-cut drift, durations spread by move size, and an mcu
 * every 4-5 lines in the rule director. (v3: structural move / cut rules, OutQuad, depth based blur, ms, post-cut drift.)
 * Written only with UPDATE_TRAVEL_GOLDEN=1, and recorded once for v11. When the travel look is changed on purpose again: add a new
 * `.v12.json`, raise CompiledScene.travel.version, and say why in the commit message. The classic golden is a different
 * file and is never regenerated.
 */
const GOLDEN_PATH = path.resolve('tests/fixtures/camera-travel-golden.v11.json');

describe('travel camera golden v11', () => {
  it('compiled output and evaluated frames match the recorded travel baseline', async () => {
    const inputs = await travelGoldenInputs();
    const got: Record<string, { compiled: string; frames: string }> = {};
    for (const [name, { project, ctx }] of Object.entries(inputs)) got[name] = digest(asTravelProject(project), ctx);
    if (process.env.UPDATE_TRAVEL_GOLDEN === '1') {
      if (fs.existsSync(GOLDEN_PATH)) throw new Error('Travel golden already exists; bump the version instead of re-recording it.');
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(got, null, 2) + '\n');
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as typeof got;
    expect(Object.keys(got).sort()).toEqual(Object.keys(golden).sort());
    for (const name of Object.keys(got)) expect(got[name], name).toEqual(golden[name]);
  });

  it('is deterministic: two compiles of the same input give identical digests', async () => {
    const inputs = await travelGoldenInputs();
    for (const [name, { project, ctx }] of Object.entries(inputs)) expect(digest(asTravelProject(project), ctx), name).toEqual(digest(asTravelProject(project), ctx));
  });
});
