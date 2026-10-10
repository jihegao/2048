import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'coverage',
      'playwright-report',
      'test-results',
      '.wrangler',
      '.wrangler-dry-run',
      'worker-configuration.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'tests/migration-tools/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['public/offline/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['worker/**/*.ts', 'worker/**/*.mjs', 'operations/source-verification-wrapper.mjs'],
    languageOptions: { globals: { ...globals.worker } },
  },
);
