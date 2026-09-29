import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppHonoEnv } from '../app-types';
import { uuid } from '../lib/db';
import { AppError } from '../lib/errors';
import {
  openTeamPracticePeriod,
  tryFreezeTeamPracticePeriod,
  type TeamPracticePeriod,
} from '../lib/team-practice-periods';

const periodInput = z.object({ name: z.string().trim().min(1).max(80) });

export const teacherTeamPracticePeriodRoutes = new Hono<AppHonoEnv>();
export const studentTeamPracticePeriodRoutes = new Hono<AppHonoEnv>();

teacherTeamPracticePeriodRoutes.get('/', async (c) => {
  const periods = await c.env.DB.prepare(
    'SELECT * FROM team_practice_periods ORDER BY created_at DESC, id DESC',
  ).all<TeamPracticePeriod>();
  return c.json({ items: periods.results });
});

teacherTeamPracticePeriodRoutes.post('/', async (c) => {
  const parsed = periodInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '练习期名称无效');
  const id = uuid();
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO team_practice_periods
       (id, name, status, created_by, created_at) VALUES (?, ?, 'open', ?, ?)`,
    )
      .bind(id, parsed.data.name, c.get('user').id, now)
      .run();
  } catch {
    throw new AppError(409, 'TEAM_PRACTICE_PERIOD_OPEN', '已有开放的团队练习期');
  }
  return c.json({ period: await openTeamPracticePeriod(c.env.DB) }, 201);
});

teacherTeamPracticePeriodRoutes.post('/:id/close', async (c) => {
  const id = c.req.param('id');
  const changed = await c.env.DB.prepare(
    `UPDATE team_practice_periods SET status = 'closing', closed_at = ?
     WHERE id = ? AND status = 'open'`,
  )
    .bind(Date.now(), id)
    .run();
  if (!changed.meta.changes)
    throw new AppError(409, 'TEAM_PRACTICE_PERIOD_NOT_OPEN', '练习期未开放');
  await tryFreezeTeamPracticePeriod(c.env.DB, id);
  const period = await c.env.DB.prepare('SELECT * FROM team_practice_periods WHERE id = ?')
    .bind(id)
    .first<TeamPracticePeriod>();
  return c.json({ period });
});

studentTeamPracticePeriodRoutes.get('/current', async (c) =>
  c.json({ period: await openTeamPracticePeriod(c.env.DB) }),
);

studentTeamPracticePeriodRoutes.get('/', async (c) => {
  const periods = await c.env.DB.prepare(
    'SELECT id, name, status, created_at, closed_at, frozen_at FROM team_practice_periods ORDER BY created_at DESC, id DESC',
  ).all<TeamPracticePeriod>();
  return c.json({ items: periods.results });
});

async function periodResults(c: Context<AppHonoEnv>) {
  const id = c.req.param('id');
  const period = await c.env.DB.prepare('SELECT * FROM team_practice_periods WHERE id = ?')
    .bind(id)
    .first<TeamPracticePeriod>();
  if (!period) throw new AppError(404, 'TEAM_PRACTICE_PERIOD_NOT_FOUND', '练习期不存在');
  const standings =
    period.status === 'frozen'
      ? await c.env.DB.prepare(
          `SELECT team_id, team_name_snapshot, wins, draws, losses, points, matches
       FROM team_period_standings WHERE team_practice_period_id = ?
       ORDER BY points DESC, wins DESC, team_id`,
        )
          .bind(id)
          .all()
      : await c.env.DB.prepare(
          `SELECT m.team_id,
              (SELECT latest.team_name_snapshot FROM team_match_results latest
               WHERE latest.team_practice_period_id = m.team_practice_period_id
                 AND latest.team_id = m.team_id
               ORDER BY latest.settled_at DESC, latest.room_id DESC LIMIT 1) AS team_name_snapshot,
              SUM(m.outcome = 'win') AS wins, SUM(m.outcome = 'draw') AS draws,
              SUM(m.outcome = 'loss') AS losses, SUM(m.points) AS points, COUNT(*) AS matches
       FROM team_match_results m WHERE m.team_practice_period_id = ?
       GROUP BY m.team_practice_period_id, m.team_id
       ORDER BY points DESC, wins DESC, m.team_id`,
        )
          .bind(id)
          .all();
  const rosterField = c.get('user').role === 'teacher' ? ', roster_snapshot_json' : '';
  const matches = await c.env.DB.prepare(
    `SELECT room_id, team_id, side, outcome, points, team_score,
            team_name_snapshot, started_at, settled_at${rosterField}
     FROM team_match_results WHERE team_practice_period_id = ?
     ORDER BY started_at DESC, room_id, side`,
  )
    .bind(id)
    .all();
  return c.json({ period, standings: standings.results, matches: matches.results });
}

teacherTeamPracticePeriodRoutes.get('/:id/results', periodResults);
studentTeamPracticePeriodRoutes.get('/:id/results', periodResults);
