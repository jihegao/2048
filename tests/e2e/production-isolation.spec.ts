import { test, expect } from './fixtures';
test('production fixtures block unhandled business HTTP writes', async ({ page }) => {
  test.skip(
    process.env.PRODUCTION_MOCKS_ONLY !== '1',
    'Only applies to the production-assets fixture suite',
  );
  await page.goto('/login');
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/__production_mock_guard__', { method: 'POST' });
    return { status: response.status, code: (await response.json()).error.code };
  });
  expect(result).toEqual({ status: 503, code: 'PRODUCTION_MOCK_ONLY' });
});
test('production fixtures block unhandled real business sockets', async ({ page }) => {
  test.skip(
    process.env.PRODUCTION_MOCKS_ONLY !== '1',
    'Only applies to the production-assets fixture suite',
  );
  await page.goto('/login');
  const code = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(
          `${location.origin.replace('http', 'ws')}/api/__production_mock_guard__/ws`,
        );
        socket.onclose = (event) => resolve(event.code);
      }),
  );
  expect(code).toBe(1008);
});
