import { Hono } from 'hono';
import type { AppHonoEnv } from './app-types';
import { LoginGuard } from './durable/login-guard';
import { RoomSession } from './durable/room-session';
import { requireAuth, requireRole } from './lib/auth';
import { errorResponse } from './lib/errors';
import { authRoutes } from './routes/auth';
import { practiceRoutes } from './routes/practice';
import {
  studentLeaderboardRoutes,
  teacherLeaderboardPeriodRoutes,
  teacherLeaderboardRoutes,
} from './routes/leaderboards';
import { studentResultRoutes, teacherResultRoutes } from './routes/results';
import { roomWebSocket, studentRoomRoutes, teacherRoomRoutes } from './routes/rooms';
import { studentTeamRoutes, teacherTeamRoutes } from './routes/teams';
import { userRoutes } from './routes/users';

const app = new Hono<AppHonoEnv>();

app.onError((error, c) => errorResponse(c, error));

app.use('/api/*', async (c, next) => {
  const requestId = c.req.header('CF-Ray') ?? crypto.randomUUID();
  const startedAt = Date.now();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');

  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (unsafe) {
    const origin = c.req.header('Origin');
    const expectedOrigin = new URL(c.req.url).origin;
    const fetchSite = c.req.header('Sec-Fetch-Site');
    if ((origin && origin !== expectedOrigin) || fetchSite === 'cross-site') {
      return c.json({ error: { code: 'ORIGIN_REJECTED', message: '请求来源校验失败' } }, 403);
    }
  }

  await next();
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'request_complete',
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    }),
  );
});

app.get('/api/health', (c) => c.json({ ok: true }));
app.route('/api', authRoutes);

app.use('/api/teacher/*', requireAuth, requireRole('teacher'));
app.route('/api/teacher/rooms', teacherRoomRoutes);
app.route('/api/teacher/users', userRoutes);
app.route('/api/teacher/teams', teacherTeamRoutes);
app.route('/api/teacher/results', teacherResultRoutes);
app.route('/api/teacher/leaderboard-periods', teacherLeaderboardPeriodRoutes);
app.route('/api/teacher/leaderboards', teacherLeaderboardRoutes);

app.get('/api/rooms/:id/ws', requireAuth, roomWebSocket);
app.use('/api/rooms/*', requireAuth, requireRole('student'));
app.use('/api/rooms', requireAuth, requireRole('student'));
app.route('/api/rooms', studentRoomRoutes);
app.use('/api/practice/*', requireAuth, requireRole('student'));
app.route('/api/practice', practiceRoutes);
app.use('/api/leaderboard', requireAuth, requireRole('student'));
app.route('/api/leaderboard', studentLeaderboardRoutes);
app.use('/api/me/results', requireAuth, requireRole('student'));
app.route('/api', studentResultRoutes);
app.use('/api/me/team', requireAuth, requireRole('student'));
app.use('/api/teams/*', requireAuth, requireRole('student'));
app.route('/api', studentTeamRoutes);

app.all('/api/*', (c) => c.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404));

// Do not let the retired high-fidelity design URL fall through to the SPA shell.
app.all('/timing-design', (c) => c.notFound());
app.all('/timing-design/', (c) => c.notFound());
app.all('/timing-design/*', (c) => c.notFound());
app.all('/timing-design.html', (c) => c.notFound());

app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export { LoginGuard, RoomSession };
export default app;
