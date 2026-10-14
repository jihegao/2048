import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { OfflineTeamDirectory } from '../../shared/offline-teams';
const origin = 'https://example.com';

describe('administrator team export', () => {
  it('requires a teacher session', async () => {
    const response = await exports.default.fetch(`${origin}/api/teacher/teams/export`);
    expect(response.status).toBe(401);
  });

  it('exports all active teams and actual logo IDs without members or secrets', async () => {
    const login = await exports.default.fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loginId: 'teacher', password: 'integration-teacher-password' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO teams (id, code, name, logo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind('export-svg', 'EXPORT1', '导出图标队', 'icon9', now, now),
      env.DB.prepare(
        'INSERT INTO teams (id, code, name, logo, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind('export-deleted', 'EXPORT2', '已解散队', 'icon1', now, now, now),
    ]);
    const response = await exports.default.fetch(`${origin}/api/teacher/teams/export`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = (await response.json()) as OfflineTeamDirectory;
    expect(payload.version).toBe(1);
    expect(payload.teams).toContainEqual({ id: 'export-svg', name: '导出图标队', logo: 'icon9' });
    expect(payload.teams.some((team) => team.id === 'export-deleted')).toBe(false);
    for (const team of payload.teams)
      expect(Object.keys(team).sort()).toEqual(['id', 'logo', 'name']);
  });
});
