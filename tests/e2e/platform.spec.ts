import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { RoomStatus } from '../../shared/types';

type Locale = 'zh-CN' | 'en';

function projectLocale(testInfo: TestInfo): Locale {
  return String(testInfo.project.use.locale).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

async function expectUniformBoardCells(page: Page) {
  const cells = page.locator('.game-board .game-tile');
  await expect(cells).toHaveCount(16);

  const metrics = await cells.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        height: bounds.height,
        width: bounds.width,
        value: element.textContent?.trim() ?? '',
      };
    }),
  );
  const heights = metrics.map(({ height }) => height);
  const widths = metrics.map(({ width }) => width);
  const rows = Array.from({ length: 4 }, (_, row) =>
    metrics.slice(row * 4, row * 4 + 4).map(({ value }) => value),
  );

  expect(rows.some((row) => row.every((value) => value === ''))).toBe(true);
  expect(rows.some((row) => row.some((value) => value !== ''))).toBe(true);
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
}

async function mockApi(
  page: Page,
  role: 'teacher' | 'student',
  initialLocale: Locale,
  roomOptions: { status?: RoomStatus; isParticipant?: boolean } = {},
) {
  let locale = initialLocale;
  let authenticated = true;
  let studentTeam: Record<string, unknown> | null = null;
  const roomStatus = roomOptions.status ?? 'open';
  const isParticipant = roomOptions.isParticipant ?? false;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const user = {
      id: role === 'teacher' ? 'teacher-1' : 'student-1',
      loginId: role === 'teacher' ? 'teacher' : '20260001',
      studentNumber: role === 'teacher' ? '' : '20260001',
      name: role === 'teacher' ? 'Demo Teacher' : 'Demo Student',
      className: role === 'teacher' ? null : 'Grade 6 Class 1',
      gradeLevel: role === 'teacher' ? null : 6,
      role,
      locale,
    };
    if (path === '/api/me' && request.method() === 'GET') {
      return json({ user: authenticated ? user : null });
    }
    if (path === '/api/me/locale') {
      locale = (request.postDataJSON() as { locale: Locale }).locale;
      return json({ ok: true, locale, message: '语言设置已保存' });
    }
    if (path === '/api/me/password' && request.method() === 'PATCH') {
      authenticated = false;
      return json({ ok: true, message: '密码已修改，请使用新密码重新登录' });
    }
    if (path === '/api/auth/logout') return json({ ok: true });
    if (path === '/api/teacher/rooms') {
      if (request.method() === 'POST') return json({ message: '房间已创建' }, 201);
      return json({
        items: [
          {
            id: 'room-1',
            code: 'A2048',
            name: 'Grade 6 Challenge',
            mode: 'duel',
            durationMinutes: 5,
            status: roomStatus,
            isParticipant,
            participantCount: 0,
            participantCapacity: 2,
            lockedAt: null,
            startsAt: null,
            endsAt: null,
            createdAt: '2026-08-26T08:00:00.000Z',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    }
    if (path === '/api/practice/start') {
      return json({
        challenge: 'mock-signed-practice-challenge',
        seed: 12345,
        startedAt: '2026-08-26T08:00:00.000Z',
        engineVersion: '1.0.0',
      });
    }
    if (path === '/api/practice/complete') return json({ message: '练习成绩已保存' });
    if (path === '/api/me/team') {
      if (request.method() === 'DELETE') {
        studentTeam = null;
        return json({ ok: true, message: '已退出团队' });
      }
      return json({ team: studentTeam });
    }
    if (path === '/api/teams/search') {
      return json({
        items: [{ id: 'team-1', name: 'Pioneer Team', code: 'TEAM01', member_count: 2 }],
      });
    }
    if (path === '/api/teams/team-1/join') {
      studentTeam = {
        id: 'team-1',
        name: 'Pioneer Team',
        code: 'TEAM01',
        frozen: 0,
        members: [
          {
            id: 'student-1',
            student_no: '20260001',
            display_name: 'Demo Student',
            class_name: 'Grade 6 Class 1',
          },
        ],
      };
      return json({ ok: true, message: '已加入团队' });
    }
    if (path === '/api/me/results') return json({ items: [] });
    if (path === '/api/leaderboard') {
      return json({
        status: 'available',
        period: {
          id: 'period-current',
          name: 'September Practice',
          startAt: '2026-09-01T00:00:00.000Z',
          endAt: '2026-10-01T00:00:00.000Z',
          status: 'active',
        },
        overall: {
          status: 'available',
          gradeLevel: null,
          participantCount: 28,
          currentUserRank: 21,
          entries: [
            {
              rank: 1,
              className: '六年级1班',
              maskedName: '张*',
              studentNumberSuffix: '260001',
              score: 8192,
              maxTile: 1024,
              isCurrentUser: false,
            },
            {
              rank: 21,
              className: '六年级1班',
              maskedName: '演示学*',
              studentNumberSuffix: '260024',
              score: 4096,
              maxTile: 512,
              isCurrentUser: true,
            },
          ],
        },
        grade: {
          status: 'available',
          gradeLevel: 6,
          participantCount: 12,
          currentUserRank: 8,
          entries: [
            {
              rank: 8,
              className: '六年级1班',
              maskedName: '演示学*',
              studentNumberSuffix: '260024',
              score: 4096,
              maxTile: 512,
              isCurrentUser: true,
            },
          ],
        },
      });
    }
    if (path === '/api/rooms') {
      return json({
        items: [
          {
            id: 'room-1',
            code: 'A2048',
            name: 'Grade 6 Challenge',
            mode: 'duel',
            durationMinutes: 5,
            status: roomStatus,
            isParticipant,
            participantCount: 0,
            participantCapacity: 2,
            lockedAt: null,
            startsAt: null,
            endsAt: null,
            createdAt: '2026-08-26T08:00:00.000Z',
          },
        ],
        total: 1,
        pageSize: 20,
      });
    }
    if (path === '/api/rooms/room-1/join') return json({ ok: true, message: '已加入房间' });
    if (path === '/api/rooms/room-1/match') {
      const now = Date.now();
      return json({
        type: 'state',
        roomId: 'room-1',
        roomStatus,
        serverTime: now,
        startsAt: now - 3_000,
        endsAt: now + 60_000,
        canControl: true,
        game: {
          board: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
          score: 0,
          maxTile: 2,
          maxTileReachedAt: now - 3_000,
          moveCount: 0,
          rngState: 12345,
          seq: 0,
          status: 'playing',
        },
      });
    }
    if (path === '/api/rooms/room-1') {
      return json({
        room: {
          id: 'room-1',
          code: 'A2048',
          name: 'Grade 6 Challenge',
          mode: 'duel',
          durationMinutes: 5,
          status: roomStatus,
          isParticipant,
          participantCount: 1,
          participantCapacity: 2,
          lockedAt: '2026-08-26T08:00:00.000Z',
          startsAt: null,
          endsAt: null,
          createdAt: '2026-08-26T08:00:00.000Z',
          entries: [
            {
              side: 'A',
              student_no: '20260001',
              display_name: 'Demo Student',
              team_name: null,
              team_code: null,
            },
          ],
        },
      });
    }
    if (path.startsWith('/api/teacher/users')) return json({ items: [], total: 0, pageSize: 20 });
    if (path.startsWith('/api/teacher/teams')) return json({ items: [], total: 0, pageSize: 20 });
    if (path === '/api/teacher/leaderboard-periods') {
      return json({
        items: [
          {
            id: 'period-current',
            name: 'September Practice',
            startAt: '2026-09-01T00:00:00.000Z',
            endAt: '2026-10-01T00:00:00.000Z',
            status: 'active',
          },
        ],
      });
    }
    if (path === '/api/teacher/leaderboards/practice') {
      return json({
        period: {
          id: 'period-current',
          name: 'September Practice',
          startAt: '2026-09-01T00:00:00.000Z',
          endAt: '2026-10-01T00:00:00.000Z',
          status: 'active',
        },
        gradeLevel: url.searchParams.has('gradeLevel')
          ? Number(url.searchParams.get('gradeLevel'))
          : null,
        participantCount: 1,
        entries: [
          {
            rank: 1,
            studentId: 'student-1',
            studentNumber: '20260001',
            name: '张三',
            className: '六年级1班',
            gradeLevel: 6,
            score: 8192,
            maxTile: 1024,
            validMoveCount: 128,
            endedAt: '2026-09-03T08:00:00.000Z',
          },
        ],
      });
    }
    if (path === '/api/teacher/results') {
      return json({
        items: [
          {
            room_id: 'result-room-1',
            room_code: 'R2048',
            room_name: 'Final Round',
            mode: 'duel',
            duration_minutes: 5,
            finished_at: Date.parse('2026-08-26T08:05:00.000Z'),
            student_no: '20260001',
            display_name: 'Demo Student',
            class_name: 'Grade 6 Class 1',
            team_name: null,
            score: 2048,
            team_total_score: 2048,
            max_tile: 256,
            outcome: 'win',
          },
        ],
        total: 1,
        pageSize: 20,
      });
    }
    if (path === '/api/teacher/results/result-room-1') {
      return json({
        result: {
          id: 'result-room-1',
          code: 'R2048',
          name: 'Final Round',
          mode: 'duel',
          duration_minutes: 5,
          starts_at: Date.parse('2026-08-26T08:00:00.000Z'),
          finished_at: Date.parse('2026-08-26T08:05:00.000Z'),
          finish_reason: 'time_limit',
          winner_side: 'A',
          players: [
            {
              user_id: 'student-1',
              side: 'A',
              student_no: '20260001',
              display_name: 'Demo Student',
              class_name: 'Grade 6 Class 1',
              team_name: null,
              score: 2048,
              team_total_score: 2048,
              max_tile: 256,
              valid_move_count: 120,
              outcome: 'win',
            },
          ],
        },
      });
    }
    return json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404);
  });
}

test('teacher room management fits the viewport in both languages', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  await page.goto('/teacher/rooms');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '房间管理' : 'Room management',
  );
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll');
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBe(false);
  await page.getByRole('button', { name: locale === 'zh-CN' ? '创建房间' : 'Create room' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('spinbutton').fill('10');
  await page.screenshot({
    path: testInfo.outputPath(`teacher-rooms-${locale}.png`),
    fullPage: true,
  });
});

test('practice board accepts swipe on touch and keyboard on desktop', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  await page.goto('/student/practice');
  const board = page.getByRole('grid');
  const practiceClock = page.getByRole('timer');
  await expect(board).toBeVisible();
  await expect(practiceClock).toHaveAccessibleName(
    new RegExp(locale === 'zh-CN' ? '本局用时' : 'Session time', 'u'),
  );
  await expect(practiceClock.locator('strong')).toHaveText(/^\d{2,}:\d{2}$/u);
  const practiceClockBox = await practiceClock.boundingBox();
  const practiceBoardBox = await board.boundingBox();
  expect(practiceClockBox).not.toBeNull();
  expect(practiceBoardBox).not.toBeNull();
  expect(practiceClockBox!.y + practiceClockBox!.height).toBeLessThan(practiceBoardBox!.y);
  const fullscreenButton = page.getByRole('button', {
    name: locale === 'zh-CN' ? '全屏' : 'Fullscreen',
  });
  await fullscreenButton.click();
  const gameSurface = page.locator('.game-surface');
  await expect(gameSurface).toHaveClass(/is-fullscreen/u);
  await expect(gameSurface.locator('.game-statusbar')).toBeVisible();
  await expect(gameSurface.locator('.game-statusbar > strong')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(gameSurface).not.toHaveClass(/is-fullscreen/u);
  await expectUniformBoardCells(page);
  const before = await board.textContent();
  if (testInfo.project.use.hasTouch) {
    const box = await board.boundingBox();
    expect(box).not.toBeNull();
    await board.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: box!.x + box!.width * 0.8,
      clientY: box!.y + box!.height * 0.5,
    });
    await board.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: box!.x + box!.width * 0.2,
      clientY: box!.y + box!.height * 0.5,
    });
  } else {
    await page.keyboard.press('ArrowLeft');
  }
  await expect.poll(() => board.textContent()).not.toBe(before);
  if (testInfo.project.use.hasTouch) {
    const afterSwipe = await board.textContent();
    const box = await board.boundingBox();
    await board.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: box!.x + box!.width * 0.8,
      clientY: box!.y + box!.height * 0.5,
    });
    await board.dispatchEvent('pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: false,
      clientX: box!.x + box!.width * 0.7,
      clientY: box!.y + box!.height * 0.5,
    });
    await board.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: box!.x + box!.width * 0.2,
      clientY: box!.y + box!.height * 0.5,
    });
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      await page.keyboard.press(key);
    }
    await expect(board).toHaveText(afterSwipe ?? '');
  }
  await page.screenshot({ path: testInfo.outputPath(`practice-${locale}.png`), fullPage: true });
});

test('teacher can filter results and open match details', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  await page.goto('/teacher/results');
  await page
    .getByPlaceholder(locale === 'zh-CN' ? '按班级筛选' : 'Filter by class')
    .fill('Grade 6');
  await page.getByRole('button', { name: 'Final Round' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(
    locale === 'zh-CN' ? '到时结束' : 'Time limit',
  );
});

test('student can switch between the current overall and grade leaderboards', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  await page.goto('/student/results');
  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '本期榜单' : 'Current leaderboard' })
    .click();

  const leaderboard = page.locator('.leaderboard-section');
  await expect(leaderboard).toContainText('September Practice');
  await expect(leaderboard).toContainText('张*');
  await expect(leaderboard).toContainText('260001');
  await expect(leaderboard).toContainText(locale === 'zh-CN' ? '我' : 'Me');
  await expect(leaderboard).not.toContainText('张三');
  await expect(leaderboard).not.toContainText('20260001');

  await page.getByRole('tab', { name: locale === 'zh-CN' ? '年级榜' : 'My grade' }).click();
  await expect(leaderboard).toContainText('260024');
  await expect(leaderboard).toContainText('8');
});

test('teacher can review full practice rankings and open period management', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  await page.goto('/teacher/results');
  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '练习榜单' : 'Practice leaderboard' })
    .click();

  await expect(page.getByRole('heading', { name: 'September Practice' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '20260001' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '张三' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '128' })).toBeVisible();

  await page
    .getByRole('button', { name: locale === 'zh-CN' ? '创建周期' : 'Create period' })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('student can find a team and join a room lobby', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  await page.goto('/student/team');
  await page
    .getByPlaceholder(locale === 'zh-CN' ? '搜索团队名称或代码' : 'Search team name or code')
    .fill('Pioneer');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '查找团队' : 'Find a team' }).click();
  await page.getByRole('button', { name: locale === 'zh-CN' ? '加入团队' : 'Join team' }).click();
  await expect(page.getByRole('heading', { name: 'Pioneer Team' })).toBeVisible();

  await page.goto('/student/rooms');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '加入房间' : 'Join room' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '房间候场' : 'Room lobby',
  );
});

test('student can return to an active match from the room list', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    socket.onMessage(() => undefined);
  });
  await page.goto('/student/rooms');
  await page
    .getByRole('button', { name: locale === 'zh-CN' ? '返回比赛' : 'Return to match' })
    .click();
  await expect(page).toHaveURL(/\/student\/rooms\/room-1\/match$/u);
  const matchClock = page.getByRole('timer');
  const matchBoard = page.getByRole('grid');
  await expect(matchClock).toHaveAccessibleName(
    new RegExp(locale === 'zh-CN' ? '剩余时间' : 'Time remaining', 'u'),
  );
  await expect(matchClock.locator('strong')).toHaveText(/^\d{2}:\d{2}$/u);
  await expect(matchBoard).toBeVisible();
  const matchClockBox = await matchClock.boundingBox();
  const matchBoardBox = await matchBoard.boundingBox();
  expect(matchClockBox).not.toBeNull();
  expect(matchBoardBox).not.toBeNull();
  expect(matchClockBox!.y + matchClockBox!.height).toBeLessThan(matchBoardBox!.y);
  const fullscreenButton = page.getByRole('button', {
    name: locale === 'zh-CN' ? '全屏' : 'Fullscreen',
  });
  await fullscreenButton.click();
  const gameSurface = page.locator('.game-surface');
  await expect(gameSurface).toHaveClass(/is-fullscreen/u);
  await expect(gameSurface.locator('.game-statusbar')).toBeVisible();
  await expect(gameSurface.locator('.game-statusbar > strong')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(gameSurface).not.toHaveClass(/is-fullscreen/u);
});

test('language switches on the same URL and survives refresh', async ({ page }, testInfo) => {
  await mockApi(page, 'student', 'zh-CN');
  await page.goto('/student');
  const originalUrl = page.url();
  await page.locator('.topbar').getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My 2048');
  expect(page.url()).toBe(originalUrl);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('My 2048');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.screenshot({ path: testInfo.outputPath('language-persistence.png'), fullPage: true });
});

for (const role of ['teacher', 'student'] as const) {
  test(`${role} can change their own password from the account entry`, async ({
    page,
  }, testInfo) => {
    const locale = projectLocale(testInfo);
    await mockApi(page, role, locale);
    await page.goto(role === 'teacher' ? '/teacher' : '/student');
    await page
      .getByRole('link', {
        name: locale === 'zh-CN' ? '打开账号设置' : 'Open account settings',
      })
      .click();
    await expect(page).toHaveURL(/\/account\/password$/u);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      locale === 'zh-CN' ? '修改密码' : 'Change password',
    );
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBe(false);

    await page.locator('input[name="currentPassword"]').fill('current-password-value');
    await page.locator('input[name="newPassword"]').fill('new-password-value');
    await page.locator('input[name="confirmPassword"]').fill('different-password-value');
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '修改密码' : 'Change password' })
      .click();
    await expect(page.getByRole('alert')).toHaveText(
      locale === 'zh-CN' ? '两次输入的新密码不一致' : 'The new passwords do not match',
    );

    await page.locator('input[name="confirmPassword"]').fill('new-password-value');
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '修改密码' : 'Change password' })
      .click();
    await expect(page).toHaveURL(/\/login\?passwordChanged=1$/u);
    await expect(page.getByRole('status')).toHaveText(
      locale === 'zh-CN'
        ? '密码已修改，请使用新密码重新登录'
        : 'Password changed. Sign in again with your new password.',
    );
  });
}
