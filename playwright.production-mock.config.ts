import { defineConfig } from '@playwright/test';
import base from './playwright.config';
process.env.PRODUCTION_MOCKS_ONLY = '1';
export default defineConfig({
  ...base,
  webServer: undefined,
  outputDir: './test-results/production-mock',
  reporter: [['list']],
  use: {
    ...base.use,
    baseURL: 'https://mingcheng1024.cn',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
