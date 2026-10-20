import { defineConfig } from '@playwright/test';
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
export default defineConfig({
  testDir: './tests/browser-auth',
  testMatch: '*.spec.ts',
  outputDir: './test-results/auth-cookie',
  workers: 1,
  use: {
    baseURL: 'https://localhost:8791',
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'auth-chromium', use: { browserName: 'chromium' } },
    { name: 'auth-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    // This config contains only local dummy bindings and synthetic credentials.
    command:
      'npx wrangler d1 migrations apply cookie-auth-local-test --local --config wrangler.auth-test.jsonc && npx wrangler dev --local --local-protocol https --port 8791 --config wrangler.auth-test.jsonc',
    url: 'https://localhost:8791/api/health',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
