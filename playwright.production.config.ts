import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/production',
  outputDir: './test-results/production-anonymous',
  workers: 1,
  use: {
    baseURL: 'https://mingcheng1024.cn',
    locale: 'en-US',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'production-chromium', use: { browserName: 'chromium' } },
    { name: 'production-webkit', use: { browserName: 'webkit' } },
  ],
});
