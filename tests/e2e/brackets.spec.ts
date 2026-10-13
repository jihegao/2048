import { expect, test, type Page } from '@playwright/test';
import { emptyBracket, type BracketKind, type BracketSnapshot } from '../../shared/brackets';
const teams = Array.from({ length: 9 }, (_, i) => ({
  id: `team-${i}`,
  name: `团队${i + 1}`,
  label: `团队${i + 1}`,
  logo: `icon${i + 1}`,
}));
const students = Array.from({ length: 16 }, (_, i) => ({
  id: `student-${i}`,
  name: `学生${i + 1}`,
  label: `学生${i + 1} · 六班 · S${i + 1}`,
  logo: null,
}));
async function mock(page: Page, locale: string, conflict = false) {
  const records: Record<BracketKind, BracketSnapshot> = {
    teams8: { state: emptyBracket('teams8'), revision: 0, updatedAt: null },
    players16: { state: emptyBracket('players16'), revision: 0, updatedAt: null },
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/api/me')
      return route.fulfill({
        json: {
          user: { id: 'teacher-test', role: 'teacher', name: '管理员', loginId: 'teacher', locale },
        },
      });
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
        json: { ...records[kind], catalog: kind === 'teams8' ? teams : students },
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
