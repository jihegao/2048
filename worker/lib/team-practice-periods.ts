export interface TeamPracticePeriod {
  id: string;
  name: string;
  status: 'open' | 'closing' | 'frozen';
  created_at: number;
  closed_at: number | null;
  frozen_at: number | null;
}

export async function openTeamPracticePeriod(db: D1Database): Promise<TeamPracticePeriod | null> {
  return db
    .prepare("SELECT * FROM team_practice_periods WHERE status = 'open' LIMIT 1")
    .first<TeamPracticePeriod>();
}

// Closing stops new starts. A period freezes only after every started room has
// settled. The INSERT and state change share one D1 transaction.
export async function tryFreezeTeamPracticePeriod(db: D1Database, periodId: string): Promise<void> {
  const now = Date.now();
  const ready = `EXISTS (SELECT 1 FROM team_practice_periods p
      WHERE p.id = ? AND p.status = 'closing')
    AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.team_practice_period_id = ?
      AND r.status IN ('countdown', 'live'))`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO team_period_standings (
         team_practice_period_id, team_id, team_name_snapshot,
         wins, draws, losses, points, matches, frozen_at
       )
       SELECT m.team_practice_period_id, m.team_id,
              (SELECT latest.team_name_snapshot FROM team_match_results latest
               WHERE latest.team_practice_period_id = m.team_practice_period_id
                 AND latest.team_id = m.team_id
               ORDER BY latest.settled_at DESC, latest.room_id DESC LIMIT 1),
              SUM(m.outcome = 'win'), SUM(m.outcome = 'draw'), SUM(m.outcome = 'loss'),
              SUM(m.points), COUNT(*), ?
       FROM team_match_results m
       WHERE m.team_practice_period_id = ? AND ${ready}
       GROUP BY m.team_practice_period_id, m.team_id
       ON CONFLICT(team_practice_period_id, team_id) DO NOTHING`,
      )
      .bind(now, periodId, periodId, periodId),
    db
      .prepare(
        `UPDATE team_practice_periods SET status = 'frozen', frozen_at = ?
       WHERE id = ? AND status = 'closing'
         AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.team_practice_period_id = ?
           AND r.status IN ('countdown', 'live'))`,
      )
      .bind(now, periodId, periodId),
  ]);
}
