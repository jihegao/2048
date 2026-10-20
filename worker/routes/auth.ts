import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppHonoEnv } from '../app-types';
import {
  AUTH_COOKIE_OPTIONS,
  hasSessionCookie,
  authenticatePassword,
  changePassword,
  createSession,
  destroySession,
  ensureBootstrapTeacher,
  requireAuth,
  sessionUser,
  updateLocale,
} from '../lib/auth';
import { AppError, zodIssues } from '../lib/errors';
import { localeSchema, loginSchema, passwordChangeSchema } from '../schemas';

export const authRoutes = new Hono<AppHonoEnv>();

// A separate short-lived, identity-free cookie; never reads or changes a session.
authRoutes.post('/auth/cookie-check', (c) => {
  const challenge = crypto.randomUUID();
  setCookie(c, `__Host-cookie-check-${challenge}`, '1', {
    ...AUTH_COOKIE_OPTIONS,
    maxAge: 120,
  });
  return c.json({ challenge });
});

authRoutes.post('/auth/cookie-check/confirm', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { challenge?: unknown } | null;
  if (typeof body?.challenge !== 'string' || !/^[0-9a-f-]{36}$/.test(body.challenge)) {
    throw new AppError(422, 'VALIDATION_ERROR', 'Cookie 检测参数无效');
  }
  const name = `__Host-cookie-check-${body.challenge}`;
  const supported = getCookie(c, name) === '1';
  deleteCookie(c, name, AUTH_COOKIE_OPTIONS);
  return c.json({ supported });
});

authRoutes.post('/auth/session-confirm', async (c) => {
  const present = hasSessionCookie(c);
  const session = await sessionUser(c);
  return c.json({
    state: session ? 'valid' : present ? 'invalid' : 'missing',
    user: session?.user ?? null,
  });
});

authRoutes.post('/auth/login', async (c) => {
  await ensureBootstrapTeacher(c.env);
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(422, 'VALIDATION_ERROR', '登录信息有误', zodIssues(parsed.error.issues));
  }

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const row = await authenticatePassword(c.env, parsed.data.loginId, parsed.data.password, ip);
  if (!row) throw new AppError(401, 'INVALID_CREDENTIALS', '账号或密码错误');

  if (row.locale === null && parsed.data.locale) {
    try {
      await updateLocale(c.env, row.id, parsed.data.locale);
      row.locale = parsed.data.locale;
    } catch {
      console.warn(JSON.stringify({ event: 'login_locale_update_failed' }));
    }
  }
  await createSession(c, { id: row.id, role: row.role }, row.credential_version);
  return c.json({
    user: {
      id: row.id,
      loginId: row.login_id,
      studentNumber: row.student_no ?? '',
      name: row.display_name,
      className: row.class_name,
      gradeLevel: row.grade_code ?? row.grade_level,
      role: row.role,
      locale: row.locale,
    },
  });
});

authRoutes.post('/auth/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true, message: '已退出登录' });
});

authRoutes.get('/me', async (c) => {
  const session = await sessionUser(c);
  return c.json({ user: session?.user ?? null });
});

authRoutes.patch('/me/locale', requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { locale?: unknown } | null;
  const parsed = localeSchema.safeParse(body?.locale);
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '语言设置无效');
  await updateLocale(c.env, c.get('user').id, parsed.data);
  return c.json({ ok: true, locale: parsed.data, message: '语言设置已保存' });
});

authRoutes.patch('/me/password', requireAuth, async (c) => {
  const parsed = passwordChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(422, 'VALIDATION_ERROR', '密码信息有误', zodIssues(parsed.error.issues));
  }
  await changePassword(c, parsed.data.currentPassword, parsed.data.newPassword);
  return c.json({ ok: true, message: '密码已修改，请使用新密码重新登录' });
});
