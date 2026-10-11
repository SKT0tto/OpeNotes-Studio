// Bundles the Express server (server/index.ts) into dist/server/index.mjs so that production needs neither tsx nor the
// TypeScript sources. npm packages stay external: a production install (`npm ci --omit=dev`) provides them.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server/index.mjs',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
});
