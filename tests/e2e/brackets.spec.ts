import { expect, test, type Page } from './fixtures';
import { emptyBracket, type BracketKind, type BracketSnapshot } from '../../shared/brackets';
import { projectBracket } from '../../shared/brackets';
import {
  tournamentImpacts,
  tournamentRoomName,
  type TournamentData,
} from '../../shared/tournaments';
const teams = Array.from({ length: 9 }, (_, i) => ({
  id: `team-${i}`,
  name: `团队${i + 1}`,
  label: `团队${i + 1}`,
  logo: `icon${i + 1}`,
  memberCount: 3,
}));
const students = Array.from({ length: 16 }, (_, i) => ({
  id: `student-${i}`,
  name: `学生${i + 1}`,
  label: `学生${i + 1} · 六班 · S${i + 1}`,
  logo: null,
}));
async function mock(
  page: Page,
  locale: string,
  conflict = false,
  options: { incomplete?: boolean; roomError?: boolean; joinOnRefresh?: boolean } = {},
) {
  const events = new Map<string, TournamentData>();
  const teamCatalog = teams.map((team, i) => ({
    ...team,
    memberCount: options.incomplete && i === 0 ? 1 : 3,
  }));
  page.on('dialog', (dialog) => void dialog.accept());
  const records: Record<BracketKind, BracketSnapshot> = {
    teams8: { state: emptyBracket('teams8'), revision: 0, updatedAt: null },
    players16: { state: emptyBracket('players16'), revision: 0, updatedAt: null },
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/api/teacher/rooms/') && path.endsWith('/start')) {
      for (const event of events.values()) {
        const room = event.rooms.find((room) => path.includes(room.roomId));
        if (room) room.status = 'countdown';
      }
      return route.fulfill({ json: { message: 'Started' } });
    }
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'teacher-test', role: 'teacher', name: '管理员', loginId: 'teacher', locale },
        },
      });
    if (path.startsWith('/api/teacher/tournaments')) {
      const id = path.split('/')[4];
      const body = req.method() === 'GET' ? null : req.postDataJSON();
      if (path === '/api/teacher/tournaments' && req.method() === 'GET') {
        const url = new URL(req.url());
        return route.fulfill({
          json: {
            items: [...events.values()]
              .filter(
                (event) =>
                  event.event.kind === url.searchParams.get('kind') &&
                  event.event.archived === (url.searchParams.get('archived') === 'true'),
              )
              .map((event) => event.event),
          },
        });
      }
      if (conflict && ['POST', 'PUT'].includes(req.method()))
        return route.fulfill({
          status: 409,
          json: { error: { code: 'BRACKET_CONFLICT', message: 'conflict' } },
        });
      if (path === '/api/teacher/tournaments' && req.method() === 'POST') {
        const source = body.copyId ? events.get(body.copyId)! : null;
        const kind = body.kind as BracketKind;
        const state = source
          ? {
              ...source.state,
              title: source.state.title + '（副本）',
              winners: emptyBracket(kind).winners,
            }
          : body.state;
        const event: TournamentData = {
          state,
          revision: 1,
          updatedAt: '2026-10-14T09:00:00Z',
          catalog: kind === 'teams8' ? teamCatalog : students,
          rooms: [],
          history: [],
          audit: [],
          event: {
            id: `event-${events.size}`,
            kind,
            title: state.title,
            status: 'draft',
            archived: false,
            revision: 1,
            updatedAt: '2026-10-14T09:00:00Z',
            roomCount: 0,
          },
        };
        events.set(event.event.id, event);
        records[kind] = event;
        return route.fulfill({ status: 201, json: event });
      }
      const event = events.get(id)!;
      if (req.method() === 'GET' && options.joinOnRefresh && event.rooms[0]?.status === 'open') {
        event.rooms[0].entryCount = 2;
        event.rooms[0].status = 'full';
      }
      if (path.endsWith('/preview'))
        return route.fulfill({
          json: {
            impacts: tournamentImpacts(
              event.event.kind,
              event.catalog,
              event.state,
              body.state,
              event.rooms,
            ),
          },
        });
      if (req.method() === 'PUT') {
        event.state = body.state;
        event.revision++;
        event.event.title = event.state.title;
        records[event.event.kind] = event;
      }
      if (path.endsWith('/rooms')) {
        if (options.roomError)
          return route.fulfill({
            status: 422,
            json: { error: { code: 'TEAM_INCOMPLETE', message: '所有参赛队伍必须有完整三人名单' } },
          });
        const projected = projectBracket(event.event.kind, event.catalog, event.state);
        event.rooms = projected.rounds.flatMap((matches, round) =>
          matches.map((match, index) => ({
            round,
            match: index,
            roomId: `${id}-${round}-${index}`,
            code: `R${round}${index}`,
            name: tournamentRoomName(event.state.title, event.event.kind, round, index),
            durationMinutes: body.durationMinutes,
            status: 'open' as const,
            participants: [match.entries[0]?.id ?? null, match.entries[1]?.id ?? null] as [
              string | null,
              string | null,
            ],
            entryCount: 0,
          })),
        );
        event.revision++;
        event.event.roomCount = event.rooms.length;
        event.event.status = 'ready';
      }
      if (req.method() === 'PATCH') {
        event.event.archived = body.archived;
        event.event.status = body.archived ? 'archived' : 'ready';
        event.revision++;
      }
      if (event?.rooms.length && req.method() === 'PUT') {
        const projected = projectBracket(event.event.kind, event.catalog, event.state);
        event.rooms.forEach((room) => {
          const match = projected.rounds[room.round][room.match];
          room.participants = [match.entries[0]?.id ?? null, match.entries[1]?.id ?? null];
        });
      }
      return route.fulfill({ json: event });
    }
    const kind = path.split('/').at(-1) as BracketKind;
    if (path.startsWith('/api/teacher/brackets/') && kind in records) {
      if (req.method() === 'PUT') {
        if (conflict)
          return route.fulfill({
            status: 409,
            json: { error: { code: 'BRACKET_CONFLICT', message: 'conflict' } },
          });
        const body = req.postDataJSON() as BracketSnapshot;
        records[kind] = {
          state: body.state,
          revision: records[kind].revision + 1,
          updatedAt: '2026-10-13T09:00:00Z',
        };
        return route.fulfill({ json: records[kind] });
      }
      return route.fulfill({
        json: { ...records[kind], catalog: kind === 'teams8' ? teamCatalog : students },
      });
    }
    return route.fulfill({ json: { items: [], total: 0, mode: 'normal' } });
  });
  return records;
}
async function advanceAll(page: Page, size: number) {
  for (let round = 0; round < Math.log2(size); round++)
    for (let match = 0; match < size / 2 ** (round + 1); match++)
      await page
        .locator(`[data-round="${round}"][data-match="${match}"] .tournament-advance`)
        .first()
        .click();
}
for (const kind of ['teams8', 'players16'] as const) {
  test(`online ${kind} matches names, mirrors the bracket, and restores a saved champion`, async ({
    page,
  }, info) => {
    const locale = String(info.project.use.locale).startsWith('zh') ? 'zh-CN' : 'en';
    await mock(page, locale);
    await page.goto(`/teacher/brackets/${kind}`);
    const entries = kind === 'teams8' ? teams.slice(0, 8) : students;
    const size = entries.length;
    await expect(page.locator('.tournament-input')).toHaveCount(size);
    for (let i = 0; i < size; i++)
      await page
        .getByLabel(locale === 'zh-CN' ? `席位 ${i + 1}` : `Slot ${i + 1}`, { exact: true })
        .fill(entries[i].label);
    if (kind === 'teams8') {
      await expect(page.locator('.tournament-logo img')).toHaveCount(8);
      for (const image of await page.locator('.tournament-logo img').all())
        await expect(image).toHaveJSProperty('naturalWidth', 160);
    }
    // All rounds have mirrored outer columns and one central final.
    const wings = await page.locator('[data-stage="0"]').evaluateAll((elements) =>
      elements.map((el) => ({
        x: el.getBoundingClientRect().x,
        width: el.getBoundingClientRect().width,
      })),
    );
    const final = (await page.locator('.tournament-final').boundingBox())!;
    expect(Math.abs(wings[0].width - wings[1].width)).toBeLessThan(1);
    expect(
      Math.abs(
        (wings[0].x + wings[0].width / 2 + wings[1].x + wings[1].width / 2) / 2 -
          (final.x + final.width / 2),
      ),
    ).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await advanceAll(page, size);
    await expect(page.locator('.tournament-champion__name')).toHaveText(entries[0].name);
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '保存到线上' : 'Save online', exact: true })
      .click();
    await expect(page.locator('.tournament-save-status strong')).toHaveText(
      locale === 'zh-CN' ? '已与线上同步' : 'Synced online',
    );
    await page.reload();
    await expect(page.locator('.tournament-champion__name')).toHaveText(entries[0].name);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page
      .getByRole('button', { name: locale === 'zh-CN' ? '全屏' : 'Fullscreen', exact: true })
      .click();
    await expect(page.locator('.tournament-page')).toHaveClass(/is-fullscreen/);
    await expect(page.locator('.tournament-flag')).toBeVisible();
    await expect(page.locator('.tournament-mascot')).toHaveJSProperty('naturalWidth', 906);
    await page.screenshot({ path: info.outputPath(`${kind}-design.png`) });
    await page
      .getByRole('button', {
        name: locale === 'zh-CN' ? '退出全屏' : 'Exit fullscreen',
        exact: true,
      })
      .click();
    await page.locator('.tournament-input').first().fill('未知参赛者');
    await expect(page.locator('.tournament-entry.has-error').first()).toBeVisible();
    await expect(page.locator('.tournament-champion__name')).toHaveText(
      locale === 'zh-CN' ? '冠军待定' : 'Champion pending',
    );
    if (kind === 'teams8')
      await expect(
        page
          .locator('.tournament-entry[data-round="0"][data-node="0"] .tournament-logo')
          .first()
          .locator('img'),
      ).toHaveCount(0);
    // Saving is shared online; editing the current page does not change the other mode.
    await page.screenshot({ path: info.outputPath(`${kind}.png`), fullPage: true });
  });
}
test('save conflicts retain local edits and refuse silent overwrites', async ({ page }, info) => {
  const zh = String(info.project.use.locale).startsWith('zh');
  await mock(page, zh ? 'zh-CN' : 'en', true);
  await page.goto('/teacher/brackets/teams8');
  const title = page.locator('.tournament-title-input input');
  await title.fill('仍需保留的修改');
  await page.getByRole('button', { name: zh ? '保存到线上' : 'Save online', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(zh ? '其他管理员' : 'Another administrator');
  await expect(title).toHaveValue('仍需保留的修改');
});

test('room creation works when browser native confirmations are suppressed', async ({
  page,
}, info) => {
  const zh = String(info.project.use.locale).startsWith('zh');
  await mock(page, zh ? 'zh-CN' : 'en');
  await page.addInitScript(() => {
    window.confirm = () => false;
  });
  const requests: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/tournaments\/[^/]+\/rooms$/.test(new URL(request.url()).pathname)
    )
      requests.push(request.url());
  });
  await page.goto('/teacher/brackets/teams8');
  await page.getByLabel(zh ? '赛事名称' : 'Event name').fill('test-团队赛');
  for (let i = 0; i < 8; i++) await page.locator('.tournament-input').nth(i).fill(teams[i].name);
  await page.getByRole('button', { name: zh ? '保存到线上' : 'Save online', exact: true }).click();
  await expect(page.getByLabel(zh ? '赛事列表' : 'Events', { exact: true })).toHaveValue('event-0');
  const create = page.getByRole('button', {
    name: zh ? '批量创建全部 7 个房间' : 'Create all 7 rooms',
    exact: true,
  });
  await create.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(zh ? '每场 5 分钟' : '5 minutes');
  expect(requests).toHaveLength(0);
  await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.tournament-room-card b')).toHaveCount(0);
  expect(requests).toHaveLength(0);
  await create.click();
  await page.screenshot({ path: info.outputPath('room-creation-confirmation.png') });
  await dialog.getByRole('button', { name: zh ? '确认' : 'Confirm', exact: true }).click();
  await expect(page.locator('.tournament-room-panel .alert--success')).toContainText(
    zh ? '全部轮次房间已创建' : 'All round rooms created',
  );
  await expect(page.locator('.tournament-room-card b')).toHaveCount(7);
  expect(requests).toHaveLength(1);
  await page.reload();
  await expect(page.locator('.tournament-room-card b')).toHaveCount(7);
});

test('incomplete teams are visible beside the room controls', async ({ page }, info) => {
  const zh = String(info.project.use.locale).startsWith('zh');
  await mock(page, zh ? 'zh-CN' : 'en', false, { incomplete: true });
  await page.goto('/teacher/brackets/teams8');
  for (let i = 0; i < 8; i++) await page.locator('.tournament-input').nth(i).fill(teams[i].name);
  await page.getByRole('button', { name: zh ? '保存到线上' : 'Save online', exact: true }).click();
  const panel = page.locator('.tournament-room-panel');
  await expect(panel.getByRole('alert')).toContainText('团队1 (1/3)');
  await expect(
    panel.getByRole('button', { name: zh ? '批量创建全部 7 个房间' : 'Create all 7 rooms' }),
  ).toBeDisabled();
});

test('room creation errors remain visible beside the room controls', async ({ page }, info) => {
  const zh = String(info.project.use.locale).startsWith('zh');
  await mock(page, zh ? 'zh-CN' : 'en', false, { roomError: true });
  await page.goto('/teacher/brackets/teams8');
  for (let i = 0; i < 8; i++) await page.locator('.tournament-input').nth(i).fill(teams[i].name);
  await page.getByRole('button', { name: zh ? '保存到线上' : 'Save online', exact: true }).click();
  const panel = page.locator('.tournament-room-panel');
  await panel
    .getByRole('button', { name: zh ? '批量创建全部 7 个房间' : 'Create all 7 rooms' })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: zh ? '确认' : 'Confirm', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('所有参赛队伍必须有完整三人名单');
  await expect(page.locator('.tournament-room-card b')).toHaveCount(0);
});

test('round groups refresh lobby status and start a ready match directly', async ({
  page,
}, info) => {
  const zh = String(info.project.use.locale).startsWith('zh');
  await mock(page, zh ? 'zh-CN' : 'en', false, { joinOnRefresh: true });
  await page.goto('/teacher/brackets/teams8');
  for (let i = 0; i < 8; i++) await page.locator('.tournament-input').nth(i).fill(teams[i].name);
  await page.getByRole('button', { name: zh ? '保存到线上' : 'Save online', exact: true }).click();
  await page
    .getByRole('button', { name: zh ? '批量创建全部 7 个房间' : 'Create all 7 rooms' })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: zh ? '确认' : 'Confirm', exact: true })
    .click();
  await expect(page.locator('.tournament-room-round')).toHaveCount(3);
  await expect(page.locator('.tournament-room-round').nth(0).locator('article')).toHaveCount(4);
  await expect(page.locator('.tournament-room-round').nth(1).locator('article')).toHaveCount(2);
  await expect(page.locator('.tournament-room-round').nth(2).locator('article')).toHaveCount(1);
  const first = page.locator('.tournament-room-card').first();
  const start = first.getByRole('button', { name: zh ? '开始比赛' : 'Start match', exact: true });
  await expect(start).toBeDisabled();
  await expect(start).toBeEnabled({ timeout: 10000 });
  await expect(first).toContainText(zh ? '候场队伍：2 / 2' : 'Teams in lobby: 2 / 2');
  await start.click();
  await expect(first).toContainText(zh ? '倒计时' : 'Countdown');
  await expect(start).toHaveCount(0);
  await expect(page.locator('[data-room-round="1"]').first()).toContainText(
    zh ? '等待前一轮晋级确定并保存' : 'Waiting for advancement',
  );
  await page.locator('.tournament-room-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('round-room-management.png'), fullPage: true });
});

test('events batch-create all rounds, synchronize advancement, and remain independent when copied or archived', async ({
  page,
}, info) => {
  const zh = String(info.project.use.locale).startsWith('zh');
  await mock(page, zh ? 'zh-CN' : 'en');
  await page.goto('/teacher/brackets/teams8');
  await page.getByLabel(zh ? '赛事名称' : 'Event name').fill('赛事X');
  for (let i = 0; i < 8; i++) await page.locator('.tournament-input').nth(i).fill(teams[i].name);
  const save = page.getByRole('button', { name: zh ? '保存到线上' : 'Save online', exact: true });
  await save.click();
  await expect(page.getByLabel(zh ? '赛事列表' : 'Events', { exact: true })).toHaveValue('event-0');
  await page
    .getByRole('button', { name: zh ? '批量创建全部 7 个房间' : 'Create all 7 rooms', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: zh ? '确认' : 'Confirm', exact: true })
    .click();
  await expect(page.locator('.tournament-room-card b')).toHaveCount(7);
  await expect(page.locator('.tournament-room-card').first()).toContainText('赛事X-第一轮A组');
  await expect(page.locator('[data-room-round="1"][data-room-match="0"]')).toContainText(
    zh ? '第一轮A组胜者' : 'Winner of Round 1 Group A',
  );
  for (let match = 0; match < 4; match++)
    await page
      .locator(`[data-round="0"][data-match="${match}"] .tournament-advance`)
      .first()
      .click();
  await expect(page.locator('.tournament-impact')).toBeVisible();
  await save.click();
  await expect(page.locator('[data-room-round="1"][data-room-match="0"]')).toContainText(
    '团队1 vs 团队3',
  );
  await page
    .locator('[data-room-round="0"][data-room-match="0"]')
    .getByRole('button', { name: zh ? '清除本场晋级' : 'Clear advancement' })
    .click();
  await save.click();
  await expect(page.locator('[data-room-round="1"][data-room-match="0"]')).toContainText(
    zh ? '第一轮A组胜者' : 'Winner of Round 1 Group A',
  );
  await page.getByRole('button', { name: zh ? '复制为新赛事' : 'Copy as new event' }).click();
  await expect(page.getByLabel(zh ? '赛事列表' : 'Events', { exact: true })).toHaveValue('event-1');
  await expect(page.locator('.tournament-room-card b')).toHaveCount(0);
  await page.getByRole('button', { name: zh ? '归档赛事' : 'Archive event', exact: true }).click();
  await expect(
    page.getByRole('button', { name: zh ? '恢复赛事' : 'Restore event', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.tournament-input').first()).toBeDisabled();
  await page.getByRole('button', { name: zh ? '恢复赛事' : 'Restore event', exact: true }).click();
  await expect(page.locator('.tournament-input').first()).toBeEnabled();
  await expect(
    page.getByLabel(zh ? '赛事列表' : 'Events', { exact: true }).locator('option'),
  ).toHaveCount(3);
  await page.getByLabel(zh ? '赛事列表' : 'Events', { exact: true }).selectOption('event-0');
  await expect(page.locator('.tournament-room-card b')).toHaveCount(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.tournament-room-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('tournament-rooms.png'), fullPage: true });
});
