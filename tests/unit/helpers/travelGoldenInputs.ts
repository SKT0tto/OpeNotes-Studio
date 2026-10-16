import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import demo from '../../fixtures/demo-project.json';
import aiA from '../../fixtures/ai-generated-project.json';
import aiB from '../../fixtures/ai-generated-project-b.json';
import aiC from '../../fixtures/ai-generated-project-c.json';
import { runBreakdown } from '../../../server/llm/director';
import { RuleProvider } from '../../../server/llm/ruleProvider';
import { runScenes } from '../../../server/llm/sceneRunner';
import { ProjectSchema, type Project } from '../../../shared/schema/project';
import { compileProject } from '../../../shared/timeline/compile';
import { evaluate } from '../../../shared/timeline/evaluate';
import type { CompileContext } from '../../../shared/timeline/types';
import { compileContext, fixtureCatalog } from './directorCatalog';
import { MINI_CTX, fakeContext, miniProject } from './synthetic';

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

/** sha1 of the compiled JSON and of the evaluated frames (even grid plus every camera key's start / middle / end). */
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

export const asTravelProject = (p: Project): Project => ({ ...p, settings: { ...p.settings, cameraSystem: 'travel' } });

/** The inputs of the travel golden: the four fixtures, the rule-directed example novel and a hand-made sideways sequence, all in travel mode. */
export async function travelGoldenInputs(): Promise<Record<string, { project: Project; ctx: CompileContext }>> {
  const base = fixtureCatalog(['002', '003', '004', '005']);
  const nick: Record<string, string> = { '001': '灯', '002': '爱音', '003': '乐奈', '004': '爽世', '005': '立希' };
  const cat = { ...base, characters: base.characters.map((c) => ({ ...c, nickname: nick[c.key] ?? null, aliases: nick[c.key] ? [nick[c.key]!] : [] })) };
  const deps = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
  const novel = fs.readFileSync(path.resolve('examples/mygo-rehearsal.txt'), 'utf8');
  const { project } = await runBreakdown(deps, novel, '示例', 'g1');
  const items = await runScenes(deps, asTravelProject(project), project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
  const rule: Project = { ...project, scenes: items.map((i) => i.result!.scene) };
  const LONG = '这是一句足够长的台词，用来让这一拍持续好几秒钟，好让运镜有时间完成。';
  const sideways = miniProject({
    beats: [
      { id: 'b1', kind: 'dialogue', speakerId: 'a', text: LONG, shot: { type: 'mcu', focus: ['a'], move: 'static', dof: 2 } },
      { id: 'b2', kind: 'dialogue', speakerId: 'b', text: LONG, shot: { type: 'mcu', focus: ['b'], move: 'static', dof: 2, transition: 'travel' } },
      { id: 'b3', kind: 'dialogue', speakerId: 'a', text: LONG, shot: { type: 'two_shot', focus: ['a', 'b'], move: 'static', dof: 2, transition: 'travel' } },
      { id: 'b4', kind: 'dialogue', speakerId: 'a', text: LONG, shot: { type: 'cu', focus: ['a'], move: 'push_in', dof: 5, transition: 'travel' } },
    ],
  });
  return {
    demo: fixtureInput(demo), aiA: fixtureInput(aiA), aiB: fixtureInput(aiB), aiC: fixtureInput(aiC),
    rule: { project: rule, ctx: compileContext(cat) },
    sideways: { project: sideways, ctx: MINI_CTX },
  };
}
