/** Pass 2: one model call per scene (two for a very long one), validation / repair, expansion, merge with the locks. */
import { actorResources } from '../../shared/director/catalogDigest';
import { expandScene } from '../../shared/director/expand';
import { mergeLocks, type MergeConflict, type MergeReport } from '../../shared/director/mergeLocks';
import type { Paragraph } from '../../shared/director/paragraphs';
import { splitParagraphs } from '../../shared/director/paragraphs';
import { lookup } from '../../shared/director/resources';
import type { ScopeName } from '../../shared/director/scope';
import { validateDirection } from '../../shared/director/validate';
import { SceneDirectionSchema, type SceneDirection } from '../../shared/schema/ai';
import type { Beat, Project, Scene } from '../../shared/schema/project';
import type { DirectorDeps } from './director';
import { DirectorError, runStep, type RunInfo } from './pipeline';
import { LlmError, isModelAi } from './provider';
import { SCENE_PROMPT_VERSION, SCENE_SYSTEM, sceneInput, type SceneDirectionInput } from './prompts/sceneDirection';

export interface SceneRequest {
  project: Project;
  sceneId: string;
  scopes: ScopeName[];
  /** Regenerate only these beats (their fields and keys; the text stays). */
  beatIds?: string[] | undefined;
  overwriteUser?: boolean | undefined;
}

export interface SceneResult {
  sceneId: string;
  /** The merged scene (equals the old one when `applied` is false). */
  scene: Scene;
  applied: boolean;
  conflicts: MergeConflict[];
  report: MergeReport;
  /** The validated intent the model produced, before expansion (for the "AI view"). */
  direction: SceneDirection;
  warnings: string[];
  runs: RunInfo[];
}

const MAX_PARAS_PER_CALL = 45;
/** Output tokens per paragraph of source text (about two beats of ~300 tokens each). */
const TOKENS_PER_PARA = 700;

const protectedBeat = (b: Beat, overwrite: boolean) => b.meta.locked || (b.meta.lockedFields?.length ?? 0) > 0 || (!overwrite && b.meta.source === 'user');

function endSummary(project: Project, index: number): SceneDirectionInput['previousScene'] {
  const prev = project.scenes[index - 1];
  if (!prev) return null;
  const last = [...prev.beats].reverse().find((b) => b.text);
  const wear = Object.entries(prev.wardrobe).map(([c, w]) => `${project.cast.find((x) => x.id === c)?.displayName ?? c}:${w.modelId}`).join('，');
  return { title: prev.title, endSummary: `${last ? `最后一句：${[...last.text].slice(0, 40).join('')}（情绪 ${last.emotion ?? '—'}）。` : ''}服装：${wear}` };
}

const combine = (a: SceneDirection, b: SceneDirection): SceneDirection => ({
  ...a,
  beats: [...a.beats, ...b.beats],
  costumeChanges: [...a.costumeChanges, ...b.costumeChanges.map((c) => ({ ...c, beatIndex: c.beatIndex + a.beats.length }))],
  blocking: a.blocking.length > 0 ? a.blocking : b.blocking,
});

export async function runScene(d: DirectorDeps, req: SceneRequest, genId: string): Promise<SceneResult> {
  const { project } = req;
  const index = project.scenes.findIndex((s) => s.id === req.sceneId);
  const scene = project.scenes[index];
  if (!scene) throw new LlmError('bad_request', `场景 ${req.sceneId} 不存在`);
  const paragraphs = splitParagraphs(project.source.text);
  const inScene = paragraphs.filter((p) => p.start >= scene.sourceSpan.start && p.end <= scene.sourceSpan.end);
  if (inScene.length === 0) throw new LlmError('bad_request', `场景「${scene.title}」没有对应的原文段落（手工创建的场景不能用 AI 导演）`);
  const overwrite = req.overwriteUser === true;
  const L = lookup(d.catalog);
  const now = (d.now ?? Date.now)();

  const cast = Object.keys(scene.wardrobe).map((castId) => {
    const m = project.cast.find((c) => c.id === castId);
    const a = m ? actorResources(d.catalog, castId, m.characterKey, scene.wardrobe[castId]!.modelId) : null;
    if (!a) throw new LlmError('bad_request', `角色 ${castId} 的服装不在素材库中`);
    return a;
  });
  const bg = L.backgrounds.get(scene.background.assetId);
  const structure = req.scopes.includes('scene') && !req.beatIds;
  const fixed: Beat[] = structure ? scene.beats.filter((b) => protectedBeat(b, overwrite)) : req.beatIds ? scene.beats.filter((b) => req.beatIds!.includes(b.id)) : scene.beats;
  const paraOfBeat = (b: Beat): number => paragraphs.find((p) => b.sourceOffset !== undefined && b.sourceOffset >= p.start && b.sourceOffset <= p.end)?.index ?? inScene[0]!.index;
  const fixedInput = (b: Beat): SceneDirectionInput['fixedBeats'][number] => ({
    keepId: b.id, paragraph: paraOfBeat(b), kind: b.kind, speaker: b.speakerId ?? null, text: b.text, ...(b.meta.lockedFields ? { lockedFields: b.meta.lockedFields } : {}),
  });

  const cap = d.provider.maxOutputTokens ?? 16000;
  const perCall = Math.max(4, Math.min(MAX_PARAS_PER_CALL, Math.floor((cap - 1500) / TOKENS_PER_PARA)));
  const runs: RunInfo[] = [];
  const direct = async (paras: Paragraph[], prev: SceneDirectionInput['previousScene'], fixedHere: Beat[], label: string): Promise<SceneDirection> => {
    const input: SceneDirectionInput = {
      scene: {
        title: scene.title, mood: scene.brief?.mood ?? '', timeOfDay: scene.brief?.timeOfDay ?? '',
        location: bg ? `${bg.name}${bg.location ? `（${bg.location}）` : ''}` : scene.background.assetId,
        isPerformance: !!scene.brief?.isPerformance, band: scene.brief?.band ?? null, paragraphRange: [paras[0]!.index, paras.at(-1)!.index],
      },
      cast,
      paragraphs: paras.map((p) => ({ i: p.index, text: p.text })),
      previousScene: prev,
      fixedBeats: fixedHere.map(fixedInput),
      mode: { scopes: req.scopes, ...(req.beatIds ? { focusBeatIds: fixedHere.map((b) => b.id) } : {}) },
    };
    const range = { start: paras[0]!.index, end: paras.at(-1)!.index };
    const fixedIds = new Set(fixedHere.map((b) => b.id));
    const tokens = Math.min(cap, structure ? 1500 + TOKENS_PER_PARA * paras.length : Math.max(4000, 1500 + 700 * Math.max(1, fixedHere.length)));
    const step = (maxTokens: number) => runStep({
      provider: d.provider, cache: d.cache, promptVersion: SCENE_PROMPT_VERSION, pass: 'scene', label, refresh: d.refresh === true,
      req: { system: SCENE_SYSTEM, input: sceneInput(input), schema: SceneDirectionSchema, schemaName: 'SceneDirection', maxTokens, signal: d.signal },
      validate: (dir) => {
        const v = validateDirection(dir, {
          catalog: d.catalog, cast: cast.map((c) => ({ castId: c.castId, characterKey: c.characterKey, modelId: c.modelId })), paragraphs, range,
          isPerformance: !!scene.brief?.isPerformance, fixedBeatIds: fixedIds,
        });
        if (!structure) {
          const got = new Set(v.value.beats.map((b) => b.keepId));
          const missing = [...fixedIds].filter((id) => !got.has(id));
          if (missing.length > 0) v.errors.push(`局部重新生成必须逐一对应现有节拍，缺少 keepId：${missing.slice(0, 6).join(', ')}`);
        }
        return v;
      },
    });
    // a cut-off answer is retried once with room for twice as much (the span is split instead when it is long enough)
    const { value, info } = await step(tokens).catch((e) => {
      if (e instanceof LlmError && e.kind === 'truncated' && (!structure || paras.length < 4) && tokens < cap) return step(Math.min(cap, tokens * 2));
      throw e;
    });
    runs.push(info);
    return value;
  };

  const prev0 = endSummary(project, index);
  let direction: SceneDirection | null = null;
  const tail = () => ({ title: scene.title, endSummary: `同一场景的前半部分，最后一句：${[...(direction?.beats.at(-1)?.text ?? '')].slice(0, 40).join('')}` });
  const fixedIn = (part: Paragraph[]) => fixed.filter((b) => paraOfBeat(b) >= part[0]!.index && paraOfBeat(b) <= part.at(-1)!.index);
  const label = (part: Paragraph[], extra = '') => `${scene.title} · 段落 ${part[0]!.index}–${part.at(-1)!.index}${extra}`;
  const callPart = async (part: Paragraph[], depth: number, only?: Beat[]): Promise<void> => {
    try {
      const dir = await direct(part, direction ? tail() : prev0, only ?? fixedIn(part), label(part));
      direction = direction ? combine(direction, dir) : dir;
    } catch (e) {
      if (!(e instanceof LlmError && e.kind === 'truncated')) throw e;
      if (!structure) {
        // focus mode: fall back to a smaller range, half of the chosen lines at a time (each with its own context)
        const group = only ?? fixedIn(part);
        if (group.length < 2) throw new LlmError('truncated', '输出过长被截断：请缩小范围（少选几句）或重试');
        const mid = Math.ceil(group.length / 2);
        for (const half of [group.slice(0, mid), group.slice(mid)]) await callPart(contextOf(half), depth + 1, half);
        return;
      }
      // truncated output: split the span in two and direct the halves one after the other
      if (depth < 3 && part.length >= 2) {
        const mid = Math.ceil(part.length / 2);
        await callPart(part.slice(0, mid), depth + 1);
        await callPart(part.slice(mid), depth + 1);
      } else throw new LlmError('truncated', '输出过长被截断：请缩小范围或重试');
    }
  };
  /** Focus mode: only the paragraphs of the chosen lines, plus one paragraph before and after, go to the model. */
  const contextOf = (bs: Beat[]): Paragraph[] => {
    const want = new Set<number>();
    for (const b of bs) for (const k of [-1, 0, 1]) want.add(paraOfBeat(b) + k);
    return inScene.filter((p) => want.has(p.index));
  };
  if (structure) {
    // long scenes are directed in consecutive spans that each fit the provider's output limit
    const spanCount = Math.ceil(inScene.length / perCall);
    const size = Math.ceil(inScene.length / spanCount);
    for (let i = 0; i < spanCount; i++) await callPart(inScene.slice(i * size, (i + 1) * size), 0);
  } else {
    const perGroup = Math.max(1, Math.floor((cap - 1500) / 700));
    for (let i = 0; i < fixed.length; i += perGroup) {
      const group = fixed.slice(i, i + perGroup);
      await callPart(contextOf(group), 0, group);
    }
  }
  if (!direction) throw new DirectorError('repair_failed', '没有得到导演结果');
  const dir: SceneDirection = direction;

  const playMotionOf = (castId: string): string | null => {
    const m = L.models.get(scene.wardrobe[castId]?.modelId ?? '');
    if (!m || m.mode !== 'live') return null;
    return [...new Set(m.motions.map((x) => x.family))].filter((f) => f.startsWith('play')).sort()[0] ?? null;
  };
  const { scene: fresh, warnings: expandWarnings } = expandScene({ base: scene, direction: dir, paragraphs, genId, now, playMotionOf, decisions: isModelAi(d.provider) ? 'ai' : 'rule' });
  const merged = mergeLocks(scene, fresh, { scopes: req.scopes, beatIds: req.beatIds, overwriteUser: overwrite });
  const warnings = [...runs.flatMap((r) => r.warnings), ...expandWarnings, ...merged.conflicts.map((c) => `锁定冲突：${c.label}`)];
  return { sceneId: scene.id, scene: merged.scene, applied: merged.applied, conflicts: merged.conflicts, report: merged.report, direction: dir, warnings, runs };
}

export interface BatchProgress {
  sceneId: string;
  title: string;
  state: 'start' | 'done' | 'error';
  message?: string;
  cached?: boolean;
  /** Sent with `done`, so a client that cancels midway still has every finished scene. */
  result?: SceneResult;
}
export interface BatchItem {
  sceneId: string;
  result?: SceneResult;
  error?: { kind: string; message: string };
}

/** Pass 2 for several scenes, `concurrency` at a time. A failing scene does not stop the others. */
export async function runScenes(
  d: DirectorDeps, project: Project, sceneIds: string[], scopes: ScopeName[], genId: string, concurrency: number,
  onProgress: (p: BatchProgress) => void = () => {}, overwriteUser = false,
): Promise<BatchItem[]> {
  const out: BatchItem[] = sceneIds.map((sceneId) => ({ sceneId }));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= sceneIds.length || d.signal?.aborted) return;
      const sceneId = sceneIds[i]!;
      const title = project.scenes.find((s) => s.id === sceneId)?.title ?? sceneId;
      onProgress({ sceneId, title, state: 'start' });
      try {
        const result = await runScene(d, { project, sceneId, scopes, overwriteUser }, genId);
        out[i] = { sceneId, result };
        onProgress({ sceneId, title, state: 'done', cached: result.runs.every((r) => r.cached), result });
      } catch (e) {
        const kind = e instanceof LlmError ? e.kind : e instanceof DirectorError ? e.kind : 'server';
        out[i] = { sceneId, error: { kind, message: (e as Error).message } };
        onProgress({ sceneId, title, state: 'error', message: (e as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, sceneIds.length)) }, worker));
  return out;
}
