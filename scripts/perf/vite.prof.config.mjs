// Profiling build of the web app: the production React build, plus the dev-only window.__studio hooks
// (import.meta.env.DEV forced true) so a script can drive the player; unminified with source maps for readable profiles.
// Usage (from the repo root): npx vite build --config scripts/perf/vite.prof.config.mjs --outDir <dir>/dist/web
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export default defineConfig({
  root: path.join(repo, 'web'),
  plugins: [react()],
  resolve: { alias: { '@shared': path.join(repo, 'shared') } },
  define: { 'import.meta.env.DEV': 'true' },
  build: { emptyOutDir: true, assetsDir: 'app', minify: process.env.PROF_MINIFY === '1', sourcemap: true },
});
