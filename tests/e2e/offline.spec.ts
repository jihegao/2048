import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const directory = {
  version: 1,
  exportedAt: '2026-10-09T00:00:00.000Z',
  teams: Array.from({ length: 9 }, (_, index) => ({
    id: `offline-${index}`,
    name: `离线队${index + 1}`,
    logo: `icon${index + 1}`,
  })),
};

for (const size of [4, 8]) {
  test(`administrator exports and runs the ${size}-team bracket entirely offline`, async ({
    page,
    context,
  }, testInfo) => {
    await page.route('**/api/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const response =
        pathname === '/api/me'
          ? {
              user: {
                id: 'teacher-1',
                role: 'teacher',
                loginId: 'teacher',
                name: '管理员',
                locale: 'zh-CN',
                studentNumber: null,
                className: null,
                gradeLevel: null,
              },
            }
          : pathname === '/api/teacher/teams/export'
            ? directory
            : { items: [], total: 0, page: 1, pageSize: 20 };
      await route.fulfill({ json: response });
    });
    await page.goto('/teacher/teams');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出离线淘汰赛' }).click();
    const zipFile = testInfo.outputPath('tournament.zip');
    await (await downloaded).saveAs(zipFile);
    const zip = await JSZip.loadAsync(await readFile(zipFile));
    expect(Object.keys(zip.files)).toContain('teams/logos/icon9.svg');
    const folder = testInfo.outputPath('offline');
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const destination = path.join(folder, entry.name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await entry.async('nodebuffer'));
    }

    await context.setOffline(true);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    await page.goto(pathToFileURL(path.join(folder, `${size}-teams.html`)).href);
    await expect(page.locator('.team-input')).toHaveCount(size);
    for (let index = 0; index < size; index++)
      await page.locator('.team-input').nth(index).fill(directory.teams[index].name);
    await expect(page.locator('.team-picture img')).toHaveCount(size);
    for (const image of await page.locator('.team-picture img').all())
      await expect(image).toHaveJSProperty('naturalWidth', 160);
    for (let round = 0; round < Math.log2(size); round++) {
      const stage = page.locator('.bracket-stage').nth(round);
      for (const match of await stage.locator('.match-card').all())
        await match.locator('.advance-button').first().click();
    }
    await expect(page.locator('.champion-name')).toHaveText('离线队1');
    await expect(page.locator('.champion-picture img')).toHaveAttribute(
      'src',
      'teams/logos/icon1.svg',
    );
    await page.screenshot({
      path: testInfo.outputPath(`offline-${size}-champion.png`),
      fullPage: true,
    });

    const progressDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '保存进度' }).click();
    const backup = testInfo.outputPath('progress.json');
    await (await progressDownload).saveAs(backup);
    await page.reload();
    await expect(page.locator('.champion-name')).toHaveText('离线队1');
    await page.locator('.team-input').first().fill('离线队9');
    await expect(page.locator('.champion-name')).toHaveText('冠军待定');
    await expect(page.locator('.team-picture img').first()).toHaveAttribute(
      'src',
      'teams/logos/icon9.svg',
    );
    await page.locator('.team-input').first().fill('未导出的队伍');
    await expect(page.locator('.team-picture').first().locator('img')).toHaveCount(0);
    await expect(page.locator('.team-error').first()).toContainText('未找到团队');
    await page.locator('#progress-file').setInputFiles(backup);
    await expect(page.locator('.champion-name')).toHaveText('离线队1');
    await page.locator('#language').click();
    await expect(page.locator('#title')).toHaveText(`${size} team tournament`);
    expect(requests).toEqual([]);
  });
}
