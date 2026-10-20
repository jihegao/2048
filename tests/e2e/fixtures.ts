import { test as base } from '@playwright/test';
export { expect, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test';

// Page-level mocks take priority. Every test in the production-assets suite
// installs this automatic fixture, so missing mocks never reach real APIs.
export const test = base.extend<{ productionBarrier: void }>({
  productionBarrier: [
    async ({ context }, use) => {
      if (process.env.PRODUCTION_MOCKS_ONLY === '1') {
        await context.route('**/api/**', (route) =>
          route.fulfill({
            status: 503,
            json: {
              error: { code: 'PRODUCTION_MOCK_ONLY', message: 'Missing isolated API fixture' },
            },
          }),
        );
        await context.routeWebSocket('**/api/**', (socket) =>
          socket.close({ code: 1008, reason: 'Real business sockets disabled in fixture tests' }),
        );
      }
      await use();
    },
    { auto: true },
  ],
});
