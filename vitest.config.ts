import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = { '@shared': path.resolve(__dirname, 'shared') };

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      {
        resolve: { alias },
        test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 180_000 },
      },
    ],
  },
});
