import { Hono } from 'hono';
import type { AppHonoEnv } from '../app-types';
import { teamCode, uuid } from '../lib/db';
import { AppError, zodIssues } from '../lib/errors';
import { issueImportToken, verifyImportToken } from '../lib/imports';
import { readImportJson } from '../lib/request';
import {
  importCommitSchema,
  importValidateSchema,
  paginationSchema,
  teamImportRowSchema,
} from '../schemas';

interface TeamImportRow {
  name: string;
  memberStudentNumbers: string[];
}

interface ExistingTeam {
  id: string;
  name: string;
  code: string;
}

interface MemberLookup {
  student_no: string;
  user_id: string;
  team_id: string | null;
}

function validateRows(input: unknown): {
  rows: TeamImportRow[];
  errors: Array<{ row: number; field: string; message: string }>;
} {
  const body = importValidateSchema.safeParse(input);
  if (!body.success) throw new AppError(422, 'VALIDATION_ERROR', '导入数据格式无效');
  if (body.data.rows.length === 0) throw new AppError(422, 'EMPTY_IMPORT', '导入文件没有数据');
  if (body.data.rows.length > 1000)
    throw new AppError(422, 'IMPORT_TOO_LARGE', '团队导入单次最多1000行');

  const rows: TeamImportRow[] = [];
  const errors: Array<{ row: number; field: string; message: string }> = [];
  const seenNames = new Set<string>();
  const seenMembers = new Set<string>();
  body.data.rows.forEach((raw, index) => {
    const parsed = teamImportRowSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of zodIssues(parsed.error.issues)) {
        errors.push({ row: index + 2, field: issue.path, message: issue.message });
      }
      return;
    }
    if (seenNames.has(parsed.data.name)) {
      errors.push({ row: index + 2, field: 'name', message: '团队名称在导入文件中重复' });
      return;
    }
    const duplicateMember = parsed.data.memberStudentNumbers.find((member) =>
      seenMembers.has(member),
    );
    if (duplicateMember) {
      errors.push({
        row: index + 2,
        field: 'memberStudentNumbers',
        message: `学号${duplicateMember}被分配到多个团队`,
      });
      return;
    }
    seenNames.add(parsed.data.name);
    parsed.data.memberStudentNumbers.forEach((member) => seenMembers.add(member));
    rows.push(parsed.data);
  });
  return { rows, errors };
}

async function teamImportContext(env: Env, rows: TeamImportRow[]) {
  const names = rows.map((row) => row.name);
  const studentNumbers = rows.flatMap((row) => row.memberStudentNumbers);
  const [teamRows, memberRows] = await Promise.all([
    env.DB.prepare(
      'SELECT id, name, code FROM teams WHERE name IN (SELECT value FROM json_each(?))',
    )
      .bind(JSON.stringify(names))
      .all<ExistingTeam>(),
    env.DB.prepare(
      `SELECT u.student_no, u.id AS user_id, tm.team_id
       FROM users u
       LEFT JOIN team_members tm ON tm.user_id = u.id
       WHERE u.role = 'student' AND u.student_no IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(studentNumbers))
      .all<MemberLookup>(),
  ]);
  return {
    teams: new Map(teamRows.results.map((team) => [team.name, team])),
    members: new Map(memberRows.results.map((member) => [member.student_no, member])),
  };
}

async function validateTeamBusinessRules(env: Env, rows: TeamImportRow[]) {
  const context = await teamImportContext(env, rows);
  const errors: Array<{ row: number; field: string; message: string }> = [];
  const targetTeamIds = new Set(
    rows.map((row) => context.teams.get(row.name)?.id).filter((id): id is string => Boolean(id)),
  );
  rows.forEach((row, index) => {
    row.memberStudentNumbers.forEach((studentNumber) => {
      const member = context.members.get(studentNumber);
      if (!member) {
        errors.push({
          row: index + 2,
          field: 'memberStudentNumbers',
          message: `学生${studentNumber}不存在`,
        });
      } else if (member.team_id && !targetTeamIds.has(member.team_id)) {
        errors.push({
          row: index + 2,
          field: 'memberStudentNumbers',
          message: `学生${studentNumber}已属于其他团队`,
        });
      }
    });
  });

  if (targetTeamIds.size > 0) {
    const frozen = await env.DB.prepare(
      `SELECT DISTINCT tm.team_id
       FROM team_members tm
       JOIN active_participations ap ON ap.user_id = tm.user_id
       WHERE tm.team_id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify([...targetTeamIds]))
      .all<{ team_id: string }>();
    const frozenIds = new Set(frozen.results.map((row) => row.team_id));
    rows.forEach((row, index) => {
      const teamId = context.teams.get(row.name)?.id;
      if (teamId && frozenIds.has(teamId)) {
        errors.push({ row: index + 2, field: 'name', message: '团队正在候场或比赛，不能导入更新' });
      }
    });
  }
  return { ...context, errors };
}

async function assertTeamMutable(env: Env, teamId: string): Promise<void> {
  const frozen = await env.DB.prepare(
    `SELECT 1 FROM team_members tm
     JOIN active_participations ap ON ap.user_id = tm.user_id
     WHERE tm.team_id = ? LIMIT 1`,
  )
    .bind(teamId)
    .first();
  if (frozen) throw new AppError(409, 'TEAM_FROZEN', '团队正在候场或比赛，暂时不能修改成员');
}

export const teacherTeamRoutes = new Hono<AppHonoEnv>();

teacherTeamRoutes.get('/', async (c) => {
  const parsed = paginationSchema.safeParse(c.req.query());
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '查询参数无效');
  const { page, pageSize, query } = parsed.data;
  const search = query ? `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%` : null;
  const where = search ? "WHERE (t.name LIKE ? ESCAPE '\\' OR t.code LIKE ? ESCAPE '\\')" : '';
  const binds = search ? [search, search] : [];
  const offset = (page - 1) * pageSize;
  const [teams, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.id, t.name, t.code, t.created_at,
              CASE WHEN EXISTS (
                SELECT 1 FROM team_members tx JOIN active_participations ap ON ap.user_id = tx.user_id
                WHERE tx.team_id = t.id
              ) THEN 1 ELSE 0 END AS frozen
       FROM teams t ${where}
       ORDER BY t.name LIMIT ? OFFSET ?`,
    )
      .bind(...binds, pageSize, offset)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM teams t ${where}`)
      .bind(...binds)
      .first<{ count: number }>(),
  ]);
  const ids = teams.results.map((team) => team.id);
  const members =
    ids.length === 0
      ? []
      : (
          await c.env.DB.prepare(
            `SELECT tm.team_id, u.id, u.student_no, u.display_name, u.class_name
             FROM team_members tm JOIN users u ON u.id = tm.user_id
             WHERE tm.team_id IN (SELECT value FROM json_each(?))
             ORDER BY u.student_no`,
          )
            .bind(JSON.stringify(ids))
            .all<Record<string, unknown>>()
        ).results;
  return c.json({
    items: teams.results.map((team) => ({
      ...team,
      members: members.filter((member) => member.team_id === team.id),
    })),
    total: count?.count ?? 0,
    page,
    pageSize,
  });
});

teacherTeamRoutes.get('/template.csv', (c) => {
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', 'attachment; filename="teams-template.csv"');
  return c.body(
    '\uFEFF团队名称,成员1学号,成员2学号,成员3学号\n先锋队,20260001,20260002,20260003\n',
  );
});

teacherTeamRoutes.post('/import/validate', async (c) => {
  const { rows, errors } = validateRows(await readImportJson(c));
  const context = errors.length === 0 ? await validateTeamBusinessRules(c.env, rows) : null;
  const allErrors = [...errors, ...(context?.errors ?? [])];
  const issued = await issueImportToken(c.env, 'teams', rows);
  return c.json({
    token: issued.token,
    totalRows: rows.length,
    creates: rows.filter((row) => !context?.teams.has(row.name)).length,
    updates: rows.filter((row) => context?.teams.has(row.name)).length,
    rows,
    errors: allErrors,
    expiresAt: new Date(issued.expiresAt).toISOString(),
  });
});

teacherTeamRoutes.post('/import/commit', async (c) => {
  const body = importCommitSchema.safeParse(await readImportJson(c));
  if (!body.success) throw new AppError(422, 'VALIDATION_ERROR', '导入确认数据无效');
  const { rows, errors } = validateRows({ rows: body.data.rows });
  const context = await validateTeamBusinessRules(c.env, rows);
  const allErrors = [...errors, ...context.errors];
  if (allErrors.length > 0) {
    throw new AppError(
      422,
      'IMPORT_VALIDATION_FAILED',
      '导入数据校验失败',
      allErrors.map((error) => ({
        path: `第${error.row}行.${error.field}`,
        message: error.message,
      })),
    );
  }
  const checksum = await verifyImportToken(c.env, 'teams', rows, body.data.token);
  const now = Date.now();
  const teamRecords = rows.map((row) => {
    const current = context.teams.get(row.name);
    return { id: current?.id ?? uuid(), code: current?.code ?? teamCode(), name: row.name };
  });
  const memberRecords = rows.flatMap((row) => {
    const team = teamRecords.find((candidate) => candidate.name === row.name)!;
    return row.memberStudentNumbers.map((studentNumber) => ({
      teamId: team.id,
      userId: context.members.get(studentNumber)!.user_id,
    }));
  });
  const targetIds = teamRecords.map((team) => team.id);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO teams (id, code, name, created_at, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.code'),
              json_extract(value, '$.name'), ?, ?
       FROM json_each(?) WHERE true
       ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at`,
    ).bind(now, now, JSON.stringify(teamRecords)),
    c.env.DB.prepare(
      `DELETE FROM team_members WHERE team_id IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(targetIds)),
    c.env.DB.prepare(
      `INSERT INTO team_members (team_id, user_id, joined_at)
       SELECT json_extract(value, '$.teamId'), json_extract(value, '$.userId'), ?
       FROM json_each(?)`,
    ).bind(now, JSON.stringify(memberRecords)),
    c.env.DB.prepare(
      `INSERT INTO import_jobs (
         id, type, checksum, row_count, inserted_count, updated_count, created_by, committed_at
       ) VALUES (?, 'teams', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      uuid(),
      checksum,
      rows.length,
      rows.length - context.teams.size,
      context.teams.size,
      c.get('user').id,
      now,
    ),
  ]);
  return c.json({
    ok: true,
    inserted: rows.length - context.teams.size,
    updated: context.teams.size,
    message: '团队导入成功',
  });
});

teacherTeamRoutes.delete('/:id/members/:userId', async (c) => {
  const teamId = c.req.param('id');
  await assertTeamMutable(c.env, teamId);
  const result = await c.env.DB.prepare(
    'DELETE FROM team_members WHERE team_id = ? AND user_id = ?',
  )
    .bind(teamId, c.req.param('userId'))
    .run();
  if (!result.meta.changes) throw new AppError(404, 'TEAM_MEMBER_NOT_FOUND', '团队成员不存在');
  return c.json({ ok: true, message: '成员已移除' });
});

teacherTeamRoutes.delete('/:id/members', async (c) => {
  const teamId = c.req.param('id');
  await assertTeamMutable(c.env, teamId);
  await c.env.DB.prepare('DELETE FROM team_members WHERE team_id = ?').bind(teamId).run();
  return c.json({ ok: true, message: '团队成员已清空' });
});

export const studentTeamRoutes = new Hono<AppHonoEnv>();

studentTeamRoutes.get('/me/team', async (c) => {
  const userId = c.get('user').id;
  const team = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.code,
            CASE WHEN EXISTS (
              SELECT 1 FROM team_members tx JOIN active_participations ap ON ap.user_id = tx.user_id
              WHERE tx.team_id = t.id
            ) THEN 1 ELSE 0 END AS frozen
     FROM team_members tm JOIN teams t ON t.id = tm.team_id
     WHERE tm.user_id = ?`,
  )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!team) return c.json({ team: null });
  const members = await c.env.DB.prepare(
    `SELECT u.id, u.student_no, u.display_name, u.class_name
     FROM team_members tm JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ? ORDER BY u.student_no`,
  )
    .bind(team.id)
    .all();
  return c.json({ team: { ...team, members: members.results } });
});

studentTeamRoutes.delete('/me/team', async (c) => {
  const membership = await c.env.DB.prepare('SELECT team_id FROM team_members WHERE user_id = ?')
    .bind(c.get('user').id)
    .first<{ team_id: string }>();
  if (!membership) throw new AppError(404, 'TEAM_NOT_FOUND', '你尚未加入团队');
  await assertTeamMutable(c.env, membership.team_id);
  await c.env.DB.prepare('DELETE FROM team_members WHERE user_id = ?').bind(c.get('user').id).run();
  return c.json({ ok: true, message: '已退出团队' });
});

studentTeamRoutes.get('/teams/search', async (c) => {
  const query = c.req.query('query')?.trim() ?? '';
  if (query.length < 1 || query.length > 80)
    throw new AppError(422, 'VALIDATION_ERROR', '请输入团队名称或代码');
  const search = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
  const teams = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.code, COUNT(tm.user_id) AS member_count
     FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
     WHERE (t.name LIKE ? ESCAPE '\\' OR t.code LIKE ? ESCAPE '\\')
     GROUP BY t.id HAVING member_count < 3
     ORDER BY t.name LIMIT 20`,
  )
    .bind(search, search)
    .all();
  return c.json({ items: teams.results });
});

studentTeamRoutes.post('/teams/:id/join', async (c) => {
  const userId = c.get('user').id;
  const teamId = c.req.param('id');
  await assertTeamMutable(c.env, teamId);
  const active = await c.env.DB.prepare(
    'SELECT 1 FROM active_participations WHERE user_id = ? LIMIT 1',
  )
    .bind(userId)
    .first();
  if (active) throw new AppError(409, 'ACTIVE_ROOM', '你正在候场或比赛，不能加入团队');
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO team_members (team_id, user_id, joined_at)
       SELECT id, ?, ? FROM teams
       WHERE id = ? AND (SELECT COUNT(*) FROM team_members WHERE team_id = ?) < 3`,
    )
      .bind(userId, Date.now(), teamId, teamId)
      .run();
    if (!result.meta.changes) throw new AppError(409, 'TEAM_FULL', '团队不存在或已经满员');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(409, 'TEAM_CONFLICT', '你已经加入其他团队或该团队已满');
  }
  return c.json({ ok: true, message: '已加入团队' });
});
