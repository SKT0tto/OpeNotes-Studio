import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'data', 'vendor', 'data-test', 'release', 'test-results', 'playwright-report', '.verify', 'dev-notes'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: globals.node } },
  // the perf harness mixes node code with snippets that run inside the page
  { files: ['scripts/perf/**/*.{js,mjs}'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['server/**/*.ts', 'tests/**/*.ts', 'tests/**/*.mjs', '*.ts'], languageOptions: { globals: globals.node } },
  { files: ['site/**/*.js'], languageOptions: { globals: globals.browser, sourceType: 'script' } },
);
