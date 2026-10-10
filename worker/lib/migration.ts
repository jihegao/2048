import { AppError } from './errors';

export type MigrationMode = 'normal' | 'drain' | 'frozen';
export const MIGRATION_CONTROL_TABLE = '__2048_write_fence';

export function migrationBinding(env: Env, name: string): unknown {
  return (env as unknown as Record<string, unknown>)[name];
}

export async function migrationMode(env: Env): Promise<MigrationMode> {
  const configured = migrationBinding(env, 'MIGRATION_MODE');
  const mode = configured === undefined ? 'normal' : configured;
  if (!['normal', 'drain', 'frozen'].includes(String(mode))) return 'frozen';
  // A closed preparation Worker cannot be opened by changing only its database.
  if (mode === 'frozen') return 'frozen';
  if (migrationBinding(env, 'MIGRATION_USE_D1_CONTROL') !== 'true') {
    return mode as MigrationMode;
  }
  try {
    const row = await env.DB.prepare(
      `SELECT phase FROM ${MIGRATION_CONTROL_TABLE} WHERE id = 1`,
    ).first<{ phase: string }>();
    if (!row || !['normal', 'drain', 'frozen'].includes(row.phase)) return 'frozen';
    if (row.phase === 'frozen') return 'frozen';
    return row.phase === 'drain' || mode === 'drain' ? 'drain' : 'normal';
  } catch {
    // Missing or unreadable control state fails closed; never assume normal.
    return 'frozen';
  }
}

export function maintenanceResponse(mode: MigrationMode = 'frozen'): Response {
  return Response.json(
    {
      error: {
        code: mode === 'drain' ? 'MIGRATION_DRAINING' : 'MIGRATION_MAINTENANCE',
        message:
          mode === 'drain'
            ? '迁移准备中，暂不开始新局；请完成当前对局并确认成绩已保存'
            : '迁移维护中，请稍后重试',
      },
    },
    { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' } },
  );
}

export async function requireNewGameAllowed(env: Env): Promise<void> {
  if ((await migrationMode(env)) !== 'normal') {
    throw new AppError(503, 'MIGRATION_DRAINING', '迁移准备中，请完成当前对局并确认成绩已保存');
  }
}

export function allowedWhileDraining(method: string, path: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  if (method !== 'POST') return false;
  return [
    '/api/auth/login',
    '/api/auth/logout',
    '/api/practice/complete',
    '/api/practice/timed/start', // Route permits resuming, never creates a new session.
    '/api/practice/timed/move',
    '/api/practice/timed/moves',
    '/api/practice/timed/finish',
  ].includes(path);
}
