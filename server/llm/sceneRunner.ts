/** Pass 2: one model call per scene (two for a very long one), validation / repair, expansion, merge with the locks. */
import { actorResources } from '../../shared/director/catalogDigest';
import { expandScene } from '../../shared/director/expand';
import { mergeLocks, type MergeConflict, type MergeReport } from '../../shared/director/mergeLocks';
import type { Paragraph } from '../../shared/director/paragraphs';
import { splitParagraphs } from '../../shared/director/paragraphs';
import { stageSummary } from '../../shared/director/stage';
import { lookup } from '../../shared/director/resources';
import { autoSelectable, bgCategoryOf } from '../../shared/director/bgCategory';
import type { ScopeName } from '../../shared/director/scope';
import { downgradeChunkEnd } from '../../shared/director/intentNormalize';
import { validateDirection } from '../../shared/director/validate';
import type { SceneDirection } from '../../shared/schema/ai';
import { cameraSystemOf, type Beat, type Project, type Scene } from '../../shared/schema/project';
import type { DirectorDeps } from './director';
import { DirectorError, runStep, type RunInfo } from './pipeline';
import { LlmError, isModelAi } from './provider';
import { scenePromptFor, sceneInput, type SceneDirectionInput } from './prompts/sceneDirection';

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
/**
 * Output tokens per paragraph of source text, the first guess before any call has been measured (a real run of a reasoning model
 * measured a median of ~360 tokens per paragraph, p90 ~570). After every real call the estimate follows what the provider reported.
 */
export const TOKENS_PER_PARA = 450;
const MIN_TOKENS_PER_PARA = 250;
const MAX_TOKENS_PER_PARA = 900;
/** Measured tokens per paragraph get this much head room before they size the next span. */
const MEASURED_HEADROOM = 1.3;

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
  const cameraSystem = cameraSystemOf(project, scene);
  const sys = scenePromptFor(cameraSystem);
  const L = lookup(d.catalog);
  const now = (d.now ?? Date.now)();

  const cast = Object.keys(scene.wardrobe).map((castId) => {
    const m = project.cast.find((c) => c.id === castId);
    const a = m ? actorResources(d.catalog, castId, m.characterKey, scene.wardrobe[castId]!.modelId) : null;
    if (!a) throw new LlmError('bad_request', `角色 ${castId} 的服装不在素材库中`);
    return a;
  });
  const bg = L.backgrounds.get(scene.background.assetId);
  // P20: the backgrounds this scene may switch between: the start, Pass 1's moves, and the cut-away candidates (never in a performance)
  const titleOf = (id: string) => L.backgrounds.get(id)?.name ?? id;
  const moves = (scene.brief?.moves ?? []).filter((m) => L.backgrounds.has(m.backgroundId));
  const insertBgs = scene.brief?.isPerformance ? [] : d.catalog.backgrounds.filter((b) => bgCategoryOf(b) === 'insert' && autoSelectable(b, 'insert')).sort((a, c) => (a.id < c.id ? -1 : 1));
  const bgSet = {
    start: { id: scene.background.assetId, title: titleOf(scene.background.assetId) },
    moves: moves.map((m) => ({ paragraph: m.paragraph, id: m.backgroundId, title: titleOf(m.backgroundId) })),
    inserts: insertBgs.map((b) => ({ id: b.id, title: b.name })),
  };
  const bgAllowed = new Set([bgSet.start.id, ...bgSet.moves.map((m) => m.id), ...bgSet.inserts.map((b) => b.id)]);
  const structure = req.scopes.includes('scene') && !req.beatIds;
  const fixed: Beat[] = structure ? scene.beats.filter((b) => protectedBeat(b, overwrite)) : req.beatIds ? scene.beats.filter((b) => req.beatIds!.includes(b.id)) : scene.beats;
  const paraOfBeat = (b: Beat): number => paragraphs.find((p) => b.sourceOffset !== undefined && b.sourceOffset >= p.start && b.sourceOffset <= p.end)?.index ?? inScene[0]!.index;
  const fixedInput = (b: Beat): SceneDirectionInput['fixedBeats'][number] => ({
    keepId: b.id, paragraph: paraOfBeat(b), kind: b.kind, speaker: b.speakerId ?? null, text: b.text, ...(b.meta.lockedFields ? { lockedFields: b.meta.lockedFields } : {}),
  });

  const cap = d.provider.maxOutputTokens ?? 16000;
  const perCallAt = (perPara: number) => Math.max(4, Math.min(MAX_PARAS_PER_CALL, Math.floor((cap - 1500) / perPara)));
  const runs: RunInfo[] = [];
  const chunkWarnings: string[] = [];
  /** Output tokens per paragraph: starts at the default, then follows the provider's own usage numbers. */
  let tpp = TOKENS_PER_PARA;
  const direct = async (paras: Paragraph[], prev: SceneDirectionInput['previousScene'], fixedHere: Beat[], label: string, continuation?: SceneDirectionInput['continuation']): Promise<SceneDirection> => {
    const lastPara = inScene.at(-1)!.index;
    const more = paras.at(-1)!.index < lastPara;
    const nextPara = inScene.find((p) => p.index > paras.at(-1)!.index)?.index ?? lastPara;
    const input: SceneDirectionInput = {
      scene: {
        title: scene.title, mood: scene.brief?.mood ?? '', timeOfDay: scene.brief?.timeOfDay ?? '',
        location: bg ? `${bg.name}${bg.location ? `（${bg.location}）` : ''}` : scene.background.assetId,
        isPerformance: !!scene.brief?.isPerformance, band: scene.brief?.band ?? null, paragraphRange: [paras[0]!.index, paras.at(-1)!.index], backgrounds: bgSet,
      },
      cast,
      paragraphs: paras.map((p) => ({ i: p.index, text: p.text })),
      previousScene: prev,
      ...(continuation ? { continuation } : {}),
      ...(structure && more ? { sceneContinues: { note: `注意：这一段不是整个场景的结尾，场景在第 ${nextPara} 段之后还会继续（后面还有对白和事件）。所以这一段的最后一拍不要给场尾收束：不要用 release、拉远成群像、pull_out 或黑场式的收尾，镜头和节奏保持「场景正在进行」的状态；真正的场尾由最后一段处理。`, nextParagraph: nextPara } } : {}),
      fixedBeats: fixedHere.map(fixedInput),
      mode: { scopes: req.scopes, ...(req.beatIds ? { focusBeatIds: fixedHere.map((b) => b.id) } : {}) },
    };
    const range = { start: paras[0]!.index, end: paras.at(-1)!.index };
    const fixedIds = new Set(fixedHere.map((b) => b.id));
    const tokens = Math.min(cap, structure ? 1500 + tpp * paras.length : Math.max(4000, 1500 + 700 * Math.max(1, fixedHere.length)));
    const step = (maxTokens: number) => runStep({
      provider: d.provider, cache: d.cache, promptVersion: sys.promptVersion, pass: 'scene', label, refresh: d.refresh === true,
      req: { system: sys.system, input: sceneInput(input), schema: sys.schema, schemaName: sys.schemaName, maxTokens, signal: d.signal },
      validate: (dir) => {
        const v = validateDirection(dir, {
          catalog: d.catalog, cast: cast.map((c) => ({ castId: c.castId, characterKey: c.characterKey, modelId: c.modelId })), paragraphs, range,
          isPerformance: !!scene.brief?.isPerformance, fixedBeatIds: fixedIds, cameraSystem,
          ...(direction ? { awayAtStart: new Set(stageSummary(direction.beats, cast.map((c) => c.castId)).exited) } : {}),
          backgrounds: {
            start: scene.background.assetId, allowed: bgAllowed,
            scope: { title: scene.title, reason: '', mood: scene.brief?.mood ?? '', timeOfDay: scene.brief?.timeOfDay ?? '', isPerformance: !!scene.brief?.isPerformance, presentCast: cast.map((c) => c.characterKey), guestOf: scene.brief?.guestOf ?? null },
          },
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
    // travel: the last beat of a span that is not the scene's last must not close the scene (the model is told so; this is the guard)
    let result = value;
    if (structure && more && cameraSystem === 'travel' && value.beats.length > 0) {
      result = structuredClone(value);
      chunkWarnings.push(...downgradeChunkEnd(result.beats, { prev: direction?.beats.at(-1), skip: (b) => !!b.keepId && fixedIds.has(b.keepId), where: (i) => `${label} 第 ${i + 1} 句` }));
    }
    // measure: what this span really cost per paragraph steers the size of the following spans
    // (a cache hit carries the usage of the call that produced it, so a cached re-run plans exactly the same spans and hits again)
    if (structure && info.usage.outputTokens > 0) {
      const seen = (info.usage.outputTokens / paras.length) * MEASURED_HEADROOM;
      tpp = Math.min(MAX_TOKENS_PER_PARA, Math.max(MIN_TOKENS_PER_PARA, Math.round((tpp + seen) / 2)));
    }
    return result;
  };

  const prev0 = endSummary(project, index);
  let direction: SceneDirection | null = null;
  const tail = () => ({ title: scene.title, endSummary: `同一场景的前半部分，最后一句：${[...(direction?.beats.at(-1)?.text ?? '')].slice(0, 40).join('')}` });
  /** What the next span of a long scene needs to know about the spans before it: the last paragraphs, the last beats, who is on stage. */
  const carry = (part: Paragraph[]): SceneDirectionInput['continuation'] | undefined => {
    if (!direction || direction.beats.length === 0) return undefined;
    const castIds = cast.map((c) => c.castId);
    const st = stageSummary(direction.beats, castIds);
    const shown = (c: string) => `${c}（${project.cast.find((x) => x.id === c)?.displayName ?? c}）`;
    return {
      note: '这是同一场景接着往下导的一段：前文已经导完。contextParagraphs 是紧挨着的前文原文，只读，不要为它们输出节拍；previousBeats 是前文最后几拍，对白没有署名时请结合它判断是谁在说话；onStage 是此刻在台上的人，notYetSeen 是前文还没出现过的人（他们若在后文出现，请在那一拍给 enter=true），exited 是已离场的人。',
      contextParagraphs: inScene.filter((p) => p.index < part[0]!.index).slice(-2).map((p) => ({ i: p.index, text: p.text })),
      previousBeats: direction.beats.slice(-3).map((b) => ({ kind: b.kind, speaker: b.speaker, text: [...b.text].slice(0, 60).join('') })),
      onStage: st.onStage.map(shown),
      notYetSeen: st.notYetSeen.map(shown),
      exited: st.exited.map(shown),
    };
  };
  const fixedIn = (part: Paragraph[]) => fixed.filter((b) => paraOfBeat(b) >= part[0]!.index && paraOfBeat(b) <= part.at(-1)!.index);
  const label = (part: Paragraph[], extra = '') => `${scene.title} · 段落 ${part[0]!.index}–${part.at(-1)!.index}${extra}`;
  const callPart = async (part: Paragraph[], depth: number, only?: Beat[]): Promise<void> => {
    try {
      const dir = await direct(part, direction ? tail() : prev0, only ?? fixedIn(part), label(part), structure ? carry(part) : undefined);
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
      // truncated output: the estimate was too low, so the spans after this one get smaller too
      tpp = Math.min(MAX_TOKENS_PER_PARA, Math.round(tpp * 1.4));
      // split the span in two and direct the halves one after the other
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
    // (spans are sized by the measured cost per paragraph; the plan is redone when the measurement moves the estimate)
    let rest = inScene;
    let planned = tpp;
    const planSize = (n: number) => Math.ceil(n / Math.ceil(n / perCallAt(planned)));
    let size = planSize(rest.length);
    while (rest.length > 0) {
      if (Math.abs(tpp - planned) / planned > 0.15) {
        planned = tpp;
        size = planSize(rest.length);
      }
      await callPart(rest.slice(0, size), 0);
      rest = rest.slice(size);
    }
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
  const { scene: fresh, warnings: expandWarnings } = expandScene({ base: scene, direction: dir, paragraphs, genId, now, playMotionOf, isInsertBg: (id) => { const b = L.backgrounds.get(id); return !!b && bgCategoryOf(b) === 'insert'; }, decisions: isModelAi(d.provider) ? 'ai' : 'rule' });
  const merged = mergeLocks(scene, fresh, { scopes: req.scopes, beatIds: req.beatIds, overwriteUser: overwrite });
  const warnings = [...runs.flatMap((r) => r.warnings), ...chunkWarnings, ...expandWarnings, ...merged.conflicts.map((c) => `锁定冲突：${c.label}`)];
  return { sceneId: scene.id, scene: merged.scene, applied: merged.applied, conflicts: merged.conflicts, report: merged.report, direction: dir, warnings, runs };
}

export interface BatchProgress {
  sceneId: string;
  title: string;
  state: 'start' | 'done' | 'error';
  message?: string;
  /** With `error`: the failure class (auth, network, timeout, ...), so the UI can say what to fix. */
  kind?: string;
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
        onProgress({ sceneId, title, state: 'error', message: (e as Error).message, kind });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, sceneIds.length)) }, worker));
  return out;
}
