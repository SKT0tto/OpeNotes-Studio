/**
 * Player: owns the logical clock and drives the Stage from the pure pipeline compile -> evaluate(t).
 * play / pause / seek / rate; scene entry (preload, transition snapshot); manual or automatic line advance;
 * BGM / SE; physics settle after seeks.
 */
import type { Project } from '@shared/schema/project';
import { compileProject } from '@shared/timeline/compile';
import { evaluate } from '@shared/timeline/evaluate';
import type { CompiledBeat, CompiledProject, RenderState } from '@shared/timeline/types';
import type { Ticker } from 'pixi.js';
import type { AudioEngine } from './AudioEngine';
import type { ModelLibrary } from './ModelLibrary';
import { stageSceneOf, type Stage } from './Stage';
import type { Calibration } from '@shared/schema/calibration';
import type { Pt } from '@shared/staging/world';

/** Scenes closer than this to their end start preloading the next scene. */
const PREFETCH_SECONDS = 5;
/** Physics catch-up after a seek / scene entry. */
const SETTLE_SECONDS = 0.5;

export interface PlayerListener {
  (state: RenderState, player: Player): void;
}

/** Model ids and background ids a project can ever show (for preloading and calibration). */
export function projectResources(project: Project): { models: string[]; backgrounds: string[] } {
  const models = new Set<string>();
  const backgrounds = new Set<string>();
  for (const s of project.scenes) {
    backgrounds.add(s.background.assetId);
    Object.values(s.wardrobe).forEach((w) => models.add(w.modelId));
    for (const tr of s.tracks) if (tr.channel === 'costume') tr.keys.forEach((k) => models.add(k.value.modelId));
  }
  return { models: [...models], backgrounds: [...backgrounds] };
}

export class Player {
  compiled: CompiledProject;
  project: Project;
  t = 0;
  rate = 1;
  /** Automatic line advance. When off, playback holds at the end of every text line until `advance()`. */
  auto = true;
  /** True while a scene is loading or a seek is being prepared: the clock is paused. */
  busy = false;
  private playing = false;
  private waiting = false;
  private sceneIdx = -1;
  private dirty = true;
  private pendingSeek: number | null = null;
  /** The next scene entry is a re-entry after an edit (everything is already loaded): keep showing the last frame, never a black one. */
  private keepVisible = false;
  private prefetched = new Set<number>();
  private lastState: RenderState | null = null;
  private readonly listeners = new Set<PlayerListener>();
  private readonly tickFn: (t: Ticker) => void;
  private bgmKey = '';
  /** Audio stays untouched until the first user-initiated play (browser autoplay policy). */
  private audioOn = false;

  private constructor(
    private readonly stage: Stage,
    private readonly library: ModelLibrary,
    private readonly audio: AudioEngine,
    project: Project,
    compiled: CompiledProject,
  ) {
    this.project = project;
    this.compiled = compiled;
    this.tickFn = (tk) => this.tick(tk.deltaMS / 1000);
    stage.app.ticker.add(this.tickFn);
  }

  static async create(stage: Stage, library: ModelLibrary, audio: AudioEngine, project: Project): Promise<Player> {
    const res = projectResources(project);
    const ctx = { ...(await library.compileContext(res.models, res.backgrounds)), aspect: stage.aspect };
    const player = new Player(stage, library, audio, project, compileProject(project, ctx));
    await player.seek(0);
    return player;
  }

  /**
   * Swap in an edited project: recompile and redraw the current time. Returns false when nothing visible changed
   * (e.g. only the title). Throws, leaving the old project in place, when the new project cannot be compiled.
   */
  async reload(project: Project): Promise<boolean> {
    const res = projectResources(project);
    const ctx = { ...(await this.library.compileContext(res.models, res.backgrounds)), aspect: this.stage.aspect };
    const compiled = compileProject(project, ctx);
    this.project = project;
    if (JSON.stringify(compiled) === JSON.stringify(this.compiled)) return false;
    this.compiled = compiled;
    this.prefetched.clear();
    // Re-enter the scene only when what must be loaded changed (background, models, motions); other edits just redraw.
    const now = compiled.scenes[this.sceneIdx];
    if (!now || JSON.stringify(stageSceneOf(now)) !== JSON.stringify(this.stage.sceneInfo)) {
      if (now && this.sceneIdx >= 0) {
        // New costume / background / motions: load them while the previous frame stays on screen, then swap without hiding the scene.
        await this.stage.prepare(stageSceneOf(now));
        this.keepVisible = true;
      }
      this.sceneIdx = -1;
    }
    await this.seek(Math.min(this.t, compiled.duration));
    return true;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get duration(): number {
    return this.compiled.duration;
  }

  get state(): RenderState | null {
    return this.lastState;
  }

  subscribe(fn: PlayerListener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  async play(): Promise<void> {
    if (this.t >= this.duration) await this.seek(0);
    this.playing = true;
    this.waiting = false;
    this.audioOn = true;
    await this.audio.resume().catch(() => undefined);
    if (this.lastState) void this.syncAudio(this.lastState);
  }

  pause(): void {
    this.playing = false;
    void this.audio.suspend().catch(() => undefined);
  }

  /** Jump anywhere: the frame is exactly evaluate(t) with models / motions / physics prepared first. */
  async seek(t: number): Promise<void> {
    this.t = Math.min(this.duration, Math.max(0, t));
    this.waiting = false;
    if (this.busy) {
      this.pendingSeek = this.t;
      return;
    }
    this.busy = true;
    try {
      let target: number | null = this.t;
      while (target !== null) {
        this.pendingSeek = null;
        this.t = target;
        await this.show(false);
        target = this.pendingSeek;
      }
    } finally {
      this.busy = false;
    }
  }

  /** Click / space: finish the typewriter, or move on to the next line. */
  advance(): void {
    const s = this.lastState;
    if (!s) return;
    const beat = this.currentBeat();
    if (s.subtitle && s.subtitle.visibleChars < s.subtitle.totalChars && beat) {
      void this.seek(beat.textEnd + 1e-3);
      return;
    }
    if (this.waiting && beat) {
      void this.seek(beat.end + 1e-3); // seek clears the hold
      return;
    }
    const next = this.compiled.scenes[s.sceneIndex]!.beats.find((b) => b.start > this.t + 1e-6);
    if (next) void this.seek(next.start);
  }

  private currentBeat(): CompiledBeat | null {
    const scene = this.compiled.scenes[this.sceneIdx];
    return scene?.beats.find((b) => this.t >= b.start && this.t < b.end) ?? null;
  }

  private tick(dt: number): void {
    if (this.busy) return;
    if (this.playing && !this.waiting) {
      const prev = this.t;
      let next = prev + dt * this.rate;
      if (!this.auto) {
        const b = this.currentBeat();
        if (b && b.kind !== 'pause' && b.text && next >= b.end) {
          next = b.end - 1e-3;
          this.waiting = true;
        }
      }
      if (next >= this.duration) {
        next = this.duration;
        this.playing = false;
      }
      for (const e of this.compiled.se) if (e.at > prev && e.at <= next) void this.playSe(e.assetId, e.volume);
      this.t = next;
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const state = evaluate(this.compiled, this.t);
    if (state.sceneIndex !== this.sceneIdx) {
      this.busy = true;
      this.show(this.playing && state.sceneIndex === this.sceneIdx + 1)
        .catch((e) => console.error(e))
        .finally(() => (this.busy = false));
      return;
    }
    this.render(state);
    this.prefetch(state);
  }

  /** Enter the scene at `this.t` if needed and draw the frame. `snapshot`: freeze the old scene for a transition. */
  private async show(snapshot: boolean): Promise<void> {
    let state = evaluate(this.compiled, this.t);
    // Landing inside a scene's transition lead-in by a jump: the outgoing picture is rebuilt first so the transition has something to run over.
    if (!snapshot && state.transition && state.sceneIndex > 0 && !this.stage.transitionActive) await this.rebuildOutgoing(state.sceneIndex);
    const changed = state.sceneIndex !== this.sceneIdx;
    if (changed) {
      const scene = this.compiled.scenes[state.sceneIndex]!;
      if (snapshot && scene.transitionIn.kind !== 'cut' && this.sceneIdx >= 0) this.stage.captureSnapshot();
      if (!this.keepVisible) this.stage.setSceneVisible(false);
      this.keepVisible = false;
      await this.stage.setScene(stageSceneOf(scene));
      this.sceneIdx = state.sceneIndex;
    }
    state = evaluate(this.compiled, this.t);
    const settle = changed || !this.playing;
    this.stage.resync(settle ? SETTLE_SECONDS : 0);
    this.render(state);
    if (settle) {
      await this.stage.whenSettled();
      this.stage.settle(SETTLE_SECONDS);
      this.stage.setSceneVisible(true);
    }
    this.prefetch(state);
  }

  /** Show scene `i-1` just before scene `i` starts and freeze it (the transition snapshot of a sequential play-through). */
  private async rebuildOutgoing(i: number): Promise<void> {
    const prev = this.compiled.scenes[i - 1]!;
    const at = Math.max(prev.start, this.compiled.scenes[i]!.start - 1e-3);
    if (this.sceneIdx !== i - 1) {
      this.stage.setSceneVisible(false);
      await this.stage.setScene(stageSceneOf(prev));
      this.sceneIdx = i - 1;
    }
    const old = evaluate(this.compiled, at);
    this.stage.resync(SETTLE_SECONDS);
    this.render(old);
    await this.stage.whenSettled();
    this.stage.settle(SETTLE_SECONDS);
    this.stage.setSceneVisible(true);
    this.stage.captureSnapshot();
  }

  // ---- editor support: geometry for the direct-manipulation handles, frame grabs for thumbnails -----------
  /** Head / body boxes of the visible people in stage pixels. */
  geometry() {
    return this.stage.actorGeometry();
  }
  stageToWorld(p: Pt): Pt | null {
    return this.stage.stageToWorld(p);
  }
  stageBgGetter() {
    return this.stage.sceneInfo?.bg ?? null;
  }
  calibration(modelId: string): Calibration | null {
    try {
      return this.library.calibrationSync(modelId);
    } catch {
      return null;
    }
  }
  /** Seek to `t`, then copy the finished frame into a `w` x `h` canvas. */
  async grab(t: number, w: number, h: number): Promise<HTMLCanvasElement> {
    await this.seek(t);
    this.stage.app.render();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(this.stage.app.canvas as HTMLCanvasElement, 0, 0, w, h);
    return canvas;
  }

  private render(state: RenderState): void {
    this.stage.apply(state);
    this.lastState = state;
    if (this.audioOn) void this.syncAudio(state);
    for (const fn of this.listeners) fn(state, this);
  }

  private prefetch(state: RenderState): void {
    const next = state.sceneIndex + 1;
    const scene = this.compiled.scenes[state.sceneIndex]!;
    if (next >= this.compiled.scenes.length || this.prefetched.has(next) || scene.end - this.t > PREFETCH_SECONDS) return;
    this.prefetched.add(next);
    this.stage.prepare(stageSceneOf(this.compiled.scenes[next]!)).catch((e) => {
      this.prefetched.delete(next);
      console.error(e);
    });
  }

  private async audioUrl(assetId: string): Promise<string | null> {
    return (await this.library.catalog()).audio.find((a) => a.id === assetId)?.url ?? null;
  }

  private async syncAudio(state: RenderState): Promise<void> {
    const want = state.audio.bgm;
    const key = want ? `${want.assetId}@${want.volume}` : '';
    if (key === this.bgmKey) return;
    this.bgmKey = key;
    try {
      const url = want ? await this.audioUrl(want.assetId) : null;
      if (want && !url) console.warn(`BGM asset "${want.assetId}" is not in the audio library`);
      await this.audio.setBgm(want?.assetId ?? null, url, want?.volume ?? 0);
    } catch (e) {
      console.warn('bgm failed', e);
    }
  }

  private async playSe(assetId: string, volume: number): Promise<void> {
    const url = await this.audioUrl(assetId);
    if (url) await this.audio.playSe(url, volume).catch((e) => console.warn('se failed', e));
  }

  dispose(): void {
    this.stage.app.ticker.remove(this.tickFn);
    this.listeners.clear();
  }
}
