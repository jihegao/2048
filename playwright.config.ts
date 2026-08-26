import { defineConfig } from '@playwright/test';

process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'phone-360-zh',
      use: {
        viewport: { width: 360, height: 800 },
        locale: 'zh-CN',
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'phone-390-en',
      use: {
        viewport: { width: 390, height: 844 },
        locale: 'en-US',
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'ipad-portrait-zh',
      use: {
        viewport: { width: 768, height: 1024 },
        locale: 'zh-CN',
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'ipad-landscape-en',
      use: { viewport: { width: 1024, height: 768 }, locale: 'en-US', hasTouch: true },
    },
    { name: 'desktop-zh', use: { viewport: { width: 1440, height: 900 }, locale: 'zh-CN' } },
    { name: 'desktop-en', use: { viewport: { width: 1440, height: 900 }, locale: 'en-US' } },
  ],
});
