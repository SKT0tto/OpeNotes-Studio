import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const serverPort = Number(process.env.API_PORT ?? 5274);
const target = `http://127.0.0.1:${serverPort}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, 'shared') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT ?? 5273),
    strictPort: true,
    proxy: {
      // a proxy failure (502) is logged with the path and the cause, so an intermittent one can be traced
      '^/api/': { target, configure: (proxy) => { proxy.on('error', (err, req) => console.error(`[proxy] ${req.method} ${req.url}: ${(err as Error).message}`)); } },
      '^/assets/': target,
      '^/audio/': target,
      '^/vendor/': target,
    },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
