import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { actionTimeout: 20_000, baseURL: 'http://127.0.0.1:5273', channel: 'msedge', headless: true, viewport: { width: 1440, height: 900 } },
  webServer: [
    { command: 'npm run dev', url: 'http://127.0.0.1:5273', reuseExistingServer: true, timeout: 120_000 },
    // A second pair of servers for the AI workflow: NODE_ENV=test registers the recorded-response provider (never offered by a normal server)
    // and nothing reads the real key / settings.
    {
      command: 'npx tsx server/index.ts',
      url: 'http://127.0.0.1:5374/api/health',
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test', API_PORT: '5374', LLM_SETTINGS_FILE: 'data-test/e2e-settings.local.json',
        LLM_PROVIDER: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '', ANTHROPIC_API_KEY: '',
      },
    },
    // First-run server: an empty, throw-away library + isolated config/vendor/setup files, and a mock of the Haneoka index API.
    { command: 'node tests/e2e/helpers/mockHaneoka.mjs', url: 'http://127.0.0.1:5377/api/v1/backgrounds', reuseExistingServer: true, timeout: 60_000 },
    {
      command: 'npx tsx server/index.ts',
      url: 'http://127.0.0.1:5376/api/health',
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test', API_PORT: '5376', ASSET_ROOT: 'data-test/e2e-lib', DATA_DIR: 'data-test/e2e-lib-data', STUDIO_CONFIG_FILE: 'data-test/e2e-config.json',
        VENDOR_DIR: 'data-test/e2e-vendor', SETUP_FILE: 'data-test/e2e-setup.local.json', LLM_SETTINGS_FILE: 'data-test/e2e-lib-settings.local.json',
        HANEOKA_BASE_URL: 'http://127.0.0.1:5377', LLM_PROVIDER: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '', ANTHROPIC_API_KEY: '',
      },
    },
    { command: 'npx vite', url: 'http://127.0.0.1:5375', reuseExistingServer: true, timeout: 120_000, env: { API_PORT: '5376', VITE_PORT: '5375' } },
    { command: 'npx vite', url: 'http://127.0.0.1:5373', reuseExistingServer: true, timeout: 120_000, env: { API_PORT: '5374', VITE_PORT: '5373' } },
  ],
});
