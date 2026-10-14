import { Hono } from 'hono';
import type { AppHonoEnv } from './app-types';
import application from './index';
import { requireAuth, requireRole } from './lib/auth';
import { errorResponse } from './lib/errors';
import { maintenanceResponse, migrationMode } from './lib/migration';
import { authorizedCandidateRequest } from './lib/migration-candidate-gate';
import { migrationKeyProof } from './lib/migration-key-proof';

export { LoginGuard, RoomSession } from './index';

// Only the signed CLOSED candidate can reach this temporary route. It uses the
// normal teacher session and Origin checks, and preserves each waiting room's
// original deadline. Rearming overdue rooms invokes the existing expiry logic.
const recovery = new Hono<AppHonoEnv>();
recovery.onError((error, c) => errorResponse(c, error));
recovery.use('*', async (c, next) => {
  if ((await migrationMode(c.env)) !== 'normal') return maintenanceResponse();
  if (c.req.header('Origin') !== 'https://mingcheng1024.cn') {
    return c.json({ error: { code: 'ORIGIN_REJECTED' } }, 403);
  }
  await next();
});
recovery.use('*', requireAuth, requireRole('teacher'));
recovery.post('/api/teacher/_migration/rearm-waiting', async (c) => {
  const waiting = await c.env.DB.prepare(
    "SELECT id FROM rooms WHERE student_created=1 AND status IN ('open','full') ORDER BY id LIMIT 101",
  ).all<{ id: string }>();
  if (waiting.results.length > 100) {
    return c.json({ error: { code: 'MIGRATION_WAITING_ROOM_LIMIT' } }, 409);
  }
  let expired = 0;
  for (const room of waiting.results) {
    if ((await migrationMode(c.env)) !== 'normal') return maintenanceResponse();
    const response = await c.env.ROOMS.get(c.env.ROOMS.idFromName(room.id)).fetch(
      'https://room.internal/arm-expiry',
      { method: 'POST', headers: { 'X-Room-Id': room.id } },
    );
    if (!response.ok) return c.json({ error: { code: 'MIGRATION_REARM_FAILED' } }, 503);
    if (((await response.json()) as { expired?: boolean }).expired) expired++;
  }
  return c.json({ ok: true, rearmed: waiting.results.length, expired });
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const proof = await migrationKeyProof(request, env);
    if (proof) return proof;
    const authorized = await authorizedCandidateRequest(request, env);
    if (!authorized) return maintenanceResponse();
    if (new URL(authorized.url).pathname === '/api/teacher/_migration/rearm-waiting') {
      return recovery.fetch(authorized, env, ctx);
    }
    // The application still checks the D1 fence, normal authentication, roles
    // and Origin. A valid operator signature alone cannot open a frozen DB.
    return application.fetch(authorized, env, ctx);
  },
  async scheduled(): Promise<void> {
    // Acceptance is controlled by the operator. Cron stays off until release.
  },
};
