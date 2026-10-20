import { expect, test } from '@playwright/test';
const fixtureUser = { id: 'isolated-browser-fixture', role: 'student', locale: 'en' };
test('real anonymous browser Cookie preflight completes with strict security attributes', async ({
  page,
  context,
}) => {
  const confirmed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/auth/cookie-check/confirm',
  );
  await page.goto('/login');
  const response = await confirmed;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ supported: true });
  expect((await context.cookies()).some((c) => c.name.startsWith('__Host-session'))).toBe(false);
  expect((await context.cookies()).some((c) => c.name.startsWith('__Host-cookie-check'))).toBe(
    false,
  );
  const start = await page.request.post('/api/auth/cookie-check');
  expect(start.status()).toBe(200);
  const attrs = start.headers()['set-cookie'];
  for (const a of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=120'])
    expect(attrs.includes(a)).toBe(true);
  const end = await page.request.post('/api/auth/cookie-check/confirm', {
    data: await start.json(),
  });
  expect(await end.json()).toEqual({ supported: true });
});
test('real anonymous session confirmation is missing and privileged reads require auth', async ({
  request,
}) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  const me = await request.get('/api/me');
  expect(await me.json()).toEqual({ user: null });
  const session = await request.post('/api/auth/session-confirm');
  expect(await session.json()).toEqual({ state: 'missing', user: null });
  expect(session.headers()['cache-control']).toBe('no-store');
  expect((await request.get('/api/teacher/rooms')).status()).toBe(401);
  const rejected = await request.post('/api/auth/cookie-check', {
    headers: { Origin: 'https://untrusted.invalid' },
  });
  expect(rejected.status()).toBe(403);
  expect(rejected.headers()['set-cookie']).toBeUndefined();
});
test('a mocked success POST cannot bypass real anonymous session confirmation', async ({
  page,
}) => {
  // No credentials are sent to production: only this isolated fixture is accepted locally.
  let intercepted = 0;
  await page.route('**/api/auth/login', (route) => {
    intercepted++;
    return route.fulfill({ json: { user: fixtureUser } });
  });
  await page.goto('/login');
  await page.locator('[name=loginId]').fill('isolated-browser-fixture');
  await page.locator('[name=password]').fill('not-a-production-credential');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByText('This browser could not save or send login cookies.', { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  expect(intercepted).toBe(1);
});
test('network-unknown preflight remains distinct from Cookie rejection without sending credentials', async ({
  page,
}) => {
  let loginRequests = 0;
  await page.route('**/api/auth/cookie-check', (route) => route.abort());
  await page.route('**/api/auth/login', (route) => {
    loginRequests++;
    return route.abort();
  });
  await page.goto('/login');
  await expect(page.getByText('The login check could not finish.', { exact: false })).toBeVisible();
  expect(loginRequests).toBe(0);
});
