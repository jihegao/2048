import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.SMOKE_BASE_URL;
assert.equal(baseURL, 'https://2048-challenge-platform-staging.jihe-gao.workers.dev');
assert.ok(process.env.SMOKE_SECRETS_FILE, 'Set SMOKE_SECRETS_FILE to staging credentials');
const secrets = JSON.parse(readFileSync(process.env.SMOKE_SECRETS_FILE, 'utf8'));
const output = process.env.SMOKE_OUTPUT_DIR || 'test-results/team-online';
mkdirSync(output, { recursive: true });
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY;
const browser = await chromium.launch({ proxy: proxy ? { server: proxy } : undefined });
const report = { baseURL, startedAt: new Date().toISOString(), assertions: [] };
const check = (condition, message) => {
  assert.ok(condition, message);
  report.assertions.push(message);
};
async function api(context, url, data) {
  const response =
    data === undefined ? await context.request.get(url) : await context.request.post(url, { data });
  assert.ok(response.ok(), `${url}: HTTP ${response.status()}`);
  return response.json();
}
try {
  const teacher = await browser.newContext({ baseURL });
  await api(teacher, '/api/auth/login', {
    loginId: secrets.BOOTSTRAP_TEACHER_USERNAME,
    password: secrets.BOOTSTRAP_TEACHER_PASSWORD,
    locale: 'zh-CN',
  });
  const stamp = Date.now();
  const rows = ['团队验收甲', '团队验收乙', '团队验收丙'].map((name, index) => ({
    studentNumber: `E2ETEAM${stamp}${index}`,
    name,
    className: '线上测试环境',
    gradeLevel: 6,
  }));
  const preview = await api(teacher, '/api/teacher/users/import/validate', { rows });
  check(preview.errors.length === 0, 'synthetic staging students validated');
  await api(teacher, '/api/teacher/users/import/commit', { rows, token: preview.token });
  const contexts = [];
  for (const row of rows) {
    const context = await browser.newContext({
      baseURL,
      locale: 'zh-CN',
      viewport: { width: 1440, height: 900 },
    });
    await api(context, '/api/auth/login', {
      loginId: row.studentNumber,
      password: secrets.INITIAL_STUDENT_PASSWORD,
      locale: 'zh-CN',
    });
    contexts.push(context);
  }
  const [owner, member, guest] = contexts;
  const errors = [];
  const ownerPage = await owner.newPage();
  ownerPage.on('pageerror', (error) => errors.push(error.message));
  ownerPage.on('dialog', (dialog) => dialog.accept());
  await ownerPage.goto('/student/team');
  await expect(ownerPage.getByRole('tab', { name: '加入团队' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await ownerPage.getByRole('tab', { name: '创建团队' }).click();
  await ownerPage.getByLabel('团队名称', { exact: true }).fill(`布局验收${stamp}`);
  await ownerPage.getByRole('radio', { name: 'tiger', exact: true }).click();
  await ownerPage.screenshot({ path: path.join(output, 'create-desktop.png'), fullPage: true });
  await ownerPage.getByRole('button', { name: '创建团队', exact: true }).click();
  await expect(ownerPage.locator('.my-team-card')).toBeVisible();
  const { team } = await api(owner, '/api/me/team');
  check(team.logo === 'tiger', 'create form saves chosen logo');
  await api(member, `/api/teams/${team.id}/join`, {});
  const page = await guest.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/student/team');
  await page.getByRole('textbox', { name: '搜索团队名称或代码' }).fill(team.code);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const result = page.locator('.team-search-results article');
  await expect(result).toContainText('团队验收甲、团队验收乙');
  await expect(result).toContainText('2 / 3 人');
  const search = await api(guest, `/api/teams/search?query=${team.code}`);
  assert.deepEqual(
    search.items[0].memberNames,
    rows.slice(0, 2).map((row) => row.name),
  );
  assert.deepEqual(
    Object.keys(search.items[0]).sort(),
    ['code', 'id', 'logo', 'memberNames', 'member_count', 'name', 'team_group'].sort(),
  );
  check(true, 'authenticated search returns both names without student identifiers');
  await page.screenshot({ path: path.join(output, 'search-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 360, height: 800 });
  check(
    await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
    ),
    'mobile has no horizontal overflow',
  );
  const inputBox = await page.locator('.search-form input').boundingBox();
  const buttonBox = await page.locator('.search-form button').boundingBox();
  check(Math.abs(inputBox.y - buttonBox.y) < 2, 'mobile search input and button share one row');
  await page.screenshot({ path: path.join(output, 'search-mobile.png'), fullPage: true });
  await result.getByRole('button', { name: '加入团队' }).click();
  await expect(page.locator('.my-team-card .member-list li')).toHaveCount(3);
  check(true, 'join button completes membership through the live server');
  await page.getByRole('button', { name: '退出团队', exact: true }).click();
  await expect(page.getByRole('tab', { name: '加入团队' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  check(true, 'leaving returns to the join tab');
  await ownerPage.getByRole('button', { name: '删除团队', exact: true }).click();
  await expect(ownerPage.getByRole('tab', { name: '加入团队' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const removed = await api(guest, `/api/teams/search?query=${team.code}`);
  check(removed.items.length === 0, 'deleted synthetic team disappears from search');
  check(errors.length === 0, 'no browser runtime errors');
  report.completedAt = new Date().toISOString();
  report.ok = true;
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({ ok: true, assertions: report.assertions.length, output }) + '\n',
  );
} finally {
  await browser.close();
}
