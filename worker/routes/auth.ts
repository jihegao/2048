import { Hono } from 'hono';
import type { AppHonoEnv } from '../app-types';
import {
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
    await updateLocale(c.env, row.id, parsed.data.locale);
    row.locale = parsed.data.locale;
  }
  await createSession(c, row.id, row.credential_version);
  return c.json({
    user: {
      id: row.id,
      loginId: row.login_id,
      studentNumber: row.student_no ?? '',
      name: row.display_name,
      className: row.class_name,
      gradeLevel: row.grade_level,
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
  const user = await sessionUser(c);
  return c.json({ user });
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
