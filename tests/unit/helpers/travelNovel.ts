import fs from 'node:fs';
import path from 'node:path';
import { runBreakdown } from '../../../server/llm/director';
import { RuleProvider } from '../../../server/llm/ruleProvider';
import { runScenes } from '../../../server/llm/sceneRunner';
import type { Project } from '../../../shared/schema/project';
import { compileContext, fixtureCatalog } from './directorCatalog';

export const asTravel = (p: Project): Project => ({ ...p, settings: { ...p.settings, cameraSystem: 'travel' } });

export async function novelProject() {
  const base = fixtureCatalog(['002', '003', '004', '005']);
  const nick: Record<string, string> = { '001': '灯', '002': '爱音', '003': '乐奈', '004': '爽世', '005': '立希' };
  const cat = { ...base, characters: base.characters.map((c) => ({ ...c, nickname: nick[c.key] ?? null, aliases: nick[c.key] ? [nick[c.key]!] : [] })) };
  const deps = { provider: new RuleProvider(cat), cache: null, catalog: cat, now: () => 7000 };
  const novel = fs.readFileSync(path.resolve('examples/mygo-rehearsal.txt'), 'utf8');
  const { project } = await runBreakdown(deps, novel, '示例', 'g1');
  const items = await runScenes(deps, asTravel(project), project.scenes.map((s) => s.id), ['scene'], 'g2', 3);
  const p: Project = { ...project, scenes: items.map((i) => i.result!.scene) };
  return { p, ctx: compileContext(cat), deps, project };
}
