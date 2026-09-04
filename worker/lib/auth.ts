import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Locale, Role } from '../../shared/types';
import type { AppHonoEnv, AuthUser } from '../app-types';
import type { DbUser } from './db';
import { uuid } from './db';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto';
import { passwordIterations, secret } from './env';
import { AppError } from './errors';

export const SESSION_COOKIE = '__Host-session';
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

function toAuthUser(row: DbUser): AuthUser {
  return {
    id: row.id,
    loginId: row.login_id,
    studentNumber: row.student_no ?? '',
    name: row.display_name,
    className: row.class_name,
    gradeLevel: row.grade_level,
    role: row.role,
    locale: row.locale,
  };
}

export async function ensureBootstrapTeacher(env: Env): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'teacher' LIMIT 1",
  ).first();
  if (existing) return;

  const loginId = secret(env, 'BOOTSTRAP_TEACHER_USERNAME').trim();
  const password = secret(env, 'BOOTSTRAP_TEACHER_PASSWORD');
  const displayName = secret(env, 'BOOTSTRAP_TEACHER_NAME').trim();
  const pepper = secret(env, 'PASSWORD_PEPPER');
  if (!loginId || !displayName || password.length < 12) {
    throw new AppError(503, 'SERVER_NOT_CONFIGURED', '教师初始账号配置无效');
  }

  const salt = randomToken(16);
  const iterations = passwordIterations(env);
  const passwordHash = await hashPassword(password, salt, iterations, pepper);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (
      id, login_id, role, student_no, display_name, class_name, locale,
      password_hash, password_salt, password_iterations, created_at, updated_at
    ) VALUES (?, ?, 'teacher', NULL, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
  )
    .bind(uuid(), loginId, displayName, passwordHash, salt, iterations, now, now)
    .run();
}

async function guardRequest(
  env: Env,
  key: string,
  action: 'check' | 'failure' | 'success',
): Promise<{ allowed?: boolean; retryAfterSeconds?: number }> {
  const name = await sha256(key);
  const stub = env.LOGIN_GUARD.get(env.LOGIN_GUARD.idFromName(name));
  const response = await stub.fetch('https://login-guard.internal/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) throw new AppError(503, 'LOGIN_GUARD_UNAVAILABLE', '登录服务暂时不可用');
  return response.json();
}

export async function authenticatePassword(
  env: Env,
  loginId: string,
  password: string,
  requestIp: string,
): Promise<DbUser | null> {
  const guardKey = `${requestIp}\u0000${loginId.toLocaleLowerCase('en-US')}`;
  const check = await guardRequest(env, guardKey, 'check');
  if (check.allowed === false) {
    throw new AppError(429, 'LOGIN_RATE_LIMITED', '登录尝试过多，请稍后再试');
  }

  const row = await env.DB.prepare('SELECT * FROM users WHERE login_id = ? LIMIT 1')
    .bind(loginId)
    .first<DbUser>();
  const pepper = secret(env, 'PASSWORD_PEPPER');
  const valid =
    row &&
    (await verifyPassword(
      password,
      row.password_salt,
      row.password_iterations,
      pepper,
      row.password_hash,
    ));

  await guardRequest(env, guardKey, valid ? 'success' : 'failure');
  return valid ? row : null;
}

export async function createSession(c: Context<AppHonoEnv>, userId: string): Promise<void> {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(tokenHash, userId, now, now + SESSION_DURATION_SECONDS * 1000, now)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_DURATION_SECONDS,
  });
}

export async function destroySession(c: Context<AppHonoEnv>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
      .bind(await sha256(token))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

export async function sessionUser(c: Context<AppHonoEnv>): Promise<AuthUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?
     LIMIT 1`,
  )
    .bind(await sha256(token), now)
    .first<DbUser>();
  if (!row) {
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return null;
  }
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
      .bind(now, await sha256(token))
      .run(),
  );
  return toAuthUser(row);
}

export const requireAuth: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  const user = await sessionUser(c);
  if (!user) throw new AppError(401, 'AUTH_REQUIRED', '请先登录');
  c.set('user', user);
  await next();
};

export function requireRole(role: Role): MiddlewareHandler<AppHonoEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (user.role !== role) throw new AppError(403, 'FORBIDDEN', '无权执行此操作');
    await next();
  };
}

export async function updateLocale(env: Env, userId: string, locale: Locale): Promise<void> {
  await env.DB.prepare('UPDATE users SET locale = ?, updated_at = ? WHERE id = ?')
    .bind(locale, Date.now(), userId)
    .run();
}
