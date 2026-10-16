import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import demo from '../fixtures/demo-project.json';
import aiA from '../fixtures/ai-generated-project.json';
import aiB from '../fixtures/ai-generated-project-b.json';
import aiC from '../fixtures/ai-generated-project-c.json';
import { runBreakdown } from '../../server/llm/director';
import { RuleProvider } from '../../server/llm/ruleProvider';
import { runScenes } from '../../server/llm/sceneRunner';
import { ProjectSchema, type Project } from '../../shared/schema/project';
import { compileProject } from '../../shared/timeline/compile';
import { evaluate } from '../../shared/timeline/evaluate';
import type { CompileContext } from '../../shared/timeline/types';
import { compileContext, fixtureCatalog } from './helpers/directorCatalog';
import { MINI_CTX, fakeContext, miniProject } from './helpers/synthetic';

/**
 * Classic-camera golden: the compiled JSON and the evaluated frames of every classic scene must stay byte-identical
 * across all camera work. The baseline file is generated once on unmodified code and NEVER regenerated afterwards.
 */
const GOLDEN_PATH = path.resolve('tests/fixtures/camera-classic-golden.json');
const sha = (s: string) => createHash('sha1').update(s).digest('hex');

export function digest(project: Project, ctx: CompileContext): { compiled: string; frames: string } {
  const c = compileProject(project, ctx);
  const ts = new Set<number>();
  const step = Math.max(0.1, c.duration / 2999);
  for (let t = 0; t <= c.duration + 1e-9; t += step) ts.add(+t.toFixed(6));
  for (const sc of c.scenes) for (const k of sc.camera) ts.add(k.at).add(k.at + k.duration / 2).add(k.at + k.duration);
  const sorted = [...ts].sort((a, b) => a - b);
  return { compiled: sha(JSON.stringify(c)), frames: sha(JSON.stringify(sorted.map((t) => evaluate(c, t)))) };
}

function fixtureInput(raw: unknown): { project: Project; ctx: CompileContext } {
  const project = ProjectSchema.parse(raw);
  const models = new Set<string>();
  for (const sc of project.scenes) {
    Object.values(sc.wardrobe).forEach((w) => models.add(w.modelId));
    for (const t of sc.tracks) if (t.channel === 'costume') t.keys.forEach((k) => models.add(k.value.modelId));
  }
  return { project, ctx: fakeContext([...models], project.scenes.map((sc) => sc.background.assetId)) };
}

const NOVEL = fs.readFileSync(path.resolve('examples/mygo-rehearsal.txt'), 'utf8');

export async function goldenInputs(): Promise<Record<string, { project: Project; ctx: CompileContext }>> {
  const base = fixtureCatalog(['002', '003', '004', '005']);
  const nick: Record<string, string> = { '001': '灯', '002': '爱音', '003': '乐奈', '004': '爽世', '005': '立希' };
  const cat = { ...base, characters: base.characters.map((c) => ({ ...c, nickname: nick[c.key] ?? null, aliases: nick[c.key] ? [nick[c.key]!] : [] })) };
  const deps = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
  const { project } = await runBreakdown(deps, NOVEL, '示例', 'g1');
  const items = await runScenes(deps, project, project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
  const rule: Project = { ...project, scenes: items.map((i) => i.result!.scene) };
  const glideBeats = miniProject().scenes[0]!.beats.map((b) => ({ ...b, shot: { ...b.shot, transition: 'glide' } }));
  const motion = miniProject({ beats: [
    { id: 'b1', kind: 'dialogue', speakerId: 'a', text: '你好呀，今天天气真不错。', shot: { type: 'mcu', focus: ['a'], move: 'push_in', dof: 2 } },
    { id: 'b2', kind: 'dialogue', speakerId: 'a', text: '是啊。', shot: { type: 'cu', focus: ['a'], move: 'shake', dof: 3 } },
    { id: 'b3', kind: 'dialogue', speakerId: 'b', text: '我们去哪里？', shot: { type: 'two_shot', focus: ['a', 'b'], move: 'pull_out', dof: 0 } },
  ] });
  return {
    demo: fixtureInput(demo), aiA: fixtureInput(aiA), aiB: fixtureInput(aiB), aiC: fixtureInput(aiC),
    rule: { project: rule, ctx: compileContext(cat) },
    miniPlain: { project: miniProject(), ctx: MINI_CTX },
    miniGlideStyle: { project: miniProject({ style: { 'performance.glideSeconds': 0.4 } }), ctx: MINI_CTX },
    miniGlideBeats: { project: miniProject({ beats: glideBeats }), ctx: MINI_CTX },
    miniMotion: { project: motion, ctx: MINI_CTX },
  };
}

describe('classic camera golden', () => {
  it('compiled output and evaluated frames match the baseline recorded before the travel work', async () => {
    const inputs = await goldenInputs();
    const got: Record<string, { compiled: string; frames: string }> = {};
    for (const [name, { project, ctx }] of Object.entries(inputs)) got[name] = digest(project, ctx);
    if (process.env.UPDATE_CAMERA_GOLDEN === '1') {
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(got, null, 2) + '\n');
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as typeof got;
    expect(Object.keys(got).sort()).toEqual(Object.keys(golden).sort());
    for (const name of Object.keys(got)) expect(got[name], name).toEqual(golden[name]);
  });
});
