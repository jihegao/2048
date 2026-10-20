import { defineConfig } from '@playwright/test';
import production from './playwright.production-mock.config';
import auth from './playwright.auth.config';

// Exercise the production bundle with isolated local bindings and mocked APIs.
export default defineConfig({
  ...production,
  outputDir: './test-results/production-mock-local',
  use: { ...production.use, baseURL: auth.use?.baseURL, ignoreHTTPSErrors: true },
  webServer: auth.webServer,
});
