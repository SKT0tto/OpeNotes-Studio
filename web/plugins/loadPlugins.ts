/** Loads the browser side of every plugin the server lists. A plugin that fails is skipped; the editor never waits for or depends on one. */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as jsxRuntime from 'react/jsx-runtime';
import type { PluginInfo, PluginWebModule } from '@shared/plugins/api';
import pkg from '../../package.json';
import { createHostApi } from './hostApi';
import { usePlugins } from './registry';

export async function loadPlugins(): Promise<void> {
  let list: PluginInfo[] = [];
  try {
    const res = await fetch('/api/plugins');
    if (res.ok) list = (await res.json()) as PluginInfo[];
  } catch {
    return;
  }
  if (list.length === 0) return;
  // plugins share the studio's React: their bundles map `react` to this object
  window.__OPENOTES_HOST__ = { version: pkg.version, React, jsxRuntime, ReactDOM, api: createHostApi('') };
  const info: PluginInfo[] = [];
  for (const p of list) {
    const row = { ...p };
    if (p.web && !p.error) {
      try {
        const mod = (await import(/* @vite-ignore */ p.web)) as { default?: PluginWebModule };
        if (typeof mod.default?.activate !== 'function') throw new Error('web entry has no default export { activate }');
        await mod.default.activate(createHostApi(p.id));
      } catch (e) {
        row.error = `界面加载失败：${(e as Error).message}`;
        console.warn(`plugin ${p.id}:`, e);
      }
    }
    info.push(row);
  }
  usePlugins.setState({ info });
}
