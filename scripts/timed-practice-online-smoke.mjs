import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium, expect } from '@playwright/test';
import { applyMove } from '../shared/game.ts';

// Synthetic records belong only in the isolated staging environment.
const baseURL = process.env.SMOKE_BASE_URL;
assert.equal(baseURL, 'https://2048-challenge-platform-staging.jihe-gao.workers.dev');
assert.ok(process.env.SMOKE_SECRETS_FILE, 'Set SMOKE_SECRETS_FILE to staging credentials');
const secrets = JSON.parse(readFileSync(process.env.SMOKE_SECRETS_FILE, 'utf8'));
const output = process.env.SMOKE_OUTPUT_DIR || 'test-results/timed-online';
mkdirSync(output, { recursive: true });
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY;
const browser = await chromium.launch({
  headless: true,
  proxy: proxy ? { server: proxy } : undefined,
});
const context = await browser.newContext({
  baseURL,
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const report = { baseURL, startedAt: new Date().toISOString(), assertions: [], inputLatencyMs: [] };
const check = (condition, message) => {
  assert.ok(condition, message);
  report.assertions.push(message);
};
async function api(url, data) {
  const response =
    data === undefined ? await context.request.get(url) : await context.request.post(url, { data });
  assert.ok(response.ok(), `${url}: HTTP ${response.status()}`);
  return response.json();
}
try {
  await api('/api/auth/login', {
    loginId: secrets.BOOTSTRAP_TEACHER_USERNAME,
    password: secrets.BOOTSTRAP_TEACHER_PASSWORD,
    locale: 'zh-CN',
  });
  const studentNumber = `E2ESMOOTH${Date.now()}`;
  const rows = [
    { studentNumber, name: '限时流畅度验收', className: '线上测试环境', gradeLevel: 6 },
  ];
  const preview = await api('/api/teacher/users/import/validate', { rows });
  check(preview.errors.length === 0, 'synthetic staging student validated');
  await api('/api/teacher/users/import/commit', { rows, token: preview.token });
  await api('/api/auth/logout', {});
  await api('/api/auth/login', {
    loginId: studentNumber,
    password: secrets.INITIAL_STUDENT_PASSWORD,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let active;
  let settled;
  let batches = 0;
  let delayedResponse = false;
  let droppedResponse = false;
  page.on('response', async (response) => {
    if (!response.url().includes('/api/practice/timed/') || !response.ok()) return;
    const data = await response.json().catch(() => null);
    if (data?.status === 'active') active = data.session;
    if (data?.status === 'settled') settled = data.result;
  });
  await page.route('**/api/practice/timed/moves', async (route) => {
    batches += 1;
    const response = await route.fetch();
    if (!delayedResponse) {
      delayedResponse = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } else if (!droppedResponse) {
      droppedResponse = true;
      // Simulate a response lost after the server has already committed the batch.
      return route.abort('failed');
    }
    await route.fulfill({ response });
  });
  await page.goto('/student/practice');
  await page.getByRole('tab', { name: '3 分钟限时练习', exact: true }).click();
  const board = page.getByRole('grid');
  await board.waitFor();
  assert.ok(active, 'initial server session captured');
  const sessionId = active.id;
  const deadline = active.deadlineAt;
  const initialSeq = active.seq;
  check(
    Date.parse(deadline) - Date.parse(active.startedAt) === 180_000,
    'fixed server duration is 180 seconds',
  );
  let predicted = active.snapshot;
  const cells = () =>
    page
      .locator('.game-tile')
      .evaluateAll((elements) => elements.map((el) => Number(el.textContent) || 0));
  for (let index = 0; index < 12; index += 1) {
    const direction = ['left', 'down', 'right', 'up'].find(
      (direction) => applyMove(predicted, direction).moved,
    );
    assert.ok(direction);
    predicted = applyMove(predicted, direction).snapshot;
    const began = performance.now();
    if (index % 2 === 0) {
      await page.keyboard.press(`Arrow${direction[0].toUpperCase()}${direction.slice(1)}`);
    } else {
      const box = await board.boundingBox();
      const [dx, dy] = { left: [-100, 0], right: [100, 0], up: [0, -100], down: [0, 100] }[
        direction
      ];
      const point = {
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      };
      await board.dispatchEvent('pointerdown', point);
      await board.dispatchEvent('pointerup', {
        ...point,
        clientX: point.clientX + dx,
        clientY: point.clientY + dy,
      });
    }
    await expect.poll(cells, { timeout: 1000, intervals: [5, 10, 20] }).toEqual(predicted.board);
    report.inputLatencyMs.push(Math.round(performance.now() - began));
    check(
      !(await board.getAttribute('class')).includes('is-disabled'),
      `input ${index + 1} remains enabled`,
    );
  }
  check(
    Math.max(...report.inputLatencyMs) < 500,
    'all inputs render below 500ms with a 1500ms response delay',
  );
  for (let tries = 0; tries < 30 && active.seq < initialSeq + 12; tries += 1)
    await page.waitForTimeout(500);
  check(
    active.seq === initialSeq + 12,
    'all 12 inputs acknowledged exactly once after response loss',
  );
  check(droppedResponse, 'lost-response retry exercised');
  assert.deepEqual(active.snapshot.board, predicted.board);
  assert.deepEqual(await cells(), predicted.board);
  check(active.snapshot.score === predicted.score, 'predicted and authoritative scores agree');
  await page.screenshot({ path: path.join(output, 'playing-mobile.png'), fullPage: true });
  await page.reload();
  await board.waitFor();
  assert.deepEqual(await cells(), predicted.board);
  check(
    active.id === sessionId && active.deadlineAt === deadline,
    'refresh preserves the same session and deadline',
  );
  const remaining = Math.max(0, Date.parse(deadline) - Date.now());
  process.stdout.write(
    JSON.stringify({
      stage: 'playing_verified',
      sessionId,
      batches,
      remainingSeconds: Math.ceil(remaining / 1000),
      inputLatencyMs: report.inputLatencyMs,
    }) + '\n',
  );
  while (!settled && Date.now() < Date.parse(deadline) + 20_000) await page.waitForTimeout(1000);
  check(Boolean(settled), 'real three-minute deadline settled in the browser');
  check(settled.endReason === 'time_limit', 'result ended by time limit');
  check(settled.score === predicted.score, 'settled score equals the accepted score');
  const late = await api('/api/practice/timed/moves', {
    sessionId,
    seq: initialSeq + 13,
    directions: ['left', 'down'],
  });
  check(
    late.status === 'settled' &&
      late.result.id === settled.id &&
      late.result.score === settled.score,
    'late batch cannot change the result',
  );
  const again = await api('/api/practice/timed/finish', { sessionId });
  check(again.result.id === settled.id, 'repeat finish returns the same result');
  const results = await api('/api/me/results');
  check(
    results.timedPracticeBest.filter((item) => item.id === settled.id).length === 1,
    'personal top ten contains exactly one result',
  );
  check(results.practiceBest.length === 0, 'timed result stays out of ordinary practice');
  check(errors.length === 0, 'no browser runtime errors');
  await page.screenshot({ path: path.join(output, 'settled-mobile.png'), fullPage: true });
  report.sessionId = sessionId;
  report.result = settled;
  report.batches = batches;
  report.completedAt = new Date().toISOString();
  report.ok = true;
  writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({
      ok: true,
      sessionId,
      score: settled.score,
      assertions: report.assertions.length,
      batches,
      output,
    }) + '\n',
  );
} finally {
  await browser.close();
}
