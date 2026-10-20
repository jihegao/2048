import { expect, test, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test';
import { applyMove, createGame } from '../../shared/game';
import { type Direction } from '../../shared/types';
import { SESSION_REPLACED_CLOSE_CODE, type RoomStatus } from '../../shared/types';

type Locale = 'zh-CN' | 'en';

function personalResultsFixture() {
  const summary = { played: 2, wins: 1, draws: 1, losses: 0, points: 4 };
  const period = {
    id: 'period-current',
    name: 'September Competition',
    startAt: '2026-09-01T00:00:00.000Z',
    endAt: '2026-10-01T00:00:00.000Z',
    status: 'active',
  };
  return {
    totalCount: 8,
    practiceBest: [
      {
        id: 'practice-best-1',
        score: 8192,
        maxTile: 1024,
        validMoveCount: 128,
        occurredAt: '2026-09-10T08:00:00.000Z',
      },
    ],
    timedPracticeBest: [],
    duel: {
      currentPeriod: {
        period,
        summary: { played: 1, wins: 1, draws: 0, losses: 0, points: 3 },
        items: [],
      },
      history: {
        summary,
        items: [
          {
            roomId: 'duel-result-1',
            roomName: 'Formal Duel',
            occurredAt: '2026-09-12T08:00:00.000Z',
            outcome: 'win',
            points: 3,
            opponent: {
              className: '六年级2班',
              maskedName: '张*',
              studentNumberSuffix: '260002',
            },
          },
        ],
      },
    },
    team: {
      currentPeriod: {
        period,
        summary: { played: 1, wins: 0, draws: 1, losses: 0, points: 1 },
        items: [],
      },
      history: {
        summary: { played: 1, wins: 0, draws: 1, losses: 0, points: 1 },
        items: [
          {
            roomId: 'team-result-1',
            roomName: 'Formal Team Match',
            occurredAt: '2026-09-13T08:00:00.000Z',
            outcome: 'draw',
            points: 1,
            team: { id: 'team-1', name: 'Pioneer Team' },
            opponentTeam: { id: 'team-2', name: 'Challenger Team' },
          },
        ],
      },
    },
  };
}

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
      const body = request.postDataJSON() as { currentPassword: string };
      if (body.currentPassword === 'wrong-current-password') {
        return json(
          { error: { code: 'CURRENT_PASSWORD_INCORRECT', message: '当前密码不正确' } },
          422,
        );
      }
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
        items: [
          {
            id: 'team-1',
            name: 'Pioneer Team',
            code: 'TEAM01',
            logo: 'lion',
            team_group: 'G6_12',
            member_count: 2,
            memberNames: ['张晨', '李悦'],
          },
        ],
      });
    }
    if (path === '/api/teams/team-1/join') {
      studentTeam = {
        id: 'team-1',
        name: 'Pioneer Team',
        code: 'TEAM01',
        logo: null,
        creatorId: 'teacher-1',
        isOwner: false,
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
    if (path === '/api/teams' && request.method() === 'POST') {
      const body = request.postDataJSON() as { name: string; logo: string };
      studentTeam = {
        id: 'team-2',
        name: body.name,
        code: 'TEAM02',
        logo: body.logo,
        creatorId: 'student-1',
        isOwner: true,
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
      return json({ ok: true, teamId: 'team-2', message: '团队已创建' }, 201);
    }
    if (/^\/api\/teams\/[^/]+$/.test(path) && request.method() === 'DELETE') {
      studentTeam = null;
      return json({ ok: true, message: '团队已解散' });
    }
    if (path === '/api/me/results') return json(personalResultsFixture());
    if (path === '/api/team-practice-periods/current') return json({ period: null });
    if (path === '/api/team-practice-periods' || path === '/api/teacher/team-practice-periods') {
      return json({
        items: [
          {
            id: 'team-period-current',
            name: 'September 3v3',
            status: 'open',
            created_at: Date.parse('2026-09-01T00:00:00.000Z'),
            closed_at: null,
            frozen_at: null,
          },
        ],
      });
    }
    if (
      path === '/api/team-practice-periods/team-period-current/results' ||
      path === '/api/teacher/team-practice-periods/team-period-current/results'
    ) {
      return json({
        period: { id: 'team-period-current', name: 'September 3v3', status: 'open' },
        standings: [
          {
            team_id: 'team-1',
            team_name_snapshot: 'Pioneer Team',
            wins: 1,
            draws: 1,
            losses: 0,
            points: 4,
            matches: 2,
          },
          {
            team_id: 'team-2',
            team_name_snapshot: 'Rival Team',
            wins: 0,
            draws: 1,
            losses: 1,
            points: 1,
            matches: 2,
          },
        ],
        matches: [],
      });
    }
    if (path === '/api/leaderboard') {
      const mode = url.searchParams.get('mode') ?? 'timed_3m';
      return json({
        status: 'available',
        mode,
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
              score: mode === 'unlimited' ? 12288 : 8192,
              gameCount: mode === 'unlimited' ? 1 : 10,
              maxTile: mode === 'unlimited' ? 1024 : null,
              isCurrentUser: false,
            },
            {
              rank: 21,
              className: '六年级1班',
              maskedName: '演示学*',
              studentNumberSuffix: '260024',
              score: mode === 'unlimited' ? 6144 : 4096,
              gameCount: mode === 'unlimited' ? 1 : 10,
              maxTile: mode === 'unlimited' ? 512 : null,
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
              score: mode === 'unlimited' ? 6144 : 4096,
              gameCount: mode === 'unlimited' ? 1 : 10,
              maxTile: mode === 'unlimited' ? 512 : null,
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
      const mode = url.searchParams.get('mode') ?? 'timed_3m';
      return json({
        mode,
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
            score: mode === 'unlimited' ? 12288 : 8192,
            gameCount: mode === 'unlimited' ? 1 : 10,
            maxTile: mode === 'unlimited' ? 1024 : null,
            validMoveCount: mode === 'unlimited' ? 128 : null,
            endedAt: mode === 'unlimited' ? '2026-09-03T08:00:00.000Z' : null,
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

test('teacher rooms default to unfinished and show history only when selected', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  const states = [
    'ended',
    'cancelled',
    ...Array.from({ length: 21 }, (_, i) => ['open', 'full', 'countdown', 'live'][i % 4]),
  ];
  const requests: URL[] = [];
  await page.route('**/api/teacher/rooms?**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const status = url.searchParams.get('status');
    const query = url.searchParams.get('query') ?? '';
    const currentPage = Number(url.searchParams.get('page'));
    const items = states
      .map((value, i) => ({
        id: `room-${i}`,
        code: `R${i}`,
        name: `Filter room ${i}`,
        mode: 'duel',
        status: value,
        durationMinutes: 5,
        participantCount: 0,
        participantCapacity: 2,
        lockedAt: null,
        startsAt: null,
        endsAt: null,
        createdAt: '2026-10-16T00:00:00Z',
      }))
      .filter(
        (room) =>
          (status === 'unfinished'
            ? !['ended', 'cancelled'].includes(room.status)
            : !status || room.status === status) && room.name.includes(query),
      );
    return route.fulfill({
      json: {
        items: items.slice((currentPage - 1) * 20, currentPage * 20),
        total: items.length,
        page: currentPage,
        pageSize: 20,
      },
    });
  });
  await page.goto('/teacher/rooms');
  const filter = page.getByRole('combobox', {
    name: locale === 'zh-CN' ? '状态' : 'Status',
    exact: true,
  });
  await expect(filter).toHaveValue('unfinished');
  await expect(page.getByText('Filter room 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Filter room 0', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Filter room 1', { exact: true })).toHaveCount(0);
  expect(requests[0].searchParams.get('status')).toBe('unfinished');
  await page
    .getByRole('button', { name: locale === 'zh-CN' ? '下一页' : 'Next', exact: true })
    .click();
  await expect(page.getByText('Filter room 22', { exact: true })).toBeVisible();
  await filter.selectOption('ended');
  await expect(page.getByText('Filter room 0', { exact: true })).toBeVisible();
  expect(requests.at(-1)!.searchParams.get('page')).toBe('1');
  await expect(page.getByText('Filter room 22', { exact: true })).toHaveCount(0);
  await filter.selectOption('');
  await expect(page.getByText('Filter room 0', { exact: true })).toBeVisible();
  await expect(page.getByText('Filter room 1', { exact: true })).toBeVisible();
  await filter.selectOption('unfinished');
  await page
    .getByRole('textbox', { name: locale === 'zh-CN' ? '搜索' : 'Search', exact: true })
    .fill('Filter room 22');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByText('Filter room 22', { exact: true })).toBeVisible();
  await page.reload();
  await expect(filter).toHaveValue('unfinished');
  await expect(page.getByText('Filter room 0', { exact: true })).toHaveCount(0);
});

for (const mode of ['1v1', '3v3'] as const) {
  test(`teacher ${mode} live arena keeps both score pillars and boards in view`, async ({
    page,
  }, testInfo) => {
    const isTeam = mode === '3v3';
    const locale = projectLocale(testInfo);
    await mockApi(page, 'teacher', locale);
    const now = Date.now();
    const game = {
      board: [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 0, 0, 0, 0, 2],
      score: 0,
      maxTile: 2,
      maxTileReachedAt: now,
      moveCount: 0,
      rngState: 123,
      seq: 0,
      status: 'playing',
    };
    const snapshot = (revision: number, scores: number[], roomStatus = 'live') => ({
      type: 'teacher-snapshot',
      roomId: 'room-1',
      roomStatus,
      serverTime: Date.now(),
      startsAt: now - 3000,
      endsAt: now + 60_000,
      revision,
      players: (isTeam
        ? scores
        : [
            scores.slice(0, 3).reduce((a, b) => a + b, 0),
            scores.slice(3).reduce((a, b) => a + b, 0),
          ]
      ).map((score, index) => ({
        userId: `student-${index}`,
        studentNumber: `S${index}`,
        name: `Player ${index + 1}`,
        className: null,
        teamName: index < 3 ? '一二三四五六七八九十' : 'Beta',
        teamLogo: index < (isTeam ? 3 : 1) ? 'icon1' : 'icon2',
        side: index < (isTeam ? 3 : 1) ? 1 : 2,
        online: true,
        game: { ...game, score },
      })),
    });
    let latest = snapshot(0, [0, 0, 0, 0, 0, 0]);
    await page.route('**/api/teacher/rooms/room-1/live', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(latest) }),
    );
    let serverSocket: WebSocketRoute | null = null;
    let connections = 0;
    await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
      serverSocket = socket;
      connections += 1;
      socket.send(JSON.stringify(latest));
      socket.onMessage(() => undefined);
    });
    await page.goto('/teacher/rooms/room-1/live');
    await expect(page.locator('.live-arena')).toBeVisible();
    await expect(page.locator('.live-team-row .game-board')).toHaveCount(isTeam ? 6 : 2);
    await expect(page.locator('.live-pillar__fill')).toHaveCount(2);
    await expect(page.locator('.live-pillar__fill').first()).toHaveAttribute(
      'style',
      'height: 0%;',
    );

    const send = (revision: number, scores: number[], status = 'live') => {
      latest = snapshot(revision, scores, status);
      if (!serverSocket) throw new Error('WebSocket did not connect');
      serverSocket.send(JSON.stringify(latest));
    };
    send(1, [10, 20, 30, 5, 15, 25]);
    await expect(page.locator('.live-pillar--1 .live-pillar__score')).toHaveText('60');
    await expect(page.locator('.live-pillar--2 .live-pillar__score')).toHaveText('45');
    const heights = async () =>
      page
        .locator('.live-pillar__fill')
        .evaluateAll((fills) =>
          fills.map((fill) => Number.parseFloat((fill as HTMLElement).style.height)),
        );
    expect((await heights())[0]).toBeGreaterThan((await heights())[1]);
    send(2, [10, 20, 30, 20, 20, 20]);
    await expect(page.locator('.live-pillar--2 .live-pillar__score')).toHaveText('60');
    expect((await heights())[0]).toBe((await heights())[1]);
    send(3, [10, 20, 30, 30, 30, 30]);
    await expect(page.locator('.live-pillar--2 .live-pillar__score')).toHaveText('90');
    expect((await heights())[1]).toBeGreaterThan((await heights())[0]);
    send(1, [999, 999, 999, 0, 0, 0]);
    await expect(page.locator('.live-pillar--1 .live-pillar__score')).toHaveText('60');

    const beforeReconnect = connections;
    if (!serverSocket) throw new Error('WebSocket did not connect');
    serverSocket.close({ code: 1012, reason: 'Restart' });
    await expect.poll(() => connections, { timeout: 5000 }).toBeGreaterThan(beforeReconnect);
    await expect(page.locator('.live-pillar--2 .live-pillar__score')).toHaveText('90');
    send(4, [10, 20, 30, 30, 30, 30], 'ended');
    await expect(page.locator('.live-pillar--2 .live-pillar__score')).toHaveText('90');
    await page
      .getByRole('button', {
        name: `${locale === 'zh-CN' ? '放大查看棋盘' : 'Enlarge board'} Player 1`,
      })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: locale === 'zh-CN' ? '关闭' : 'Close' }).click();

    await page.setViewportSize({ width: 1920, height: 1080 });
    const lowPlatform = await page.locator('.live-pillar--1 .live-pillar__platform').boundingBox();
    send(5, [4096, 4096, 4096, 8192, 8192, 8192], 'ended');
    await expect(page.locator('.live-pillar--1 .live-pillar__score')).toHaveText('12288');
    await expect(page.locator('.live-pillar--1 img')).toHaveAttribute(
      'src',
      '/team-logos/icon1.svg',
    );
    const digitSizes = await page
      .locator('.live-pillar--1 .live-pillar__score i')
      .evaluateAll((elements) => elements.map((el) => parseFloat(getComputedStyle(el).fontSize)));
    expect(digitSizes[0]).toBeGreaterThan(digitSizes[1]);
    expect(digitSizes[2]).toBe(digitSizes[0]);
    expect(digitSizes[3]).toBe(digitSizes[1]);
    expect(digitSizes[4]).toBe(digitSizes[0]);
    await expect(page.locator('.live-pillar--1 .live-pillar__name')).toHaveText(
      isTeam ? '一二三四五六七八九十' : 'Player 1',
    );
    const nameFits = async () =>
      page
        .locator('.live-pillar--1 .live-pillar__name')
        .evaluate(
          (el) =>
            el.scrollHeight <= el.clientHeight + 1 &&
            el.scrollWidth <= el.clientWidth + 1 &&
            getComputedStyle(el).whiteSpace === 'nowrap',
        );
    expect(await nameFits()).toBe(true);
    const firstBoard = page.locator('.live-team-row .game-board').first();
    await expect(firstBoard).toHaveCSS('background-color', 'rgb(187, 173, 160)');
    await expect(firstBoard.locator('.game-tile--2').first()).toHaveCSS(
      'background-color',
      'rgb(238, 228, 218)',
    );
    await expect(firstBoard.locator('.game-tile--8')).toHaveCSS(
      'background-color',
      'rgb(242, 177, 121)',
    );
    await expect(firstBoard.locator('.game-tile--64')).toHaveCSS(
      'background-color',
      'rgb(246, 94, 59)',
    );
    await expect(firstBoard.locator('.game-tile--2048')).toHaveCSS(
      'background-color',
      'rgb(237, 194, 46)',
    );

    await expect
      .poll(
        async () => (await page.locator('.live-pillar--1 .live-pillar__platform').boundingBox())!.y,
      )
      .toBeLessThan(lowPlatform!.y - 100);
    for (const side of [1, 2]) {
      await expect
        .poll(async () => {
          const fill = await page.locator(`.live-pillar--${side} .live-pillar__fill`).boundingBox();
          const platform = await page
            .locator(`.live-pillar--${side} .live-pillar__platform`)
            .boundingBox();
          return Math.abs(fill!.y - platform!.y - platform!.height);
        })
        .toBeLessThan(2);
    }
    const enter = page.getByRole('button', {
      name: locale === 'zh-CN' ? '全屏' : 'Fullscreen',
      exact: true,
    });
    await enter.click();
    await expect(page.locator('.live-view')).toHaveClass(/is-fullscreen/);
    expect(await nameFits()).toBe(true);
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.live-view')).not.toHaveClass(/is-fullscreen/);
    await page.evaluate(() => {
      HTMLElement.prototype.requestFullscreen = async () => {
        throw new Error('Denied');
      };
    });
    await enter.click();
    await expect(page.locator('.live-view')).toHaveClass(/is-fullscreen/);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: locale === 'zh-CN' ? '原生全屏' : 'Native fullscreen' }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '退出全屏' : 'Exit fullscreen' })
      .click();
    await expect(page.locator('.live-view')).not.toHaveClass(/is-fullscreen/);

    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      const bounds = await page.locator('.live-arena').boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({
        path: testInfo.outputPath(`teacher-live-${mode}-${locale}-${viewport.width}.png`),
        fullPage: true,
      });
    }
  });
}

test('student match combines the local personal score with uploaded team contributions', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
  const now = Date.now();
  let mode: 'duel' | 'team_3v3' = 'duel';
  const state = () => ({
    type: 'state',
    roomId: 'room-1',
    roomStatus: 'live',
    serverTime: Date.now(),
    startsAt: now - 3000,
    endsAt: now + 60_000,
    canControl: true,
    game: {
      board: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      score: 0,
      maxTile: 2,
      maxTileReachedAt: now,
      moveCount: 0,
      rngState: 123,
      seq: 0,
      status: 'playing',
    },
    scores: {
      mode,
      side: 1,
      sideScores: { 1: 0, 2: 0 },
      ownScore: 0,
      revision: 0,
    },
  });
  await page.route('**/api/rooms/room-1/match', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state()) }),
  );
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket('**/api/rooms/*/ws', (routeSocket) => {
    socket = routeSocket;
    routeSocket.send(JSON.stringify(state()));
    routeSocket.onMessage(() => undefined);
  });
  await page.goto('/student/rooms/room-1/match');
  await expect(page.locator('.match-scores')).toBeVisible();
  const own = page.locator('.match-scores__side').first();
  const opponent = page.locator('.match-scores__side').last();
  await expect(own.locator('strong')).toHaveText('0');
  await expect(opponent.locator('strong')).toHaveText('0');
  if (!socket) throw new Error('WebSocket did not connect');
  socket.send(
    JSON.stringify({
      type: 'score-summary',
      roomId: 'room-1',
      scores: { mode: 'duel', side: 1, sideScores: { 1: 0, 2: 16 }, ownScore: 0, revision: 1 },
    }),
  );
  await expect(opponent.locator('strong')).toHaveText('16');
  await expect(own.locator('strong')).toHaveText('0');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  const localScore = Number(await page.locator('.score-strip strong').first().textContent());
  expect(localScore).toBeGreaterThan(0);
  socket.send(
    JSON.stringify({
      type: 'score-summary',
      roomId: 'room-1',
      scores: { mode: 'duel', side: 1, sideScores: { 1: 32, 2: 16 }, ownScore: 32, revision: 2 },
    }),
  );
  await expect(own.locator('strong')).toHaveText(String(localScore));

  mode = 'team_3v3';
  await page.reload();
  await expect(page.locator('.match-scores__personal')).toBeVisible();
  await expect(
    page.getByText(
      locale === 'zh-CN' ? '实时连接已断开，正在重试' : 'Live connection lost; retrying',
    ),
  ).toHaveCount(0);
  if (!socket) throw new Error('WebSocket did not connect');
  socket.send(
    JSON.stringify({
      type: 'score-summary',
      roomId: 'room-1',
      scores: { mode, side: 1, sideScores: { 1: 60, 2: 45 }, ownScore: 20, revision: 1 },
    }),
  );
  await expect(own.locator('strong')).toHaveText(String(40 + localScore));
  await expect(opponent.locator('strong')).toHaveText('45');
  await expect(page.locator('.match-scores__personal')).toContainText(String(localScore));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.screenshot({
    path: testInfo.outputPath(`student-team-scores-${locale}.png`),
    fullPage: true,
  });
  await page.getByRole('button', { name: locale === 'zh-CN' ? '全屏' : 'Fullscreen' }).click();
  await expect(page.locator('.game-surface.is-fullscreen .match-scores')).toBeVisible();
  await expect(page.locator('.game-surface.is-fullscreen .game-board')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`student-team-scores-fullscreen-${locale}.png`),
  });
});

test('timed practice responds during slow uploads and reconciles keyboard and touch input', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  const now = Date.now();
  let session = {
    id: 'timed-session-1',
    seed: 1,
    seq: 0,
    snapshot: createGame(1, now),
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 180_000).toISOString(),
    serverNow: new Date(now).toISOString(),
  };
  let predicted = session.snapshot;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batches: Array<{ seq: number; directions: Direction[] }> = [];
  await page.route('**/api/practice/timed/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/current')) return route.fulfill({ json: { status: 'active', session } });
    if (path.endsWith('/moves')) {
      const batch = route.request().postDataJSON() as { seq: number; directions: Direction[] };
      batches.push(batch);
      let snapshot = session.snapshot;
      for (const direction of batch.directions) snapshot = applyMove(snapshot, direction).snapshot;
      session = {
        ...session,
        seq: batch.seq + batch.directions.length - 1,
        snapshot,
        serverNow: new Date().toISOString(),
      };
      const response = { status: 'active', session };
      if (batches.length === 1) await gate;
      return route.fulfill({ json: response });
    }
    return route.abort();
  });
  await page.goto('/student/practice');
  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '3 分钟限时练习' : 'Three-minute practice' })
    .click();
  const board = page.getByRole('grid');
  await expect(board).toBeVisible();
  const cells = () => page.locator('.game-tile').allTextContents();
  async function move(touch: boolean) {
    const direction = (['left', 'down', 'right', 'up'] as Direction[]).find(
      (direction) => applyMove(predicted, direction).moved,
    )!;
    predicted = applyMove(predicted, direction).snapshot;
    if (touch) {
      const box = (await board.boundingBox())!;
      const deltas = { left: [-100, 0], right: [100, 0], up: [0, -100], down: [0, 100] };
      const [dx, dy] = deltas[direction];
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
    } else await page.keyboard.press(`Arrow${direction[0].toUpperCase()}${direction.slice(1)}`);
    await expect.poll(cells).toEqual(predicted.board.map((value) => (value ? String(value) : '')));
    await expect(board).not.toHaveClass(/is-disabled/);
  }
  await move(false);
  await expect.poll(() => batches.length).toBe(1);
  await move(true);
  await move(false);
  await move(false);
  // The first server response is still withheld while all four moves are visible.
  expect(batches).toHaveLength(1);
  release();
  await expect.poll(() => session.seq).toBe(4);
  await expect.poll(cells).toEqual(predicted.board.map((value) => (value ? String(value) : '')));
  expect(session.snapshot.board).toEqual(predicted.board);
  expect(batches[1]).toMatchObject({ seq: 2, directions: expect.any(Array) });
  await page.screenshot({ path: testInfo.outputPath(`timed-practice-${locale}.png`) });
});

test('team match management keeps rooms focused and preserves the period across views', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  const period = {
    id: 'history-period',
    name: 'August 3v3',
    status: 'frozen',
    created_at: Date.parse('2026-08-01T00:00:00Z'),
    closed_at: Date.parse('2026-08-30T00:00:00Z'),
    frozen_at: Date.parse('2026-08-30T01:00:00Z'),
  };
  const current = {
    ...period,
    id: 'current-period',
    name: 'September 3v3',
    status: 'open',
    closed_at: null,
    frozen_at: null,
  };
  const resultRequests: string[] = [];
  await page.route('**/api/teacher/team-practice-periods**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/teacher/team-practice-periods') return json({ items: [current, period] });
    resultRequests.push(path);
    const selected = path.includes('history-period') ? period : current;
    return json({
      period: selected,
      standings: [
        {
          team_id: 'team-1',
          team_name_snapshot: `${selected.name} Winners`,
          wins: 2,
          draws: 1,
          losses: 0,
          matches: 3,
          points: 7,
        },
      ],
      matches: [
        {
          room_id: 'match-1',
          team_id: 'team-1',
          team_name_snapshot: `${selected.name} Winners`,
          outcome: 'win',
          points: 3,
          team_score: 2048,
          started_at: period.created_at,
        },
      ],
    });
  });
  const labels =
    locale === 'zh-CN'
      ? {
          manage: '管理 →',
          periods: '团队练习期',
          standings: '团队榜单',
          matches: '团队对战明细',
          selector: '练习期名称',
          close: '关闭练习期',
        }
      : {
          manage: 'Manage →',
          periods: 'Team practice periods',
          standings: 'Team leaderboard',
          matches: 'Team match details',
          selector: 'Period name',
          close: 'Close period',
        };
  await page.goto('/teacher/rooms');
  await expect(page.locator('.team-practice-summary')).toContainText('September 3v3');
  await expect(
    page.getByRole('heading', {
      name: locale === 'zh-CN' ? '团队对战练习期' : 'Team practice periods',
    }),
  ).toHaveCount(0);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  expect(resultRequests).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath(`focused-rooms-${locale}.png`),
    fullPage: true,
  });
  await page.getByRole('link', { name: labels.manage }).click();
  await expect(page.getByRole('tab', { name: labels.periods, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: labels.close })).toBeVisible();
  expect(resultRequests).toEqual([]);
  await page.getByRole('combobox', { name: labels.selector }).selectOption('history-period');
  await expect(page.getByRole('button', { name: labels.close })).toHaveCount(0);
  await page
    .getByRole('link', { name: locale === 'zh-CN' ? '查看积分榜' : 'View standings' })
    .last()
    .click();
  await expect(page).toHaveURL(/\/teacher\/results\?view=teamStandings/);
  await expect(page.getByRole('button', { name: labels.close })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'August 3v3 Winners' })).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: locale === 'zh-CN' ? '胜' : 'Wins', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: labels.selector })).toHaveValue('history-period');
  await expect(page.getByRole('table')).toHaveCount(1);
  await page.getByRole('tab', { name: labels.matches }).click();
  await expect(page.getByRole('cell', { name: '2,048', exact: true })).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: locale === 'zh-CN' ? '开赛时间' : 'Started at' }),
  ).toBeVisible();
  await expect(page.getByRole('combobox', { name: labels.selector })).toHaveValue('history-period');
  await expect(page.getByRole('table')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('tab', { name: labels.matches })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('combobox', { name: labels.selector })).toHaveValue('history-period');
  await page.goBack();
  await expect(page.getByRole('tab', { name: labels.standings })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('cell', { name: 'August 3v3 Winners' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath(`team-match-standings-${locale}.png`),
    fullPage: true,
  });
});

test('old team links redirect to seasons or unified results and preserve match details', async ({
  page,
}, testInfo) => {
  const zh = projectLocale(testInfo) === 'zh-CN';
  await mockApi(page, 'teacher', projectLocale(testInfo));
  await page.route('**/api/teacher/team-practice-periods/team-period-current/results', (route) =>
    route.fulfill({
      json: {
        period: { id: 'team-period-current', name: 'September 3v3', status: 'open' },
        standings: [],
        matches: [
          {
            room_id: 'result-room-1',
            team_id: 'team-1',
            team_name_snapshot: 'Pioneer Team',
            outcome: 'win',
            points: 3,
            team_score: 2048,
            started_at: Date.parse('2026-09-01T00:00:00Z'),
          },
        ],
      },
    }),
  );
  await page.goto('/teacher/team-practice');
  await expect(page).toHaveURL(/\/teacher\/seasons\?type=team/);
  await expect(
    page.getByRole('heading', { name: zh ? '赛季管理' : 'Season management', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: zh ? '团队榜单' : 'Team leaderboard' })).toHaveCount(
    0,
  );
  await page.goto('/teacher/team-practice?view=standings&periodId=team-period-current');
  await expect(page).toHaveURL(
    /\/teacher\/results\?view=teamStandings&periodId=team-period-current/,
  );
  await expect(page.getByRole('button', { name: zh ? '关闭练习期' : 'Close period' })).toHaveCount(
    0,
  );
  await page.goto('/teacher/team-practice?view=matches&periodId=team-period-current');
  await expect(page).toHaveURL(/\/teacher\/results\?view=teamMatches&periodId=team-period-current/);
  await page
    .getByRole('link', { name: zh ? '查看比赛详情' : 'View match details', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Final Round');
  await page.reload();
  await expect(page.getByRole('dialog')).toContainText('Final Round');
  await page.getByRole('dialog').getByRole('button').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('tab', { name: zh ? '团队对战明细' : 'Team match details' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: zh ? '练习期名称' : 'Period name' })).toHaveValue(
    'team-period-current',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('unified-team-results.png'), fullPage: true });
});

test('teacher can open and close a team practice period', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  const now = Date.now();
  let period: {
    id: string;
    name: string;
    status: 'open' | 'frozen';
    created_at: number;
    closed_at: number | null;
    frozen_at: number | null;
  } | null = null;
  await page.route('**/api/teacher/team-practice-periods**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/teacher/team-practice-periods' && method === 'GET') {
      return json({ items: period ? [period] : [] });
    }
    if (path === '/api/teacher/team-practice-periods' && method === 'POST') {
      const body = route.request().postDataJSON() as { name: string };
      period = {
        id: 'period-1',
        name: body.name,
        status: 'open',
        created_at: now,
        closed_at: null,
        frozen_at: null,
      };
      return json({ period }, 201);
    }
    if (path === '/api/teacher/team-practice-periods/period-1/results') {
      return json({ period, standings: [], matches: [] });
    }
    if (path === '/api/teacher/team-practice-periods/period-1/close' && method === 'POST') {
      period = { ...period!, status: 'frozen', closed_at: now, frozen_at: now };
      return json({ period });
    }
    return route.abort();
  });

  await page.goto('/teacher/team-practice');
  await expect(
    page.getByRole('heading', {
      name: locale === 'zh-CN' ? '团队对战练习期' : 'Team practice periods',
    }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: locale === 'zh-CN' ? '练习期名称' : 'Period name' })
    .fill('Autumn Practice');
  await page
    .getByRole('button', { name: locale === 'zh-CN' ? '开启练习期' : 'Open period' })
    .click();
  await expect(
    page.getByRole('combobox', { name: locale === 'zh-CN' ? '练习期名称' : 'Period name' }),
  ).toHaveValue('period-1');
  expect(period?.name).toBe('Autumn Practice');
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('button', { name: locale === 'zh-CN' ? '关闭练习期' : 'Close period' })
    .click();
  await expect(
    page.getByRole('cell', { name: locale === 'zh-CN' ? '已冻结' : 'Frozen', exact: true }),
  ).toBeVisible();
  expect(period?.status).toBe('frozen');
  await page.screenshot({ path: testInfo.outputPath(`teacher-team-practice-${locale}.png`) });
});

test('a complete team sees student room creation during an open practice period', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  const team = {
    id: 'team-1',
    name: 'Alpha',
    code: 'TEAM01',
    logo: 'icon2',
    members: [{ id: 'student-1' }, { id: 'student-2' }, { id: 'student-3' }],
  };
  await page.route('**/api/me/team', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ team }) }),
  );
  await page.route('**/api/team-practice-periods/current', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ period: { id: 'period-1', name: 'Autumn Practice' } }),
    }),
  );
  let created: Record<string, unknown> | null = null;
  await page.route('**/api/rooms', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    created = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ room: { id: 'room-2' } }),
    });
  });
  await page.route('**/api/rooms/room-2', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        room: {
          id: 'room-2',
          name: 'Alpha Challenge',
          mode: 'team_3v3',
          durationMinutes: 5,
          status: 'open',
          isParticipant: true,
          studentCreated: true,
          createdBy: 'student-1',
          isCreatorTeamMember: true,
          entries: [
            {
              side: 'A',
              student_no: null,
              display_name: null,
              team_name: 'Alpha',
              team_code: 'TEAM01',
            },
          ],
        },
      }),
    }),
  );
  await page.routeWebSocket('**/api/rooms/room-2/ws', (socket) => {
    socket.onMessage(() => undefined);
  });

  await page.goto('/student');
  await expect(page.getByText('Autumn Practice')).toBeVisible();
  await page
    .getByRole('textbox', { name: locale === 'zh-CN' ? '房间名称' : 'Room name' })
    .fill('Alpha Challenge');
  await page
    .getByRole('button', {
      name: locale === 'zh-CN' ? '创建 3v3 练习房间' : 'Create 3v3 practice room',
    })
    .click();
  await expect(page).toHaveURL(/\/student\/rooms\/room-2$/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '房间候场' : 'Room lobby',
  );
  await expect(
    page.getByRole('button', { name: locale === 'zh-CN' ? '取消房间' : 'Cancel room' }),
  ).toBeVisible();
  expect(created).toEqual({ name: 'Alpha Challenge', durationMinutes: 5 });
  await page.screenshot({ path: testInfo.outputPath(`student-team-room-${locale}.png`) });
});

test('a delayed bootstrap session check cannot override a successful login', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  const user = {
    id: 'student-1',
    loginId: '20260001',
    studentNumber: '20260001',
    name: 'Demo Student',
    className: 'Grade 6 Class 1',
    gradeLevel: 6,
    role: 'student' as const,
    locale,
  };
  const releaseBootstrapChecks: Array<() => void> = [];
  let bootstrapChecksReturned = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === '/api/me' && request.method() === 'GET') {
      await new Promise<void>((resolve) => {
        releaseBootstrapChecks.push(resolve);
      });
      bootstrapChecksReturned += 1;
      return json({ user: null });
    }
    if (path === '/api/auth/cookie-check') return json({ challenge: 'fixture' });
    if (path === '/api/auth/cookie-check/confirm') return json({ supported: true });
    if (path === '/api/auth/session-confirm') return json({ state: 'valid', user });
    if (path === '/api/auth/login' && request.method() === 'POST') return json({ user });
    if (path === '/api/me/team') return json({ team: null });
    if (path === '/api/rooms') return json({ items: [], total: 0, pageSize: 20 });
    if (path === '/api/me/results') return json(personalResultsFixture());
    if (path === '/api/team-practice-periods/current') return json({ period: null });
    return json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404);
  });

  await page.goto('/login');
  await page.locator('input[name="loginId"]').fill(user.loginId);
  await page.locator('input[name="password"]').fill('test-password-value');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '登录' : 'Sign in' }).click();
  await expect(page).toHaveURL(/\/student$/u);

  releaseBootstrapChecks.forEach((release) => release());
  await expect.poll(() => bootstrapChecksReturned).toBe(releaseBootstrapChecks.length);
  await expect(page).toHaveURL(/\/student$/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '我的 2048' : 'My 2048',
  );
});

test('a delayed bootstrap 401 cannot expire a successful login', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  const user = {
    id: 'student-1',
    loginId: '20260001',
    studentNumber: '20260001',
    name: 'Demo Student',
    className: 'Grade 6 Class 1',
    gradeLevel: 6,
    role: 'student' as const,
    locale,
  };
  const releaseBootstrapChecks: Array<() => void> = [];
  let bootstrapChecksReturned = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === '/api/me' && request.method() === 'GET') {
      await new Promise<void>((resolve) => {
        releaseBootstrapChecks.push(resolve);
      });
      bootstrapChecksReturned += 1;
      return json({ error: { code: 'AUTH_REQUIRED', message: '请先登录' } }, 401);
    }
    if (path === '/api/auth/cookie-check') return json({ challenge: 'fixture' });
    if (path === '/api/auth/cookie-check/confirm') return json({ supported: true });
    if (path === '/api/auth/session-confirm') return json({ state: 'valid', user });
    if (path === '/api/auth/login' && request.method() === 'POST') return json({ user });
    if (path === '/api/me/team') return json({ team: null });
    if (path === '/api/rooms') return json({ items: [], total: 0, pageSize: 20 });
    if (path === '/api/me/results') return json(personalResultsFixture());
    if (path === '/api/team-practice-periods/current') return json({ period: null });
    return json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404);
  });

  await page.goto('/login');
  await page.locator('input[name="loginId"]').fill(user.loginId);
  await page.locator('input[name="password"]').fill('test-password-value');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '登录' : 'Sign in' }).click();
  await expect(page).toHaveURL(/\/student$/u);

  releaseBootstrapChecks.forEach((release) => release());
  await expect.poll(() => bootstrapChecksReturned).toBe(releaseBootstrapChecks.length);
  await expect(page).toHaveURL(/\/student$/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '我的 2048' : 'My 2048',
  );
});

for (const sessionState of [
  'valid',
  'delayed-valid',
  'refresh-delayed',
  'expired',
  'network-error',
] as const) {
  test(`homepage 401 revalidates the current cookie: ${sessionState}`, async ({
    page,
  }, testInfo) => {
    const locale = projectLocale(testInfo);
    await mockApi(page, 'student', locale);
    await page.goto('/student');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const viewTeam = page.getByRole('link', { name: locale === 'zh-CN' ? '查看' : 'View' }).first();
    await expect(viewTeam).toBeVisible();

    let checks = 0;
    await page.route('**/api/me', (route) => {
      checks += 1;
      if (sessionState === 'valid') return route.fallback();
      if (sessionState === 'delayed-valid' && checks > 2) return route.fallback();
      if (sessionState === 'refresh-delayed' && (checks === 1 || checks > 3))
        return route.fallback();
      if (sessionState === 'network-error') return route.abort('failed');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: null }),
      });
    });
    await page.route('**/api/me/team', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'AUTH_REQUIRED', message: '请先登录' } }),
      }),
    );
    await viewTeam.click();
    await expect.poll(() => checks).toBeGreaterThan(0);
    if (sessionState === 'expired') {
      await expect(page).toHaveURL(/\/login$/u, { timeout: 25_000 });
      await expect(
        page.getByText(
          locale === 'zh-CN'
            ? '登录已失效，请重新登录'
            : 'Your session expired. Please sign in again.',
        ),
      ).toBeVisible();
    } else {
      await expect(page.getByText('请先登录')).toBeVisible({ timeout: 10_000 });
      if (sessionState === 'refresh-delayed')
        await expect.poll(() => checks, { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
      await expect(page).toHaveURL(/\/student\/team$/u);
      await expect(
        page.getByText(
          locale === 'zh-CN'
            ? '登录已失效，请重新登录'
            : 'Your session expired. Please sign in again.',
        ),
      ).toHaveCount(0);
    }
  });
}

test('a failed login restores an existing session once the bootstrap resolves', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  const user = {
    id: 'student-1',
    loginId: '20260001',
    studentNumber: '20260001',
    name: 'Demo Student',
    className: 'Grade 6 Class 1',
    gradeLevel: 6,
    role: 'student' as const,
    locale,
  };
  const releaseBootstrapChecks: Array<() => void> = [];
  let meCalls = 0;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === '/api/me' && request.method() === 'GET') {
      meCalls += 1;
      if (meCalls <= 2) {
        // Both StrictMode bootstrap calls hang until the login attempt.
        await new Promise<void>((resolve) => {
          releaseBootstrapChecks.push(resolve);
        });
      }
      return json({ user });
    }
    if (path === '/api/auth/cookie-check') return json({ challenge: 'fixture' });
    if (path === '/api/auth/cookie-check/confirm') return json({ supported: true });
    if (path === '/api/auth/login' && request.method() === 'POST') {
      return json(
        { error: { code: 'LOGIN_RATE_LIMITED', message: '登录尝试过多，请稍后再试' } },
        429,
      );
    }
    if (path === '/api/me/team') return json({ team: null });
    if (path === '/api/rooms') return json({ items: [], total: 0, pageSize: 20 });
    if (path === '/api/me/results') return json(personalResultsFixture());
    if (path === '/api/team-practice-periods/current') return json({ period: null });
    return json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404);
  });

  await page.goto('/login');
  await page.locator('input[name="loginId"]').fill(user.loginId);
  await page.locator('input[name="password"]').fill('wrong-password-value');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '登录' : 'Sign in' }).click();
  // The failed login triggers a session re-check (also gated); release all.
  await expect.poll(() => meCalls).toBeGreaterThanOrEqual(3);
  releaseBootstrapChecks.forEach((release) => release());
  await expect(page).toHaveURL(/\/student$/u);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '我的 2048' : 'My 2048',
  );
});

test('a socket auth refresh cannot restore the user after logout completes', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  const user = {
    id: 'student-1',
    loginId: '20260001',
    studentNumber: '20260001',
    name: 'Demo Student',
    className: 'Grade 6 Class 1',
    gradeLevel: 6,
    role: 'student' as const,
    locale,
  };
  await mockApi(page, 'student', locale);
  await page.goto('/student');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  let markLogoutStarted!: () => void;
  const logoutStarted = new Promise<void>((resolve) => {
    markLogoutStarted = resolve;
  });
  let releaseLogout!: () => void;
  const logoutRelease = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  await page.route('**/api/auth/logout', async (route) => {
    markLogoutStarted();
    await logoutRelease;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  let markRefreshStarted!: () => void;
  const refreshStarted = new Promise<void>((resolve) => {
    markRefreshStarted = resolve;
  });
  let releaseRefresh!: () => void;
  const refreshRelease = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route('**/api/me', async (route) => {
    markRefreshStarted();
    await refreshRelease;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user }),
    });
  });

  await page.locator('.topbar__logout').evaluate((button: HTMLButtonElement) => button.click());
  await logoutStarted;
  await page.evaluate(() => window.dispatchEvent(new Event('auth:refresh')));
  await refreshStarted;
  releaseLogout();
  await expect(page).toHaveURL(/\/login$/u);
  releaseRefresh();
  await page.waitForTimeout(100);
  await expect(page).toHaveURL(/\/login$/u);
  await expect(
    page.getByRole('button', { name: locale === 'zh-CN' ? '登录' : 'Sign in' }),
  ).toBeVisible();
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
    exact: true,
  });
  await fullscreenButton.click();
  const gameSurface = page.locator('.game-surface');
  await expect(gameSurface).toHaveClass(/is-fullscreen/u);
  await expect(gameSurface.locator('.game-statusbar')).toBeVisible();
  await expect(gameSurface.locator('.game-statusbar > strong')).toHaveCount(2);
  const exitOverlapsStatusbar = await page.evaluate(() => {
    const button = document.querySelector('.fullscreen-exit');
    if (!button) return true;
    const buttonBox = button.getBoundingClientRect();
    const strongs = [...document.querySelectorAll('.game-statusbar > strong')];
    return strongs.some((element) => {
      const box = element.getBoundingClientRect();
      return (
        box.left < buttonBox.right &&
        buttonBox.left < box.right &&
        box.top < buttonBox.bottom &&
        buttonBox.top < box.bottom
      );
    });
  });
  expect(exitOverlapsStatusbar).toBe(false);
  await page.keyboard.press('Escape');
  await expect(gameSurface).not.toHaveClass(/is-fullscreen/u);
  await fullscreenButton.click();
  await expect(gameSurface).toHaveClass(/is-fullscreen/u);
  const exitButton = gameSurface.getByRole('button', {
    name: locale === 'zh-CN' ? '退出全屏' : 'Exit fullscreen',
  });
  await expect(exitButton).toBeVisible();
  await exitButton.click();
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
    await expect(board).toHaveText(afterSwipe ?? ''); // cancelled gesture must not move
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => board.textContent()).not.toBe(afterSwipe);
  }
  await page.screenshot({ path: testInfo.outputPath(`practice-${locale}.png`), fullPage: true });
});

test('practice help opens in a new page without resetting the current game', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await page.context().route('**/api/me', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 'student-1',
          loginId: '20260001',
          studentNumber: '20260001',
          name: 'Demo Student',
          className: 'Grade 6 Class 1',
          gradeLevel: 6,
          role: 'student',
          locale,
        },
      }),
    }),
  );
  await mockApi(page, 'student', locale);
  await page.goto('/student/practice');
  const board = page.getByRole('grid');
  await expect(board).toBeVisible();
  const originalBoard = await board.textContent();
  const helpLink = page.getByRole('link', {
    name: locale === 'zh-CN' ? '查看玩法说明（在新页面打开）' : 'How to play (opens in a new page)',
  });
  await expect(helpLink).toHaveAttribute('target', '_blank');

  const [helpPage] = await Promise.all([page.context().waitForEvent('page'), helpLink.click()]);
  await expect(helpPage).toHaveURL(/\/student\/practice\/help$/u);
  await expect(helpPage.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '2048 游戏玩法' : 'How to play 2048',
  );
  await expect(
    helpPage.getByText(locale === 'zh-CN' ? '如何合并与得分' : 'Merge and score'),
  ).toBeVisible();
  await helpPage.screenshot({
    path: testInfo.outputPath(`practice-help-${locale}.png`),
    fullPage: true,
  });
  await expect(page).toHaveURL(/\/student\/practice$/u);
  await expect(board).toHaveText(originalBoard ?? '');
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
    .getByRole('tab', { name: locale === 'zh-CN' ? '个人榜单' : 'Individual leaderboard' })
    .click();

  const leaderboard = page.locator('.leaderboard-section');
  await expect(leaderboard).toContainText('September Practice');
  await expect(
    page.getByRole('tab', { name: locale === 'zh-CN' ? '自由练习' : 'Unlimited practice' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(leaderboard).toContainText('6,144');
  await expect(
    page.getByRole('tab', { name: locale === 'zh-CN' ? '年级榜' : 'My grade' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(leaderboard).toContainText('260024');
  await expect(leaderboard).toContainText('8');

  await page.getByRole('tab', { name: locale === 'zh-CN' ? '总榜' : 'Overall' }).click();
  await expect(leaderboard).toContainText('张*');
  await expect(leaderboard).toContainText('260001');
  await expect(leaderboard).toContainText(locale === 'zh-CN' ? '我' : 'Me');
  await expect(leaderboard).not.toContainText('张三');
  await expect(leaderboard).not.toContainText('20260001');

  await page.getByRole('tab', { name: locale === 'zh-CN' ? '年级榜' : 'My grade' }).click();
  await expect(leaderboard).toContainText('260024');
  await expect(leaderboard).toContainText('8');

  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '3 分钟限时赛' : 'Three-minute timed game' })
    .click();
  await expect(leaderboard).toContainText('4,096');
  await expect(leaderboard).not.toContainText('6,144');
  await expect(
    leaderboard.getByRole('columnheader', {
      name: locale === 'zh-CN' ? '计入局数' : 'Games counted',
    }),
  ).toBeVisible();
  await page.getByRole('tab', { name: locale === 'zh-CN' ? '总榜' : 'Overall' }).click();
  await expect(leaderboard).toContainText('8,192');
});

test('student can review classified practice, 1v1, and 3v3 personal results', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  await page.goto('/student/results');

  await expect(
    page.getByRole('tab', { name: locale === 'zh-CN' ? '个人最好成绩' : 'Personal bests' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.personal-records-table')).toContainText('8,192');
  await expect(page.locator('.personal-records-table')).toContainText('1,024');

  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '1v1 比赛成绩' : '1v1 results' })
    .click();
  const personalResults = page.locator('.personal-results');
  await expect(personalResults).toContainText('September Competition');
  await expect(personalResults).toContainText('Formal Duel');
  await expect(personalResults).toContainText('张*');
  await expect(personalResults).toContainText('260002');
  await expect(personalResults).not.toContainText('张三');
  await expect(personalResults).not.toContainText('20260002');

  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '3v3 团队成绩' : '3v3 team results' })
    .click();
  await expect(personalResults).toContainText('Pioneer Team');
  await expect(personalResults).toContainText('Challenger Team');
  await expect(personalResults).toContainText(locale === 'zh-CN' ? '历史总计' : 'All-time totals');
  await page.screenshot({
    path: testInfo.outputPath(`classified-personal-results-${locale}.png`),
    fullPage: true,
  });
});

test('teacher can review full practice rankings and open period management', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  await page.goto('/teacher/results');
  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '个人榜单' : 'Individual leaderboard' })
    .click();

  await expect(page.getByRole('heading', { name: 'September Practice' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '20260001' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '张三' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '128', exact: true })).toBeVisible();
  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '3 分钟限时赛' : 'Three-minute timed game' })
    .click();
  await expect(page.getByRole('cell', { name: '10', exact: true })).toBeVisible();

  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '团队榜单' : 'Team leaderboard' })
    .click();
  await expect(page.locator('.quick-section')).toContainText('Pioneer Team');
  await expect(page.locator('.quick-section')).toContainText('4');
  await expect(page.locator('.quick-section')).not.toContainText('8,192');
  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '个人榜单' : 'Individual leaderboard' })
    .click();

  await expect(
    page.getByRole('button', { name: locale === 'zh-CN' ? '创建周期' : 'Create period' }),
  ).toHaveCount(0);
  await expect(page.locator('.leaderboard-period-history')).toHaveCount(0);
  await page
    .getByRole('link', { name: locale === 'zh-CN' ? '管理赛季' : 'Manage seasons' })
    .click();
  await expect(page).toHaveURL(/\/teacher\/seasons\?type=individual/);
  await expect(page.locator('.leaderboard-ranking')).toHaveCount(0);
  await page
    .getByRole('button', { name: locale === 'zh-CN' ? '创建周期' : 'Create period' })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('individual season management creates and renames periods without loading rankings', async ({
  page,
}, testInfo) => {
  const zh = projectLocale(testInfo) === 'zh-CN';
  await mockApi(page, 'teacher', projectLocale(testInfo));
  const items = [
    {
      id: 'period-current',
      name: 'September Practice',
      startAt: '2026-09-01T00:00:00Z',
      endAt: '2026-10-01T00:00:00Z',
      status: 'active',
    },
  ];
  const writes: unknown[] = [];
  const rankingRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/leaderboards/practice')) rankingRequests.push(request.url());
  });
  await page.route('**/api/teacher/leaderboard-periods**', (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON();
      writes.push(body);
      const period = { ...body, id: 'period-new', status: 'upcoming' };
      items.push(period);
      return route.fulfill({ json: { period } });
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON();
      writes.push(body);
      items[0].name = body.name;
      return route.fulfill({ json: { period: items[0] } });
    }
    return route.fulfill({ json: { items } });
  });
  await page.route('**/api/teacher/leaderboards/practice?**', (route) =>
    route.fulfill({
      json: {
        mode: 'unlimited',
        period: items.find(
          (item) => item.id === new URL(route.request().url()).searchParams.get('periodId'),
        ),
        participantCount: 0,
        entries: [],
        gradeLevel: null,
      },
    }),
  );
  await page.goto('/teacher/seasons?type=individual');
  await page.getByRole('button', { name: zh ? '重命名' : 'Rename', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel(zh ? '开始时间' : 'Starts at', { exact: true })).toBeDisabled();
  await dialog.getByLabel(zh ? '周期名称' : 'Period name', { exact: true }).fill('Renamed season');
  await dialog.getByRole('button', { name: zh ? '保存' : 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Renamed season', exact: true })).toBeVisible();
  expect(writes[0]).toEqual({ name: 'Renamed season' });
  await page
    .getByRole('button', { name: zh ? '创建周期' : 'Create period', exact: true })
    .first()
    .click();
  await dialog.getByLabel(zh ? '周期名称' : 'Period name', { exact: true }).fill('Winter season');
  await dialog.getByLabel(zh ? '开始时间' : 'Starts at', { exact: true }).fill('2026-11-01T00:00');
  await dialog.getByLabel(zh ? '结束时间' : 'Ends at', { exact: true }).fill('2026-12-01T00:00');
  await dialog.getByRole('button', { name: zh ? '保存' : 'Save', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Winter season', exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(rankingRequests).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath('individual-season-management.png'),
    fullPage: true,
  });
  await page
    .getByRole('row')
    .filter({ hasText: 'Winter season' })
    .getByRole('link', { name: zh ? '查询成绩' : 'View results' })
    .click();
  await expect(page).toHaveURL(/view=leaderboard&periodId=period-new/);
  await expect(page.getByRole('heading', { name: 'Winter season', exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('combobox', { name: zh ? '查看周期' : 'Period', exact: true }),
  ).toHaveValue('period-new');
});

test('student can find a team and join a room lobby', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  await page.goto('/student/team');
  await page
    .getByPlaceholder(locale === 'zh-CN' ? '搜索团队名称或代码' : 'Search team name or code')
    .fill('Pioneer');
  await expect(
    page.getByRole('tab', { name: locale === 'zh-CN' ? '加入团队' : 'Join team' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('radiogroup')).toHaveCount(0);
  await page
    .getByRole('button', { name: locale === 'zh-CN' ? '搜索' : 'Search', exact: true })
    .click();
  await expect(page.locator('.team-result-members')).toContainText('张晨');
  await expect(page.locator('.team-result-members')).toContainText('李悦');
  await expect(page.locator('.team-result-actions')).toContainText('2 / 3');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath(`team-join-${locale}.png`), fullPage: true });
  await page.getByRole('button', { name: locale === 'zh-CN' ? '加入团队' : 'Join team' }).click();
  await expect(page.getByRole('heading', { name: 'Pioneer Team' })).toBeVisible();

  await page.goto('/student');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '加入房间' : 'Join room' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '房间候场' : 'Room lobby',
  );
});

test('student can create a team with a preset logo and delete it', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  page.on('dialog', (dialog) => void dialog.accept());
  await mockApi(page, 'student', locale);
  await page.goto('/student/team');

  await page.getByRole('tab', { name: locale === 'zh-CN' ? '创建团队' : 'Create team' }).click();
  await expect(
    page.getByRole('button', { name: locale === 'zh-CN' ? '搜索' : 'Search', exact: true }),
  ).toHaveCount(0);
  await page.getByLabel(locale === 'zh-CN' ? '团队名称' : 'Team name').fill('Flying Tigers');
  await page.getByRole('radio', { name: 'icon2' }).click();
  const logoBox = await page.getByRole('radio', { name: 'icon2' }).boundingBox();
  expect(Math.abs(logoBox!.width - logoBox!.height)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath(`team-create-${locale}.png`), fullPage: true });
  await page.getByRole('button', { name: locale === 'zh-CN' ? '创建团队' : 'Create team' }).click();

  const teamCard = page.locator('.my-team-card');
  await expect(teamCard).toContainText('Flying Tigers');
  await expect(teamCard.locator('img.team-logo-art')).toHaveAttribute(
    'src',
    '/team-logos/icon2.svg',
  );
  await expect(teamCard.locator('img.team-logo-art')).toHaveJSProperty('naturalWidth', 160);
  await expect(
    teamCard.getByRole('button', { name: locale === 'zh-CN' ? '删除团队' : 'Delete team' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: locale === 'zh-CN' ? '退出团队' : 'Leave team' }),
  ).toHaveCount(0);

  await teamCard
    .getByRole('button', { name: locale === 'zh-CN' ? '删除团队' : 'Delete team' })
    .click();
  await expect(
    page.getByText(
      locale === 'zh-CN'
        ? '你还没有团队，选择一种方式开始组队'
        : 'You have no team yet. Choose how to get started.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: locale === 'zh-CN' ? '加入团队' : 'Join team' }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('student team leaderboard shows only 3v3 match points', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  await page.goto('/student/results');
  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '团队榜单' : 'Team leaderboard' })
    .click();

  const leaderboard = page.locator('.quick-section');
  await expect(leaderboard).toContainText('September 3v3');
  await expect(leaderboard).toContainText(
    locale === 'zh-CN' ? '已结算 3v3 对战积分' : 'settled 3v3 match points',
  );
  await expect(leaderboard).toContainText('Pioneer Team');
  await expect(leaderboard.getByRole('row', { name: /Pioneer Team/u })).toContainText('4');
  await expect(leaderboard).not.toContainText('12,288');
  await expect(leaderboard).not.toContainText('张*');
});

test('match page logs out without reconnecting when the session is replaced', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
  let sessionValid = true;
  await page.route('**/api/me', (route) => {
    if (sessionValid) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: null }),
    });
  });
  let connections = 0;
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    connections += 1;
    socket.onMessage(() => undefined);
    setTimeout(() => {
      sessionValid = false;
      socket.close({ code: SESSION_REPLACED_CLOSE_CODE, reason: 'Session replaced' });
    }, 300);
  });
  await page.goto('/student/rooms/room-1/match');
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/u, { timeout: 25_000 });
  const connectionsAtLogout = connections; // StrictMode double-mounts the socket hook
  await page.waitForTimeout(1600); // retry backoff would reconnect within ~1.5s
  expect(connections).toBe(connectionsAtLogout);
  await expect(
    page.getByRole('button', { name: locale === 'zh-CN' ? '登录' : 'Sign in' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      locale === 'zh-CN' ? '登录已失效，请重新登录' : 'Your session expired. Please sign in again.',
    ),
  ).toBeVisible();
});

test('match page adopts a replacement cookie shared by another tab', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
  let replacementPending = false;
  let replacementChecks = 0;
  await page.route('**/api/me', (route) => {
    if (!replacementPending) return route.fallback();
    replacementChecks += 1;
    if (replacementChecks > 3) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: null }),
    });
  });
  let connections = 0;
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    connections += 1;
    socket.onMessage(() => undefined);
    if (connections <= 2) {
      setTimeout(() => {
        replacementPending = true;
        socket.close({ code: SESSION_REPLACED_CLOSE_CODE, reason: 'Session replaced' });
      }, 300);
    }
  });
  await page.goto('/student/rooms/room-1/match');
  await expect(page.getByRole('grid')).toBeVisible();
  await expect.poll(() => connections, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  expect(replacementChecks).toBeGreaterThanOrEqual(4);
  await expect(page).toHaveURL(/\/student\/rooms\/room-1\/match$/u);
  await expect(
    page.getByText(
      locale === 'zh-CN' ? '登录已失效，请重新登录' : 'Your session expired. Please sign in again.',
    ),
  ).toHaveCount(0);
});

test('failed WebSocket handshakes expire stale browser auth', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
  let sessionValid = true;
  await page.route('**/api/me', (route) => {
    if (sessionValid) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: null }),
    });
  });
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    socket.onMessage(() => undefined);
    setTimeout(() => {
      sessionValid = false;
      socket.close({ code: 1006 });
    }, 300);
  });
  await page.goto('/student/rooms/room-1/match');
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/u, { timeout: 25_000 });
  await expect(
    page.getByText(
      locale === 'zh-CN' ? '登录已失效，请重新登录' : 'Your session expired. Please sign in again.',
    ),
  ).toBeVisible();
});

test('match page reconnects after ordinary WebSocket closures', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
  let connections = 0;
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    connections += 1;
    socket.onMessage(() => undefined);
    if (connections <= 2) {
      setTimeout(() => socket.close({ code: 1012, reason: 'Service restart' }), 300);
    }
  });
  await page.goto('/student/rooms/room-1/match');
  await expect(page.getByRole('grid')).toBeVisible();
  await expect.poll(() => connections, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  await expect(page).toHaveURL(/\/student\/rooms\/room-1\/match$/u);
  await expect(
    page.getByText(
      locale === 'zh-CN' ? '登录已失效，请重新登录' : 'Your session expired. Please sign in again.',
    ),
  ).toHaveCount(0);
});

test('match keeps local progress and retries the frozen final until acknowledged', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
  const now = Date.now();
  await page.clock.install({ time: now });
  const initial = {
    type: 'state',
    roomId: 'room-1',
    roomStatus: 'live',
    serverTime: now,
    startsAt: now - 3_000,
    endsAt: now + 60_000,
    syncDeadlineAt: now + 120_000,
    settled: false,
    finalSubmitted: false,
    canControl: true,
    scores: null,
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
  };
  await page.route('**/api/rooms/room-1/match', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(initial) }),
  );
  let serverSocket: WebSocketRoute | null = null;
  const clientMessages: Array<Record<string, unknown>> = [];
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    serverSocket = socket;
    socket.onMessage((message) => {
      clientMessages.push(JSON.parse(String(message)) as Record<string, unknown>);
    });
  });

  await page.goto('/student/rooms/room-1/match');
  await expect(page.getByRole('grid')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(() => clientMessages.some((message) => (message.game as { seq: number })?.seq === 2))
    .toBe(true);
  const progress = clientMessages.find((message) => (message.game as { seq: number })?.seq === 2)!;
  expect(progress).toMatchObject({ type: 'progress', final: false, game: { seq: 2 } });
  const local = progress.game;

  if (!serverSocket) throw new Error('WebSocket did not connect');
  serverSocket.send(JSON.stringify(initial));
  await expect
    .poll(
      () => clientMessages.filter((message) => (message.game as { seq: number })?.seq === 2).length,
    )
    .toBeGreaterThan(1);
  expect(clientMessages.at(-1)?.game).toEqual(local);

  // The local clock stops play even without a server end notice.
  await page.clock.fastForward(60_000);
  // A later server end notice cannot replace the frozen local board.
  serverSocket.send(JSON.stringify({ ...initial, roomStatus: 'ended' }));
  await expect.poll(() => clientMessages.some((message) => message.final)).toBe(true);
  const final = clientMessages.find((message) => message.final)!;
  expect(final.game).toEqual(local);
  const count = clientMessages.length;
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => clientMessages.length).toBeGreaterThan(count);
  expect(clientMessages.at(-1)).toEqual(final);

  // An upload acknowledgement ends retries without replacing the local score.
  serverSocket.send(
    JSON.stringify({ ...initial, roomStatus: 'ended', game: local, finalSubmitted: true }),
  );
  await expect(
    page.getByText(
      locale === 'zh-CN'
        ? '本地最终成绩已上传确认，等待统一结算。'
        : 'Your final local score is confirmed. Waiting for match settlement.',
    ),
  ).toBeVisible();
  const acknowledgedCount = clientMessages.length;
  await page.waitForTimeout(1200);
  expect(clientMessages).toHaveLength(acknowledgedCount);
});

test('room lobby auto-jumps to the match when the room starts', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  await page.route('**/api/rooms/room-1', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        room: {
          id: 'room-1',
          code: 'A2048',
          name: 'Grade 6 Challenge',
          mode: 'duel',
          durationMinutes: 5,
          status: 'open',
          isParticipant: true,
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
      }),
    });
  });
  let serverSocket: WebSocketRoute | null = null;
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    serverSocket = socket;
    socket.onMessage(() => undefined);
  });
  await page.goto('/student');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '加入房间' : 'Join room' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '房间候场' : 'Room lobby',
  );
  await expect.poll(() => serverSocket !== null).toBe(true);
  const now = Date.now();
  const startNotice = {
    type: 'state',
    roomId: 'room-1',
    roomStatus: 'countdown',
    serverTime: now,
    startsAt: now + 3000,
    endsAt: now + 63_000,
    game: {
      board: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
      score: 0,
      maxTile: 2,
      maxTileReachedAt: now - 3000,
      moveCount: 0,
      rngState: 12345,
      seq: 0,
      status: 'playing',
    },
    canControl: true,
  };
  serverSocket.send(JSON.stringify(startNotice));
  await expect(page).toHaveURL(/\/student\/rooms\/room-1\/match$/u);
  serverSocket.send(JSON.stringify(startNotice));
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page).toHaveURL(/\/student\/rooms\/room-1\/match$/u);
});

test('room lobby keeps content visible while polling refreshes', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  const lobbyRoom = (status: RoomStatus) => ({
    room: {
      id: 'room-1',
      code: 'A2048',
      name: 'Grade 6 Challenge',
      mode: 'duel',
      durationMinutes: 5,
      status,
      isParticipant: true,
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
  let hangSubsequent = false;
  let hungRequests = 0;
  await page.route('**/api/rooms/room-1', async (route) => {
    if (hangSubsequent) {
      hungRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 2600));
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(lobbyRoom('open')),
    });
  });
  await page.goto('/student');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '加入房间' : 'Join room' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '房间候场' : 'Room lobby',
  );
  await expect(page.locator('.lobby-card')).toBeVisible();
  // Lobby content is rendered; hang the next poll (2s interval) so a request
  // is in flight while data is already present.
  hangSubsequent = true;
  await expect.poll(() => hungRequests, { timeout: 8000 }).toBeGreaterThanOrEqual(1);
  expect(await page.getByRole('status').count()).toBe(0);
  await expect(page.locator('.lobby-card')).toBeVisible();
});

test('student can return to an active match from the home page', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    socket.onMessage(() => undefined);
  });
  await page.goto('/student');
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
    exact: true,
  });
  await fullscreenButton.click();
  const gameSurface = page.locator('.game-surface');
  await expect(gameSurface).toHaveClass(/is-fullscreen/u);
  await expect(gameSurface.locator('.game-statusbar')).toBeVisible();
  await expect(gameSurface.locator('.game-statusbar > strong')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(gameSurface).not.toHaveClass(/is-fullscreen/u);
  await fullscreenButton.click();
  await expect(gameSurface).toHaveClass(/is-fullscreen/u);
  const exitButton = gameSurface.getByRole('button', {
    name: locale === 'zh-CN' ? '退出全屏' : 'Exit fullscreen',
  });
  await expect(exitButton).toBeVisible();
  await exitButton.click();
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

    await page.locator('input[name="currentPassword"]').fill('wrong-current-password');
    await page.locator('input[name="newPassword"]').fill('new-password-value');
    await page.locator('input[name="confirmPassword"]').fill('new-password-value');
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '修改密码' : 'Change password' })
      .click();
    await expect(page.getByRole('alert')).toHaveText(
      locale === 'zh-CN' ? '当前密码不正确' : 'The current password is incorrect',
    );

    await page.locator('input[name="currentPassword"]').fill('current-password-value');
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

test('legacy team logos resolve to the existing pixel library', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  const logos = [
    'lion',
    'tiger',
    'dragon',
    'eagle',
    'wolf',
    'shark',
    'owl',
    'panda',
    'fox',
    'turtle',
    'whale',
    'rocket',
    null,
    'unknown',
    'icon9',
  ];
  await page.route('**/api/teacher/teams?*', (route) =>
    route.fulfill({
      json: {
        items: logos.map((logo, index) => ({
          id: `logo-${index}`,
          name: `Logo ${index}`,
          code: `L${index}`,
          logo,
          creator_id: null,
          frozen: 0,
          group: null,
          members: [],
        })),
        total: logos.length,
        pageSize: 20,
      },
    }),
  );
  await page.goto('/teacher/teams');
  const images = page.locator('.team-logo img');
  await expect(images).toHaveCount(logos.length);
  for (let index = 0; index < logos.length; index += 1) {
    const expected = index < 12 ? (index % 9) + 1 : index === 14 ? 9 : 1;
    await expect(images.nth(index)).toHaveAttribute('src', `/team-logos/icon${expected}.svg`);
  }
  await expect
    .poll(() =>
      images.evaluateAll((nodes) =>
        nodes.every(
          (node) =>
            (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0,
        ),
      ),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath('legacy-logo-library.png'), fullPage: true });
});
