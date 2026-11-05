/**
 * The voice-over job: translate the voiced lines into Japanese, then synthesise them one after the other (a GPU server: never in parallel)
 * and keep the wav files (via `ctx.voice`) in `data/projects/<id>/voice/<beatId>-<hash8>.wav`. The server does not write project.json: the finished job hands the
 * editor one `voice` object per beat, which it applies as a single undo step (see `VoiceJobView.results`).
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { MAX_TAKES, judgeTake, type Verdict } from './check';
import type { PluginServerContext } from '../../../shared/plugins/api';
import type { Beat, Project } from '../../../shared/schema/project';
import { effectiveProfile, hasVoice, leakMessage, weightsLeak, type VoiceBeatResult, type VoiceJobView, type VoiceProfile, type VoiceScope, type VoiceSettings } from './schema';
import { hasWords, profileOfBeat, spokenText } from './lines';
import { wavSeconds } from '../../../shared/voice/wav';
import type { VoiceJaLine } from './prompt';
import { SovitsError, setWeights, tts } from './sovits';
import type { VoiceSettingsStore } from './store';
import { fixNames } from './names';
import { translateLines } from './translate';

export class VoiceError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

/** What an audio file is made from: the Japanese text, the voice profile and the text language. */
export function voiceHash(ja: string, profile: VoiceProfile, textLang: string): string {
  return createHash('sha256').update(JSON.stringify([ja, profile.gptWeights ?? '', profile.sovitsWeights ?? '', profile.refAudioPath ?? '', profile.promptText, profile.promptLang, profile.speed, textLang])).digest('hex');
}
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');
/**
 * `<beatId>-<hash8>-<seed>.wav`: every take made now carries its seed, so no take ever overwrites another (the browser caches decoded audio by
 * file name, and undo must find the old audio untouched). `<beatId>-<hash8>.wav` (no seed) is the old format; it is still read.
 */
export const voiceFileName = (beatId: string, hash: string, seed?: number) => `${safeId(beatId)}-${hash.slice(0, 8)}${seed === undefined ? '' : `-${seed}`}.wav`;
export const VOICE_FILE = /^[A-Za-z0-9_-]+-[0-9a-f]{8}(-\d+)?\.wav$/;
/** Versions (audio files) kept per line: a regeneration must not delete the previous version, so that undo can restore it. */
export const KEEP_VERSIONS = 5;

export const PLUGIN_ID = 'gpt-sovits';

export interface VoiceServiceDeps {
  settings: VoiceSettingsStore;
  voice: PluginServerContext['voice'];
  llm: PluginServerContext['llm'];
}

interface Target {
  sceneId: string;
  beat: Beat;
  characterKey: string;
  displayName: string;
  profile: VoiceProfile & { refAudioPath: string };
}

interface Job {
  id: string;
  ctl: AbortController;
  state: VoiceJobView['state'];
  message: string;
  total: number;
  done: number;
  errors: Array<{ beatId: string; message: string }>;
  warnings: Array<{ beatId: string; message: string }>;
  completed: number;
  retries: number;
  results: Map<string, VoiceBeatResult>;
  error?: string;
  endedAt?: number;
}

export interface StartOptions {
  /** Translate again even where a translation exists (never over a line a person edited). */
  retranslate?: boolean | undefined;
  /** Synthesise again even where a matching file exists. */
  force?: boolean | undefined;
  /** One line only: always synthesise a NEW version with a random, stored seed (the previous version stays on disk). */
  regenerate?: boolean | undefined;
  /** Retranslate even a line a person edited (the person confirmed). */
  overwriteEdited?: boolean | undefined;
}

export class VoiceService {
  private readonly jobs = new Map<string, Job>();
  /** What the GPT-SoVITS server has loaded, by address (only what this service set; forgotten on any failure). */
  private readonly loaded = new Map<string, { gpt?: string; sovits?: string }>();

  constructor(private readonly deps: VoiceServiceDeps) {}

  private running(): Job | undefined {
    return [...this.jobs.values()].find((j) => j.state === 'running');
  }

  view(id: string): VoiceJobView | null {
    const j = this.jobs.get(id);
    if (!j) return null;
    return { id: j.id, state: j.state, message: j.message, total: j.total, done: j.done, errors: j.errors, warnings: j.warnings, completed: j.completed, retries: j.retries, results: [...j.results.values()], ...(j.error ? { error: j.error } : {}) };
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state !== 'running') return false;
    j.ctl.abort();
    return true;
  }

  /** Targets of a scope: spoken lines of voiced characters. Throws VoiceError for a scope that names nothing. */
  targets(project: Project, scope: VoiceScope, settings: VoiceSettings): Target[] {
    const out: Target[] = [];
    const scenes = scope.kind === 'project' ? project.scenes : project.scenes.filter((s) => s.id === scope.sceneId);
    if (scope.kind !== 'project' && scenes.length === 0) throw new VoiceError(404, `场景不存在：${scope.sceneId}`);
    for (const scene of scenes) {
      for (const beat of scene.beats) {
        if (scope.kind === 'beat' && beat.id !== scope.beatId) continue;
        const p = profileOfBeat(project, beat, settings.profiles);
        if (!p) continue;
        if (!hasWords(spokenText(beat.text, [p.displayName]))) continue;
        out.push({ sceneId: scene.id, beat, characterKey: p.characterKey, displayName: p.displayName, profile: p.profile });
      }
    }
    if (scope.kind === 'beat' && out.length === 0) throw new VoiceError(400, '这一句不配音：只有对白（不含旁白、动作、停顿），并且说话的角色已设置参考音频');
    return out;
  }

  start(project: Project, scope: VoiceScope, opts: StartOptions = {}): string {
    const settings = this.deps.settings.read();
    if (!settings.enabled) throw new VoiceError(400, '配音插件还没有启用（在「配音」设置里打开）');
    if (this.running()) throw new VoiceError(409, '已有配音任务在运行，请等它结束或先取消');
    if (opts.regenerate && scope.kind !== 'beat') throw new VoiceError(400, '重新合成单句版本只能用于单独一句');
    const targets = this.targets(project, scope, settings);
    const job: Job = { id: `v_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, ctl: new AbortController(), state: 'running', message: '准备中…', total: targets.length, done: 0, errors: [], warnings: [], completed: 0, retries: 0, results: new Map() };
    this.jobs.set(job.id, job);
    this.loaded.clear(); // the GPT-SoVITS server may have been restarted since: set each voice's weights once per job
    for (const [id, j] of this.jobs) if (j.endedAt && Date.now() - j.endedAt > 30 * 60_000) this.jobs.delete(id);
    void this.run(job, project, targets, settings, opts).catch((e: unknown) => {
      const aborted = job.ctl.signal.aborted;
      job.state = aborted ? 'cancelled' : 'failed';
      if (!aborted) job.error = (e as Error).message;
      job.message = aborted ? `已取消（已完成 ${job.completed} 句）` : `失败：${(e as Error).message}（已完成 ${job.completed} 句）`;
    }).finally(() => { job.endedAt = Date.now(); });
    return job.id;
  }

  private fail(job: Job, beatId: string, message: string): void {
    job.errors.push({ beatId, message });
    job.done++;
  }

  private async run(job: Job, project: Project, targets: Target[], settings: VoiceSettings, opts: StartOptions): Promise<void> {
    const signal = job.ctl.signal;
    if (targets.length === 0) {
      job.state = 'done';
      job.message = '没有需要配音的台词（旁白不配音；角色需要先在「配音」里设置参考音频）';
      return;
    }
    // ---- 1. Japanese text ---------------------------------------------------------------------------------
    const ja = new Map<string, { ja: string; jaEdited?: boolean }>();
    const need = new Set<string>();
    for (const t of targets) {
      const v = t.beat.voice;
      if (v?.spoken && v.spokenEdited && !opts.overwriteEdited) ja.set(t.beat.id, { ja: v.spoken, jaEdited: true });
      else if (v?.spoken && !opts.retranslate && v.src === t.beat.text) ja.set(t.beat.id, { ja: fixNames(v.spoken, project.cast.map((c) => c.characterKey)) }); // an old cached translation gets the name repair too
      else need.add(t.beat.id);
    }
    if (need.size > 0) {
      const p = this.deps.llm.available();
      if (!p.ok) throw new VoiceError(503, `需要 AI 把台词译成日语，但${p.message}`);
      const sceneIds = [...new Set(targets.filter((t) => need.has(t.beat.id)).map((t) => t.sceneId))];
      let n = 0;
      for (const scene of project.scenes) {
        const ids = new Set(targets.filter((t) => t.sceneId === scene.id && need.has(t.beat.id)).map((t) => t.beat.id));
        if (ids.size === 0) continue;
        n++;
        job.message = `翻译成日语：${scene.title || scene.id}（${n}/${sceneIds.length}）`;
        const lines: VoiceJaLine[] = [];
        for (const b of scene.beats) {
          if (b.kind !== 'dialogue' && b.kind !== 'narration' && b.kind !== 'action') continue;
          const member = project.cast.find((c) => c.id === b.speakerId);
          const text = b.kind === 'dialogue' ? spokenText(b.text, member ? [member.displayName] : []) : b.text.trim();
          if (!text) continue;
          lines.push({ id: b.id, speaker: member?.characterKey ?? '旁白', name: member?.displayName ?? '旁白', emotion: b.emotion ?? null, variant: b.variant, text, translate: ids.has(b.id) });
        }
        const r = await translateLines({ refresh: opts.retranslate, callJson: this.deps.llm.callJson, cast: project.cast.map((c) => ({ key: c.characterKey, name: c.displayName })), signal, scene: { title: scene.title, mood: scene.brief?.mood ?? '' }, lines });
        const keys = project.cast.map((c) => c.characterKey);
        for (const [id, text] of r.ja) ja.set(id, { ja: fixNames(text, keys) }); // hand-edited lines never pass through here
        for (const [id, why] of r.failed) this.fail(job, id, why);
        if (signal.aborted) throw new Error('aborted');
      }
    }
    // Keep the Japanese even when the sound later fails or the job is cancelled. A line that is not finished keeps the recording it already
    // had (as long as that one was made for the line's present text): only a finished take replaces audio. Unchanged lines need no result.
    for (const t of targets) {
      const j = ja.get(t.beat.id);
      if (!j) continue;
      const cur = t.beat.voice;
      if (cur && cur.src === t.beat.text && cur.spoken === j.ja && !!cur.spokenEdited === !!j.jaEdited) continue;
      const old = cur?.file && cur.src === t.beat.text && cur.seconds !== undefined
        ? { file: cur.file, seconds: cur.seconds, ...(cur.hash ? { hash: cur.hash } : {}), ...(cur.seed !== undefined ? { seed: cur.seed } : {}), ...(cur.suspect ? { suspect: true as const } : {}) }
        : {};
      job.results.set(t.beat.id, { sceneId: t.sceneId, beatId: t.beat.id, voice: { src: t.beat.text, spoken: j.ja, ...(j.jaEdited ? { spokenEdited: true } : {}), ...old, by: PLUGIN_ID } });
    }
    const sound = targets.filter((t) => ja.has(t.beat.id));

    // ---- 2. sound, character by character ------------------------------------------------------------------
    const byChar = new Map<string, Target[]>();
    for (const t of sound) byChar.set(t.characterKey, [...(byChar.get(t.characterKey) ?? []), t]);
    for (const group of byChar.values()) {
      const name = group[0]!.displayName;
      if (weightsLeak(settings, group[0]!.profile).length > 0) {
        for (const t of group) this.fail(job, t.beat.id, leakMessage(name));
        continue;
      }
      const profile = effectiveProfile(settings, group[0]!.profile) as VoiceProfile & { refAudioPath: string };
      // files that are already there need no server at all
      const pending: Array<{ t: Target; hash: string }> = [];
      for (const t of group) {
        const text = ja.get(t.beat.id)!;
        const hash = voiceHash(text.ja, profile, settings.textLang);
        if (opts.regenerate) {
          pending.push({ t, hash });
          continue;
        }
        let found: { file: string; secs: number; seed?: number | undefined; suspect?: boolean | undefined } | null = null;
        if (!opts.force) {
          // the take the line already points to (it may be a regenerated one) is the file for this text
          const cur = t.beat.voice;
          if (cur?.file && cur.hash === hash && cur.src === t.beat.text) {
            const secs = await this.existing(project.id, cur.file);
            if (secs !== null) found = { file: cur.file, secs, seed: cur.seed, suspect: cur.suspect };
          }
          if (!found) found = await this.newestTake(project.id, t.beat.id, hash);
        }
        if (found) {
          await this.prune(project.id, t.beat.id, [found.file, t.beat.voice?.file]);
          this.finish(job, t, text, found.file, found.secs, hash, found.seed, found.suspect);
        } else pending.push({ t, hash });
      }
      if (pending.length === 0) continue;
      job.message = `加载 ${name} 的声线…`;
      try {
        await this.ensureWeights(settings.endpoint, profile, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof SovitsError && (e.kind === 'unreachable' || e.kind === 'timeout')) throw e;
        for (const { t } of pending) this.fail(job, t.beat.id, (e as Error).message);
        continue;
      }
      for (const { t, hash } of pending) {
        if (signal.aborted) throw new Error('aborted');
        const text = ja.get(t.beat.id)!;
        try {
          const take = await this.bestTake(job, name, text.ja, profile, settings, signal);
          let seed = take.seed;
          while ((await this.existing(project.id, voiceFileName(t.beat.id, hash, seed))) !== null) seed = randomInt(0, 2 ** 31 - 1); // never over a take that is there
          const file = voiceFileName(t.beat.id, hash, seed);
          await this.deps.voice.write(project.id, file, take.bytes);
          await this.prune(project.id, t.beat.id, [file, t.beat.voice?.file]);
          if (take.suspect) job.warnings.push({ beatId: t.beat.id, message: `${name} 的这一句可能没读完（声音只有 ${take.verdict.span.toFixed(1)} 秒，按日语估计至少 ${(take.verdict.morae * take.verdict.threshold).toFixed(1)} 秒；已重试 ${take.takes - 1} 次）：请试听，或点「重新合成」` });
          this.finish(job, t, text, file, take.secs, hash, seed, take.suspect);
        } catch (e) {
          if (signal.aborted) throw e;
          if (e instanceof SovitsError && (e.kind === 'unreachable' || e.kind === 'timeout')) {
            this.loaded.delete(settings.endpoint);
            throw e;
          }
          this.fail(job, t.beat.id, (e as Error).message);
        }
      }
    }
    job.state = 'done';
    const failed = job.errors.length;
    const extra = `${job.retries > 0 ? `，重试 ${job.retries} 次` : ''}${job.warnings.length > 0 ? `，${job.warnings.length} 句可能没读完` : ''}`;
    job.message = failed > 0 ? `完成：${job.completed} 句成功，${failed} 句失败${extra}` : `完成：${job.completed} 句配音已生成${extra}`;
  }

  /**
   * One line, up to MAX_TAKES takes with a fresh random seed each, stopping at the first complete one (the missing-word check, see check.ts).
   * When none passes, the take with the longest sound is kept and flagged. A take that cannot be judged (very short text) counts as complete.
   */
  private async bestTake(job: Job, name: string, ja: string, profile: VoiceProfile & { refAudioPath: string }, settings: VoiceSettings, signal: AbortSignal): Promise<{ bytes: Uint8Array; secs: number; seed: number; verdict: Verdict; suspect: boolean; takes: number }> {
    let best: { bytes: Uint8Array; secs: number; seed: number; verdict: Verdict } | null = null;
    for (let take = 1; take <= MAX_TAKES; take++) {
      if (signal.aborted) throw new Error('aborted');
      job.message = `合成 ${name}：${job.done + 1}/${job.total}${take > 1 ? `（疑似漏字，重试第 ${take - 1} 次）` : ''}`;
      const seed = randomInt(0, 2 ** 31 - 1);
      const bytes = await tts(settings.endpoint, { text: ja, textLang: settings.textLang, profile, seed }, signal);
      const secs = wavSeconds(bytes);
      if (secs === null || secs <= 0) throw new SovitsError('GPT-SoVITS 返回的不是可读的 WAV 音频', 'rejected');
      const verdict = judgeTake(bytes, ja, profile.speed);
      if (!best || verdict.span > best.verdict.span) best = { bytes, secs, seed, verdict };
      if (verdict.ok !== false) return { ...best, suspect: false, takes: take };
      if (take < MAX_TAKES) job.retries++;
    }
    return { ...best!, suspect: true, takes: MAX_TAKES };
  }

  private finish(job: Job, t: Target, text: { ja: string; jaEdited?: boolean }, file: string, seconds: number, hash: string, seed?: number, suspect?: boolean): void {
    job.results.set(t.beat.id, { sceneId: t.sceneId, beatId: t.beat.id, voice: { src: t.beat.text, spoken: text.ja, ...(text.jaEdited ? { spokenEdited: true } : {}), file, seconds: Math.round(seconds * 1000) / 1000, hash, ...(seed !== undefined ? { seed } : {}), ...(suspect ? { suspect: true } : {}), by: PLUGIN_ID } });
    job.done++;
    job.completed++;
  }

  /** The newest take (seeded or old-format) of this line made from exactly this text and profile, if any. */
  private async newestTake(projectId: string, beatId: string, hash: string): Promise<{ file: string; secs: number; seed?: number } | null> {
    const re = new RegExp(`^${safeId(beatId)}-${hash.slice(0, 8)}(?:-([0-9]+))?[.]wav$`);
    const mine = (await this.deps.voice.listWithTimes(projectId)).filter((f) => re.test(f.name)).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
    for (const f of mine) {
      const secs = await this.existing(projectId, f.name);
      if (secs === null) continue;
      const seed = re.exec(f.name)?.[1];
      return { file: f.name, secs, ...(seed !== undefined ? { seed: Number(seed) } : {}) };
    }
    return null;
  }

  private async existing(projectId: string, name: string): Promise<number | null> {
    const bytes = await this.deps.voice.read(projectId, name);
    return bytes ? wavSeconds(bytes) : null;
  }

  /** Keeps the files in `keep` and the newest versions of the line up to KEEP_VERSIONS; removes the rest. */
  private async prune(projectId: string, beatId: string, keep: Array<string | undefined>): Promise<void> {
    const re = new RegExp(`^${safeId(beatId)}-[0-9a-f]{8}(-[0-9]+)?[.]wav$`); // safeId leaves only [A-Za-z0-9_-]
    const mine = (await this.deps.voice.listWithTimes(projectId)).filter((f) => re.test(f.name)).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
    const kept = new Set(keep.filter((x): x is string => !!x));
    for (const f of mine) if (kept.size < KEEP_VERSIONS) kept.add(f.name);
    for (const f of mine) if (!kept.has(f.name)) await this.deps.voice.remove(projectId, f.name);
  }

  /** Loads the character's weights, once: only when given and different from what this service loaded last. */
  async ensureWeights(endpoint: string, profile: Pick<VoiceProfile, 'gptWeights' | 'sovitsWeights'>, signal?: AbortSignal): Promise<void> {
    const cur = this.loaded.get(endpoint) ?? {};
    try {
      if (profile.gptWeights && cur.gpt !== profile.gptWeights) {
        await setWeights(endpoint, 'gpt', profile.gptWeights, signal);
        cur.gpt = profile.gptWeights;
      }
      if (profile.sovitsWeights && cur.sovits !== profile.sovitsWeights) {
        await setWeights(endpoint, 'sovits', profile.sovitsWeights, signal);
        cur.sovits = profile.sovitsWeights;
      }
      this.loaded.set(endpoint, cur);
    } catch (e) {
      this.loaded.delete(endpoint);
      throw e;
    }
  }

  /** A short test sentence in one character's voice (for the settings page). */
  async preview(characterKey: string, text: string, signal?: AbortSignal): Promise<Uint8Array> {
    const settings = this.deps.settings.read();
    const profile = settings.profiles[characterKey];
    if (!hasVoice(profile)) throw new VoiceError(400, '这个角色还没有设置参考音频');
    if (this.running()) throw new VoiceError(409, '配音任务正在运行，等它结束后再试听');
    if (weightsLeak(settings, profile).length > 0) throw new VoiceError(400, leakMessage(characterKey));
    const eff = effectiveProfile(settings, profile) as VoiceProfile & { refAudioPath: string };
    await this.ensureWeights(settings.endpoint, eff, signal);
    return tts(settings.endpoint, { text, textLang: settings.textLang, profile: eff }, signal);
  }
}
