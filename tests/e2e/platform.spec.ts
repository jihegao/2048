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
    if (path === '/api/leaderboard/teams') {
      return json({
        status: 'available',
        period: {
          id: 'period-current',
          name: 'September Practice',
          startAt: '2026-09-01T00:00:00.000Z',
          endAt: '2026-10-01T00:00:00.000Z',
          status: 'active',
        },
        participantTeamCount: 2,
        currentUserTeamRank: 1,
        entries: [
          {
            rank: 1,
            teamName: 'Pioneer Team',
            teamLogo: 'tiger',
            memberCount: 2,
            totalScore: 12288,
            isCurrentUserTeam: true,
            members: [
              {
                className: '六年级1班',
                maskedName: '张*',
                studentNumberSuffix: '260001',
                score: 8192,
                isCurrentUser: false,
              },
              {
                className: '六年级1班',
                maskedName: '演示学*',
                studentNumberSuffix: '260024',
                score: 4096,
                isCurrentUser: true,
              },
            ],
          },
          {
            rank: 2,
            teamName: 'Grade 6 Challengers',
            teamLogo: null,
            memberCount: 3,
            totalScore: 2048,
            isCurrentUserTeam: false,
            members: [
              {
                className: '六年级1班',
                maskedName: '李*',
                studentNumberSuffix: '260002',
                score: 2048,
                isCurrentUser: false,
              },
            ],
          },
        ],
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

test('teacher 3v3 live arena keeps both score pillars and six boards in view', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'teacher', locale);
  const now = Date.now();
  const game = {
    board: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
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
    players: scores.map((score, index) => ({
      userId: `student-${index}`,
      studentNumber: `S${index}`,
      name: `Player ${index + 1}`,
      className: null,
      teamName: index < 3 ? 'Alpha' : 'Beta',
      side: index < 3 ? 1 : 2,
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
  await expect(page.locator('.live-team-row .game-board')).toHaveCount(6);
  await expect(page.locator('.live-pillar__fill')).toHaveCount(2);
  await expect(page.locator('.live-pillar__fill').first()).toHaveAttribute('style', 'height: 0%;');

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
      path: testInfo.outputPath(`teacher-live-${locale}-${viewport.width}.png`),
      fullPage: true,
    });
  }
});

test('student match shows authoritative duel and team score summaries', async ({
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
  socket.send(
    JSON.stringify({
      type: 'score-summary',
      roomId: 'room-1',
      scores: { mode: 'duel', side: 1, sideScores: { 1: 32, 2: 16 }, ownScore: 32, revision: 2 },
    }),
  );
  await expect(own.locator('strong')).toHaveText('32');

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
  await expect(own.locator('strong')).toHaveText('60');
  await expect(opponent.locator('strong')).toHaveText('45');
  await expect(page.locator('.match-scores__personal')).toContainText('20');
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

  await page.goto('/teacher/rooms');
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
  await expect(page.getByText(locale === 'zh-CN' ? '已冻结' : 'Frozen')).toBeVisible();
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
    logo: 'tiger',
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

for (const sessionState of ['valid', 'expired', 'network-error'] as const) {
  test(`homepage 401 revalidates the current cookie: ${sessionState}`, async ({
    page,
  }, testInfo) => {
    const locale = projectLocale(testInfo);
    await mockApi(page, 'student', locale);
    await page.goto('/student');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    let checks = 0;
    await page.route('**/api/me', (route) => {
      checks += 1;
      if (sessionState === 'valid') return route.fallback();
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
    await page
      .getByRole('link', { name: locale === 'zh-CN' ? '查看' : 'View' })
      .first()
      .click();
    await expect.poll(() => checks).toBeGreaterThan(0);
    if (sessionState === 'expired') {
      await expect(page).toHaveURL(/\/login$/u);
      await expect(
        page.getByText(
          locale === 'zh-CN'
            ? '登录已失效，请重新登录'
            : 'Your session expired. Please sign in again.',
        ),
      ).toBeVisible();
    } else {
      await expect(page.getByText('请先登录')).toBeVisible();
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
    .getByRole('tab', { name: locale === 'zh-CN' ? '本期榜单' : 'Current leaderboard' })
    .click();

  const leaderboard = page.locator('.leaderboard-section');
  await expect(leaderboard).toContainText('September Practice');
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
  await page.getByRole('radio', { name: 'tiger' }).click();
  const logoBox = await page.getByRole('radio', { name: 'tiger' }).boundingBox();
  expect(Math.abs(logoBox!.width - logoBox!.height)).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath(`team-create-${locale}.png`), fullPage: true });
  await page.getByRole('button', { name: locale === 'zh-CN' ? '创建团队' : 'Create team' }).click();

  const teamCard = page.locator('.my-team-card');
  await expect(teamCard).toContainText('Flying Tigers');
  await expect(teamCard).toContainText('🐯');
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

test('student can review the team leaderboard with masked contributions', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  await page.goto('/student/results');
  await page
    .getByRole('tab', { name: locale === 'zh-CN' ? '团队榜单' : 'Team leaderboard' })
    .click();

  const leaderboard = page.locator('.leaderboard-section');
  await expect(leaderboard).toContainText('September Practice');
  await expect(leaderboard).toContainText(
    locale === 'zh-CN'
      ? '团队得分由队员个人练习成绩加总'
      : "Team scores sum each member's personal practice results",
  );
  await expect(leaderboard).toContainText('Pioneer Team');
  await expect(leaderboard).toContainText('12,288');
  await expect(leaderboard).toContainText('张*');
  await expect(leaderboard).toContainText('260024');
  await expect(leaderboard).not.toContainText('张三');
  await expect(leaderboard).not.toContainText('20260024');
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
  await expect(page).toHaveURL(/\/login$/u);
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
    if (replacementChecks > 1) return route.fallback();
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
  await expect.poll(() => connections, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  expect(replacementChecks).toBeGreaterThanOrEqual(2);
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
  await expect(page).toHaveURL(/\/login$/u, { timeout: 5000 });
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

test('match uploads directions and resends pending moves after authoritative resync', async ({
  page,
}, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale, { status: 'live', isParticipant: true });
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
  await expect.poll(() => clientMessages.length).toBe(1);
  expect(clientMessages[0]).toEqual({ type: 'move', seq: 1, direction: 'left' });

  if (!serverSocket) throw new Error('WebSocket did not connect');
  const now = Date.now();
  serverSocket.send(
    JSON.stringify({
      type: 'state',
      roomId: 'room-1',
      roomStatus: 'live',
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
    }),
  );

  await expect.poll(() => clientMessages.length).toBe(2);
  expect(clientMessages[1]).toEqual({ type: 'move', seq: 1, direction: 'left' });
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
