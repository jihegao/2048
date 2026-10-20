import { expect, test, type Page } from '@playwright/test';

async function enter(page: Page) {
  await page.goto('/login');
  await page.locator('[name=loginId]').fill('cookie-test-teacher');
  await page.locator('[name=password]').fill('local-only-cookie-test-password');
}
async function submit(page: Page) {
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('real HTTPS Set-Cookie returns through the browser and confirms the login identity', async ({
  page,
  context,
}) => {
  const confirmation = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/auth/cookie-check/confirm',
  );
  await enter(page);
  expect(await (await confirmation).json()).toEqual({ supported: true });
  await submit(page);
  await expect(page).toHaveURL(/\/teacher$/);
  const cookies = await context.cookies();
  expect(
    cookies.some(
      (c) =>
        c.name.startsWith('__Host-session-') && c.secure && c.httpOnly && c.sameSite === 'Strict',
    ),
  ).toBe(true);
  expect(cookies.some((c) => c.name.startsWith('__Host-cookie-check-'))).toBe(false);
});

test('discarded Set-Cookie blocks credentials with a cookie-specific message', async ({
  page,
  playwright,
}) => {
  let logins = 0;
  const isolatedRequest = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  await page.route('**/api/auth/cookie-check', async (route) => {
    const response = await isolatedRequest.fetch(route.request());
    const headers = response.headers();
    delete headers['set-cookie'];
    await route.fulfill({ response, headers });
  });
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/auth/login') logins++;
  });
  await enter(page);
  await submit(page);
  await expect(
    page.getByText('This browser could not save or send login cookies.', { exact: false }),
  ).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  await isolatedRequest.dispose();
  expect(logins).toBe(0);
  await expect(page).toHaveURL(/\/login$/);
});

test('network uncertainty stays on login and is not reported as cookie rejection', async ({
  page,
}) => {
  await page.route('**/api/auth/cookie-check', (route) => route.abort());
  await enter(page);
  await submit(page);
  await expect(page.getByText('The login check could not finish.', { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

for (const failure of ['missing', 'invalid', 'other-user', 'network']) {
  test(`successful POST cannot bypass ${failure} confirmation`, async ({ page }) => {
    await page.route('**/api/auth/session-confirm', async (route) => {
      if (failure === 'network') return route.abort();
      if (failure === 'other-user')
        return route.fulfill({ json: { state: 'valid', user: { id: 'other', role: 'teacher' } } });
      // Run the real Worker with no/invalid Cookie header.
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          cookie: failure === 'missing' ? '' : '__Host-session-test=invalid',
        },
      });
      await route.fulfill({ response });
    });
    await enter(page);
    await submit(page);
    await expect(
      page.getByText(
        failure === 'missing'
          ? 'This browser could not save or send login cookies.'
          : failure === 'network'
            ? 'The login check could not finish.'
            : 'The login session is invalid',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
}

test('duplicate submission and refresh while confirming cannot enter home early', async ({
  page,
}) => {
  let logins = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/auth/login') logins++;
  });
  await page.route('**/api/auth/session-confirm', async (route) => {
    await gate;
    await route.continue();
  });
  await enter(page);
  await submit(page);
  await expect.poll(() => logins).toBe(1);
  await page.locator('form').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    window.dispatchEvent(new Event('auth:refresh'));
  });
  await expect(page).toHaveURL(/\/login$/);
  expect(logins).toBe(1);
  release();
  await expect(page).toHaveURL(/\/teacher$/);
});

test('a late confirmation after auth generation changes cannot navigate', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checking = false;
  await page.route('**/api/auth/session-confirm', async (route) => {
    checking = true;
    await gate;
    await route.continue();
  });
  await enter(page);
  await submit(page);
  await expect.poll(() => checking).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('auth:expired')));
  release();
  await expect(
    page.getByText('This login attempt is no longer current.', { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('optional locale persistence failure does not discard a real authenticated session', async ({
  page,
}) => {
  await enter(page);
  await submit(page);
  await expect(page).toHaveURL(/\/teacher$/);
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.user.locale = null;
    await route.fulfill({ json: body });
  });
  await page.route('**/api/me/locale', (route) => route.abort());
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/teacher$/);
});

test('discarding the real login Set-Cookie cannot produce a successful login', async ({
  page,
  playwright,
}) => {
  const isolatedRequest = await playwright.request.newContext({ ignoreHTTPSErrors: true });
  await page.route('**/api/auth/login', async (route) => {
    const response = await isolatedRequest.fetch(route.request());
    const headers = response.headers();
    delete headers['set-cookie'];
    await route.fulfill({ response, headers });
  });
  await enter(page);
  await submit(page);
  await expect(
    page.getByText('This browser could not save or send login cookies.', { exact: false }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await page.unrouteAll({ behavior: 'wait' });
  await isolatedRequest.dispose();
});

test('old bootstrap 401 responses cannot expire a newly confirmed real session', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let returned = 0;
  await page.route('**/api/me', async (route) => {
    await gate;
    await route.fulfill({
      status: 401,
      json: { error: { code: 'AUTH_REQUIRED', message: 'old request' } },
    });
    returned++;
  });
  await enter(page);
  await submit(page);
  await expect(page).toHaveURL(/\/teacher$/);
  release();
  await expect.poll(() => returned).toBeGreaterThan(0);
  await expect(page).toHaveURL(/\/teacher$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
