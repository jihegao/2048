import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const baseUrl = process.env.SMOKE_BASE_URL?.replace(/\/$/u, '');
const teacherUsername = process.env.ONLINE_TEACHER_USERNAME ?? 'teacher';
const teacherPassword = process.env.ONLINE_TEACHER_PASSWORD;
const studentPassword = process.env.ONLINE_STUDENT_PASSWORD;
if (!baseUrl?.startsWith('https://') || !teacherPassword || !studentPassword) {
  throw new Error(
    'Set SMOKE_BASE_URL, ONLINE_TEACHER_PASSWORD, and ONLINE_STUDENT_PASSWORD before running.',
  );
}

const scratch = mkdtempSync(path.join(tmpdir(), 'challenge-online-smoke-'));
const teacherCookie = path.join(scratch, 'teacher.cookie');
const studentCookies = Array.from({ length: 6 }, (_, index) =>
  path.join(scratch, `student-${index + 1}.cookie`),
);

function curl(pathname, { method = 'GET', body, cookie, saveCookie } = {}) {
  const args = [
    '-fsS',
    '--retry',
    '3',
    '--retry-all-errors',
    '--connect-timeout',
    '20',
    '--max-time',
    '60',
    '-H',
    'accept: application/json',
  ];
  if (method !== 'GET') args.push('--request', method);
  if (body !== undefined) {
    args.push('-H', 'content-type: application/json', '--data', JSON.stringify(body));
  }
  if (cookie) args.push('-b', cookie);
  if (saveCookie) args.push('-c', saveCookie);
  args.push(`${baseUrl}${pathname}`);
  const result = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `curl failed: ${pathname}`);
  return result.stdout;
}

function json(pathname, options) {
  return JSON.parse(curl(pathname, options));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function importRows(type, rows) {
  const base = `/api/teacher/${type}/import`;
  const preview = json(`${base}/validate`, {
    method: 'POST',
    body: { rows },
    cookie: teacherCookie,
  });
  assert(preview.errors.length === 0, `${type} import preview contains errors`);
  return json(`${base}/commit`, {
    method: 'POST',
    body: { rows, token: preview.token },
    cookie: teacherCookie,
  });
}

async function waitForRoomEnd(roomId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const room = json(`/api/teacher/rooms/${roomId}`, { cookie: teacherCookie }).room;
    if (room.status === 'ended') return room;
    process.stdout.write(`Online match status: ${room.status}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('Online match did not finish within 90 seconds');
}

async function browserMove(roomId, loginId, locale, touch) {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY;
  const browser = await chromium.launch({
    headless: true,
    proxy: proxy ? { server: proxy } : undefined,
  });
  try {
    const context = await browser.newContext({
      locale: locale === 'en' ? 'en-US' : 'zh-CN',
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: touch,
      isMobile: touch,
    });
    const login = await context.request.post(`${baseUrl}/api/auth/login`, {
      data: { loginId, password: studentPassword, locale },
    });
    assert(login.ok(), `Browser login failed for ${loginId}`);
    await context.request.patch(`${baseUrl}/api/me/locale`, { data: { locale } });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/student/rooms/${roomId}/match`);
    const board = page.getByRole('grid');
    await board.waitFor({ state: 'visible', timeout: 15_000 });
    await page
      .locator('.game-board:not(.is-disabled)')
      .waitFor({ state: 'visible', timeout: 15_000 });
    const cells = () =>
      page
        .locator('.game-tile')
        .evaluateAll((elements) => elements.map((element) => element.textContent || '0').join(','));
    const before = await cells();
    if (touch) {
      const box = await board.boundingBox();
      assert(box, 'Touch board has no bounding box');
      for (const [startX, startY, endX, endY] of [
        [0.8, 0.5, 0.2, 0.5],
        [0.2, 0.5, 0.8, 0.5],
        [0.5, 0.8, 0.5, 0.2],
        [0.5, 0.2, 0.5, 0.8],
      ]) {
        await board.dispatchEvent('pointerdown', {
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: box.x + box.width * startX,
          clientY: box.y + box.height * startY,
        });
        await board.dispatchEvent('pointerup', {
          pointerId: 1,
          pointerType: 'touch',
          isPrimary: true,
          clientX: box.x + box.width * endX,
          clientY: box.y + box.height * endY,
        });
        await page.waitForTimeout(350);
        if ((await cells()) !== before) break;
      }
    } else {
      for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
        await page.keyboard.press(key);
        await page.waitForTimeout(350);
        if ((await cells()) !== before) break;
      }
    }
    assert((await cells()) !== before, `${touch ? 'Touch' : 'Keyboard'} move was not accepted`);
    assert(
      (await page.locator('html').getAttribute('lang')) === locale,
      'Page locale was not restored',
    );
    await context.close();
  } finally {
    await browser.close();
  }
}

try {
  assert(json('/api/health').ok === true, 'Health check failed');
  const teacher = json('/api/auth/login', {
    method: 'POST',
    body: { loginId: teacherUsername, password: teacherPassword, locale: 'zh-CN' },
    saveCookie: teacherCookie,
  }).user;
  assert(teacher.role === 'teacher', 'Teacher login failed');

  const students = Array.from({ length: 6 }, (_, index) => ({
    studentNumber: `E2E260${index + 1}`,
    name: `线上选手${index + 1}`,
    className: '线上验收班',
  }));
  await importRows('users', students);
  await importRows('teams', [
    {
      name: '线上先锋队',
      memberStudentNumbers: students.slice(0, 3).map((row) => row.studentNumber),
    },
    { name: '线上挑战队', memberStudentNumbers: students.slice(3).map((row) => row.studentNumber) },
  ]);
  students.forEach((student, index) => {
    const loggedIn = json('/api/auth/login', {
      method: 'POST',
      body: { loginId: student.studentNumber, password: studentPassword, locale: 'zh-CN' },
      saveCookie: studentCookies[index],
    }).user;
    assert(loggedIn.role === 'student', `Student login failed: ${student.studentNumber}`);
  });

  const created = json('/api/teacher/rooms', {
    method: 'POST',
    body: { name: `线上验收 ${new Date().toISOString()}`, mode: 'team_3v3', durationMinutes: 1 },
    cookie: teacherCookie,
  }).room;
  json(`/api/rooms/${created.id}/join`, { method: 'POST', cookie: studentCookies[0] });
  json(`/api/rooms/${created.id}/join`, { method: 'POST', cookie: studentCookies[3] });
  const start = json(`/api/teacher/rooms/${created.id}/start`, {
    method: 'POST',
    cookie: teacherCookie,
  });
  assert(start.endsAt - start.startsAt === 60_000, 'One-minute deadline is incorrect');
  await new Promise((resolve) => setTimeout(resolve, 3500));

  const privateSnapshot = json(`/api/rooms/${created.id}/match`, { cookie: studentCookies[0] });
  assert(
    privateSnapshot.game && privateSnapshot.players === undefined,
    'Student snapshot leaks players',
  );
  const teacherSnapshot = json(`/api/teacher/rooms/${created.id}/live`, {
    cookie: teacherCookie,
  });
  assert(teacherSnapshot.players.length === 6, 'Teacher snapshot does not contain six players');

  await browserMove(created.id, students[0].studentNumber, 'en', false);
  await browserMove(created.id, students[1].studentNumber, 'zh-CN', true);
  const ended = await waitForRoomEnd(created.id);
  const detail = json(`/api/teacher/results/${created.id}`, { cookie: teacherCookie }).result;
  assert(detail.players.length === 6, 'Settled result does not contain six players');
  const csv = curl('/api/teacher/results/export.csv', { cookie: teacherCookie });
  assert(
    csv.includes('房间编号,房间名称,模式,配置时长（分钟）'),
    'Chinese CSV headers are missing',
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      roomId: created.id,
      status: ended.status,
      players: detail.players.length,
      teacherLocale: teacher.locale,
      testedLocales: ['zh-CN', 'en'],
      inputs: ['touch', 'keyboard'],
    })}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
