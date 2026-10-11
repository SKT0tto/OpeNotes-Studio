import type { Project } from '../../../shared/schema/project';
import type { RenderState } from '../../../shared/timeline/types';

/** The dev-only `window.__studio` hooks (web/engine/debugHooks.ts) as the e2e tests use them. */
export interface Player {
  seek(t: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  time(): number;
  duration(): number;
  busy(): boolean;
  state(): RenderState | null;
  sceneStarts(): number[];
  beatStarts(): Record<string, number>;
  project(): Project;
  reload(project: Project): Promise<boolean>;
}

export interface Studio {
  player: Player | null;
  listLoadedModels(): string[];
  getActorParams(id: string, ids?: string[]): Record<string, { applied: number; base: number }>;
  getActorMotion(id: string): { running: boolean };
  stopActorMotion(id: string): void;
  stageProbe(): { sceneVisible: boolean; people: string[]; hasBackground: boolean } | null;
  getRenderState(): Array<{ id: string; worldTransform: { a: number; d: number } }>;
  getCamera(): { x: number; y: number; zoom: number; bgZoom?: number; bgViewZoom?: number } | null;
  getActorVertexHash(modelId: string): number;
  getActorHeapStale(modelId: string): boolean;
  getActorScreenBoxes(): Array<{ castId: string; modelId: string | null; head: { x: number; y: number; w: number; h: number } }>;
  snapshotPixels(x: number, y: number, w: number, h: number): number[];
}

declare global {
  interface Window {
    __studio: Studio;
  }
}
