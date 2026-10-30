/**
 * The editor's 「自动拆分」: run the split pass (AI when a model is configured, the rule splitter otherwise) over the beats the user names and
 * return the decided pieces WITHOUT applying anything. The client turns each plan into a `beat_split_pieces` op (one undo step) itself.
 */
import { actorResources, type ActorResources } from '../../shared/director/catalogDigest';
import { lookup } from '../../shared/director/resources';
import type { SceneDirection } from '../../shared/schema/ai';
import { cameraSystemOf, type Beat, type Project } from '../../shared/schema/project';
import { fitsDialog } from '../../shared/style/dialogLayout';
import { resolveStyle } from '../../shared/style/ournotes';
import { TEXT_KINDS } from '../../shared/timeline/time';
import type { DirectorDeps } from './director';
import type { RunInfo } from './pipeline';
import { runSplitPass } from './splitPass';

export interface SplitLinesResult {
  sceneId: string;
  splits: Array<{ beatId: string; by: 'ai' | 'retry' | 'rule'; pieces: Array<{ text: string; emotion: string; why: string; camera?: 'closer' | 'reaction'; reactionOf?: string; motion?: string; expression?: string; attention?: string }> }>;
  skipped: Array<{ beatId: string; reason: string }>;
  warnings: string[];
  runs: RunInfo[];
}

export async function runSplitLines(d: DirectorDeps, project: Project, sceneId: string, beatIds: string[] | undefined): Promise<SplitLinesResult> {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`场景 ${sceneId} 不存在`);
  const style = resolveStyle(project.style, scene.style).values.dialog;
  const want = new Set(beatIds ?? scene.beats.map((b) => b.id));
  const skipped: SplitLinesResult['skipped'] = [];
  const reason = (b: Beat): string | null => {
    if (!TEXT_KINDS.includes(b.kind) || b.text.trim() === '' || b.kind === 'action') return '这一句没有台词文字';
    if (b.meta.locked || (b.meta.lockedFields?.length ?? 0) > 0) return '这一句已锁定';
    if (b.overflow === 'expand') return '这一句已设为展开显示';
    if (!fitsDialog(b.text, resolveStyle(project.style, scene.style, b.style).values.dialog, b.variant).over) return '这一句放得下，不用拆';
    return null;
  };
  for (const id of want) if (!scene.beats.some((b) => b.id === id)) skipped.push({ beatId: id, reason: `台词 ${id} 不在场景里` });
  // the whole scene goes in as a direction (the neighbours are context for the model); only the named, splittable beats are free
  const free = new Set<string>();
  for (const b of scene.beats) {
    if (!want.has(b.id)) continue;
    const why = reason(b);
    if (why) skipped.push({ beatId: b.id, reason: why });
    else free.add(b.id);
  }
  if (free.size === 0) return { sceneId, splits: [], skipped, warnings: [], runs: [] };
  const cast = Object.keys(scene.wardrobe);
  const direction: SceneDirection = {
    reason: '', blocking: [], transitionIn: 'cut', bgm: null, costumeChanges: [],
    beats: scene.beats.map((b, i) => ({
      keepId: free.has(b.id) ? null : b.id, paragraph: i, kind: (b.kind === 'dialogue' || b.kind === 'narration' ? b.kind : 'silent') as 'silent', speaker: b.speakerId ?? null, text: b.text,
      emotion: (b.emotion ?? 'neutral') as 'neutral', reason: '', shot: { type: b.shot.type as 'mcu', focus: [...b.shot.focus], move: 'static', dof: null }, cutIn: 'cut', fx: 'none', actors: [],
    })),
  };
  const L = lookup(d.catalog);
  const sp = await runSplitPass({
    d, direction, scene: { title: scene.title, mood: scene.brief?.mood ?? '' }, cameraSystem: cameraSystemOf(project, scene), style, castIds: cast, label: scene.title,
    actorAt: (castId) => {
      const m = project.cast.find((c) => c.id === castId);
      const modelId = scene.wardrobe[castId]?.modelId;
      const model = modelId ? L.models.get(modelId) : undefined;
      const res: ActorResources | null = m && modelId ? actorResources(d.catalog, castId, m.characterKey, modelId) : null;
      return res && model ? { res, model } : null;
    },
  });
  const splits = sp.plans.map((p) => ({
    beatId: scene.beats[p.index]!.id, by: p.by,
    // the camera intent and the performance the model decided (after the soft repair) travel with the cut: the editor replays them as part of the op
    pieces: p.pieces.map((x, k) => ({
      text: x.text, emotion: x.emotion, why: x.why,
      ...(k > 0 && x.camera !== 'hold' ? { camera: x.camera } : {}), ...(k > 0 && x.reactionOf ? { reactionOf: x.reactionOf } : {}),
      ...(k > 0 && x.actor?.motion ? { motion: x.actor.motion } : {}), ...(k > 0 && x.actor?.expression ? { expression: x.actor.expression } : {}),
      ...(k > 0 && x.actor?.attention ? { attention: x.actor.attention } : {}),
    })),
  }));
  for (const id of free) if (!splits.some((s) => s.beatId === id)) skipped.push({ beatId: id, reason: '没有找到合适的断点' });
  return { sceneId, splits, skipped, warnings: sp.warnings, runs: sp.runs };
}
