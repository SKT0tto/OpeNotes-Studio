/** Dev-only `window.__studio` hooks so Playwright can assert exact parameter values / transforms. */
import { Rectangle, type Application } from 'pixi.js';
import type { Project } from '@shared/schema/project';
import type { RenderState } from '@shared/timeline/types';
import type { Live2DActor } from './Live2DActor';

const WATCHED = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamEyeBallX', 'ParamEyeBallY'];

const actors = new Map<string, Live2DActor>();
let app: Application | null = null;

/** What the play page / stage lab expose to tests. */
export interface DebugPlayer {
  seek(t: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  time(): number;
  duration(): number;
  busy(): boolean;
  state(): RenderState | null;
  /** Absolute start time of every scene. */
  sceneStarts(): number[];
  /** Absolute start time of every beat, by beat id. */
  beatStarts(): Record<string, number>;
  /** The project being played, and a way to swap an edited one in (what the editor does on every change). */
  project(): Project;
  reload(project: Project): Promise<boolean>;
}
let player: DebugPlayer | null = null;
type CamInfo = { x: number; y: number; zoom: number; bgZoom?: number; bgViewZoom?: number };
let cameraGetter: (() => CamInfo) | null = null;

export interface ParamReading {
  /** Value the renderer used (motion + expression + overlay + physics). */
  applied: number | null;
  /** Value without the overlay (what the parameter returns to at zero overlay). */
  base: number | null;
}

export interface StudioDebug {
  listLoadedModels(): string[];
  getActorParams(actorId: string, ids?: string[]): Record<string, ParamReading>;
  getRenderState(): Array<{
    id: string;
    worldTransform: { a: number; b: number; c: number; d: number; tx: number; ty: number };
    alpha: number;
  }>;
  /** Present while the play page is open. */
  player: DebugPlayer | null;
  /** Camera pose currently applied to the stage. */
  getCamera(): { x: number; y: number; zoom: number; bgZoom?: number; bgViewZoom?: number } | null;
  /** RGBA bytes of a stage region. */
  snapshotPixels(x: number, y: number, w: number, h: number): number[];
}

export function registerDebugActor(actor: Live2DActor): () => void {
  actors.set(actor.id, actor);
  return () => void actors.delete(actor.id);
}

export function registerDebugApp(a: Application | null): void {
  app = a;
}

export function registerDebugPlayer(p: DebugPlayer | null): void {
  player = p;
}

export function registerDebugCamera(get: (() => CamInfo) | null): void {
  cameraGetter = get;
}

if (import.meta.env.DEV) {
  const hooks: StudioDebug = {
    listLoadedModels: () => [...actors.keys()],
    get player() {
      return player;
    },
    getCamera: () => cameraGetter?.() ?? null,
    getActorParams(actorId, ids = WATCHED) {
      const a = actors.get(actorId);
      if (!a) throw new Error(`unknown actor ${actorId}`);
      return Object.fromEntries(ids.map((id) => [id, { applied: a.appliedValue(id), base: a.baseValue(id) }]));
    },
    getRenderState: () =>
      [...actors.values()].map((a) => {
        const t = a.model.worldTransform;
        return { id: a.id, worldTransform: { a: t.a, b: t.b, c: t.c, d: t.d, tx: t.tx, ty: t.ty }, alpha: a.model.alpha };
      }),
    snapshotPixels(x, y, w, h) {
      if (!app) throw new Error('no app registered');
      const { pixels } = app.renderer.extract.pixels({ target: app.stage, frame: new Rectangle(x, y, w, h) });
      return Array.from(pixels);
    },
  };
  (window as unknown as { __studio: StudioDebug }).__studio = hooks;
}
