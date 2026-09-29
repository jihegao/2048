import type { GradeLabel, GradeLevel } from '../../shared/types';

export type RankingGrade = 'K' | `${GradeLevel}`;
export type TeamGroup = 'K' | '1-2' | '3-5' | '6-12';

export interface UserGradeResolution {
  user_id: string;
  raw_grade_level: GradeLevel | null;
  raw_grade_code: string | null;
  ranking_grade: RankingGrade | null;
  team_group: TeamGroup | null;
}

export function teamGroupForGrade(grade: RankingGrade): TeamGroup {
  if (grade === 'K') return 'K';
  const level = Number(grade);
  if (level <= 2) return '1-2';
  if (level <= 5) return '3-5';
  return '6-12';
}

export function rankingGradeForInput(
  raw: GradeLabel,
  confirmed?: RankingGrade | null,
): RankingGrade | null {
  if (typeof raw === 'number') return String(raw) as RankingGrade;
  if (raw === 'K') return 'K';
  return confirmed ?? null;
}

export async function getUserGradeResolution(
  db: D1Database,
  userId: string,
): Promise<UserGradeResolution | null> {
  return db
    .prepare('SELECT * FROM student_grade_resolution WHERE user_id = ?')
    .bind(userId)
    .first<UserGradeResolution>();
}

export interface TeamGradeResolution {
  group: TeamGroup | null;
  memberCount: number;
  members: Array<{ userId: string; rankingGrade: RankingGrade | null; group: TeamGroup | null }>;
}

export async function getTeamGradeResolution(
  db: D1Database,
  teamId: string,
): Promise<TeamGradeResolution> {
  const rows = await db
    .prepare(
      `SELECT tm.user_id, g.ranking_grade, g.team_group
     FROM team_members tm
     LEFT JOIN student_grade_resolution g ON g.user_id = tm.user_id
     WHERE tm.team_id = ? ORDER BY tm.joined_at, tm.user_id`,
    )
    .bind(teamId)
    .all<{ user_id: string; ranking_grade: RankingGrade | null; team_group: TeamGroup | null }>();
  const members = rows.results.map((row) => ({
    userId: row.user_id,
    rankingGrade: row.ranking_grade,
    group: row.team_group,
  }));
  const firstGroup = members[0]?.group ?? null;
  return {
    group: firstGroup && members.every((member) => member.group === firstGroup) ? firstGroup : null,
    memberCount: members.length,
    members,
  };
}
