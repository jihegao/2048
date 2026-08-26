import { DurableObject } from 'cloudflare:workers';

type Action = 'check' | 'failure' | 'success';

interface GuardRow extends Record<string, SqlStorageValue> {
  failures: number;
  window_started_at: number;
  blocked_until: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export class LoginGuard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS login_guard (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        failures INTEGER NOT NULL,
        window_started_at INTEGER NOT NULL,
        blocked_until INTEGER NOT NULL
      )
    `);
  }

  private row(): GuardRow | null {
    const rows = this.ctx.storage.sql.exec<GuardRow>(
      'SELECT failures, window_started_at, blocked_until FROM login_guard WHERE id = 1',
    );
    return [...rows][0] ?? null;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const body = (await request.json()) as { action?: Action };
    const action = body.action;
    const now = Date.now();
    const current = this.row();

    if (action === 'check') {
      const blockedUntil = current?.blocked_until ?? 0;
      return Response.json({
        allowed: blockedUntil <= now,
        retryAfterSeconds: blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : 0,
      });
    }

    if (action === 'success') {
      this.ctx.storage.sql.exec('DELETE FROM login_guard WHERE id = 1');
      return Response.json({ ok: true });
    }

    if (action === 'failure') {
      const inWindow = current && now - current.window_started_at < WINDOW_MS;
      const failures = inWindow ? current.failures + 1 : 1;
      const blockedUntil = failures >= MAX_FAILURES ? now + BLOCK_MS : 0;
      this.ctx.storage.sql.exec(
        `INSERT INTO login_guard (id, failures, window_started_at, blocked_until)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           failures = excluded.failures,
           window_started_at = excluded.window_started_at,
           blocked_until = excluded.blocked_until`,
        failures,
        inWindow ? current.window_started_at : now,
        blockedUntil,
      );
      return Response.json({ ok: true, blocked: blockedUntil > 0 });
    }

    return Response.json({ error: 'Invalid action' }, { status: 400 });
  }
}
