/**
 * The plugin contract (version 1). A plugin lives in `<install>/plugins/<id>/` and is released on its own:
 *
 *   plugin.json   { id, name, version, description, minStudioVersion?, server?: "server.mjs", web?: "web.js" }
 *   server.mjs    default export `register(ctx: PluginServerContext)`        (Node side; optional)
 *   web.js        default export `{ activate(host: HostApi) }`               (browser side; optional)
 *
 * A broken plugin is logged and skipped; it never stops the studio from starting. See plugins/README.md.
 */
import type { ComponentType, ReactNode } from 'react';
import type { Router } from 'express';
import type { z } from 'zod';
import type { Beat, BeatVoice, Project, Scene } from '../schema/project';

export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  minStudioVersion?: string;
  /** Built Node entry, relative to the plugin folder (default `server.mjs`). */
  server?: string;
  /** Built browser entry, relative to the plugin folder (default `web.js`). */
  web?: string;
}

/** One row of `GET /api/plugins`. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** URL of the browser entry (null = the plugin has none). */
  web: string | null;
  /** Why the plugin was skipped or only partly loaded (the studio itself is unaffected). */
  error?: string;
}

// ---- Node side ------------------------------------------------------------------------------------------
export interface JsonCallRequest<T> {
  system: string;
  /** JSON-able data (sorted keys) or text. */
  user: unknown;
  schema: z.ZodType<T>;
  schemaName: string;
  /** Part of the cache key: bump it when the prompt changes. */
  promptVersion: string;
  maxTokens: number;
  signal?: AbortSignal | undefined;
  refresh?: boolean | undefined;
}

export interface PluginServerContext {
  id: string;
  /** Mounted at `/api/plugins/<id>/`. */
  router: Router;
  /** `data/plugins/<id>/`: the plugin's own writable folder (created on demand by the plugin). */
  dataDir: string;
  /** `data/`, for reading a settings file an older version of the studio wrote there. */
  rootDataDir: string;
  log(message: string): void;
  /** Per-line voice files of a project: `data/projects/<id>/voice/<name>` (served at `/api/projects/<id>/voice/<name>`). */
  voice: {
    write(projectId: string, name: string, bytes: Uint8Array): Promise<void>;
    read(projectId: string, name: string): Promise<Uint8Array | null>;
    list(projectId: string): Promise<string[]>;
    remove(projectId: string, name: string): Promise<void>;
  };
  llm: {
    /** Whether the user's AI is configured (and why not, in Chinese). */
    available(): { ok: true } | { ok: false; message: string };
    /** One structured JSON call through the user's configured provider (same cache as the director). Errors carry `kind`. */
    callJson<T>(req: JsonCallRequest<T>): Promise<{ data: T; cached: boolean }>;
  };
}
export type PluginRegister = (ctx: PluginServerContext) => void | Promise<void>;

// ---- browser side ---------------------------------------------------------------------------------------
export interface VoicePatch {
  sceneId: string;
  beatId: string;
  /** The whole new `voice` of the beat; null removes it. */
  voice: BeatVoice | null;
}

export interface StudioSnapshot {
  project: Project | null;
  selection: { sceneId: string | null; beatId: string | null; castId: string | null };
}

export interface HostApi {
  apiVersion: typeof PLUGIN_API_VERSION;
  studioVersion: string;
  /** A button in the editor's top bar; `dialog` opens when it is clicked. */
  registerTopBarButton(b: { id: string; label: string; title?: string; dialog: ComponentType<{ onClose(): void }> }): void;
  /** A section in the inspector's line tab, shown for the selected line. */
  registerInspectorSection(s: { id: string; component: ComponentType<{ project: Project; scene: Scene; beat: Beat }> }): void;
  /** Hook: the open project and selection (re-renders on change). */
  useStudio(): StudioSnapshot;
  getStudio(): StudioSnapshot;
  /**
   * Replaces the `voice` of beats in ONE undo step (nothing else of a beat can be changed this way; locks do not apply).
   * `coalesce` merges consecutive calls with the same key (typing). Returns how many beats changed.
   */
  applyBeatVoice(patches: VoicePatch[], label: string, opts?: { coalesce?: string }): number;
  sealEdit(): void;
  notify(text: string, tone?: 'info' | 'warn'): void;
  /** `fetch` for `/api/plugins/<pluginId>/<path>`. */
  fetchPlugin(pluginId: string, path: string, init?: RequestInit): Promise<Response>;
  voice: {
    fileUrl(projectId: string, file: string): string;
    /** Playback volume of recorded lines (0..1, remembered by the browser). */
    getVolume(): number;
    setVolume(v: number): void;
  };
  /** The studio's own dialog / form pieces, so a plugin looks like the rest of the editor. */
  ui: {
    Modal: ComponentType<{ title: string; onClose(): void; children?: ReactNode; testid?: string; wide?: boolean }>;
    Section: ComponentType<{ title: string; hint?: string; testid?: string; children?: ReactNode }>;
    Row: ComponentType<{ label: string; children?: ReactNode }>;
  };
}
export interface PluginWebModule {
  activate(host: HostApi): void | Promise<void>;
}

declare global {
  interface Window {
    __OPENOTES_HOST__?: { version: string; React: unknown; jsxRuntime: unknown; ReactDOM: unknown; api: HostApi };
  }
}
