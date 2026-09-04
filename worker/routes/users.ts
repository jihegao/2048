import { Hono, type Context } from 'hono';
import type { GradeLevel } from '../../shared/types';
import type { AppHonoEnv } from '../app-types';
import { hashPassword, randomToken } from '../lib/crypto';
import { uuid } from '../lib/db';
import { passwordIterations, secret } from '../lib/env';
import { AppError, zodIssues } from '../lib/errors';
import { issueImportToken, mapInBatches, verifyImportToken } from '../lib/imports';
import { readImportJson } from '../lib/request';
import {
  importCommitSchema,
  importValidateSchema,
  paginationSchema,
  passwordResetManySchema,
  studentImportRowSchema,
} from '../schemas';

interface StudentImportRow {
  studentNumber: string;
  name: string;
  className: string;
  gradeLevel: GradeLevel;
}

interface ExistingPassword {
  student_no: string;
  id: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  grade_level: GradeLevel | null;
}

function validateRows(input: unknown): {
  rows: StudentImportRow[];
  errors: Array<{ row: number; field: string; message: string }>;
} {
  const body = importValidateSchema.safeParse(input);
  if (!body.success) throw new AppError(422, 'VALIDATION_ERROR', '导入数据格式无效');
  if (body.data.rows.length === 0) throw new AppError(422, 'EMPTY_IMPORT', '导入文件没有数据');
  if (body.data.rows.length > 2000) {
    throw new AppError(422, 'IMPORT_TOO_LARGE', '学生导入单次最多2000行');
  }

  const rows: StudentImportRow[] = [];
  const errors: Array<{ row: number; field: string; message: string }> = [];
  const seen = new Set<string>();
  body.data.rows.forEach((raw, index) => {
    const parsed = studentImportRowSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of zodIssues(parsed.error.issues)) {
        errors.push({ row: index + 2, field: issue.path, message: issue.message });
      }
      return;
    }
    if (seen.has(parsed.data.studentNumber)) {
      errors.push({ row: index + 2, field: 'studentNumber', message: '学号在导入文件中重复' });
      return;
    }
    seen.add(parsed.data.studentNumber);
    rows.push(parsed.data);
  });
  return { rows, errors };
}

async function existingStudents(
  env: Env,
  rows: StudentImportRow[],
): Promise<Map<string, ExistingPassword>> {
  const studentNumbers = rows.map((row) => row.studentNumber);
  const result = await env.DB.prepare(
    `SELECT student_no, id, password_hash, password_salt, password_iterations, grade_level
     FROM users
     WHERE student_no IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(studentNumbers))
    .all<ExistingPassword>();
  return new Map(result.results.map((row) => [row.student_no, row]));
}

async function teacherLoginConflicts(env: Env, rows: StudentImportRow[]): Promise<Set<string>> {
  const result = await env.DB.prepare(
    `SELECT login_id FROM users
     WHERE role = 'teacher' AND login_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(rows.map((row) => row.studentNumber)))
    .all<{ login_id: string }>();
  return new Set(result.results.map((row) => row.login_id));
}

export const userRoutes = new Hono<AppHonoEnv>();

userRoutes.get('/', async (c) => {
  const parsed = paginationSchema.safeParse(c.req.query());
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '查询参数无效');
  const { page, pageSize, query } = parsed.data;
  const offset = (page - 1) * pageSize;
  const search = query ? `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%` : null;
  const where = search
    ? "WHERE u.role = 'student' AND (u.student_no LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR u.class_name LIKE ? ESCAPE '\\')"
    : "WHERE u.role = 'student'";
  const binds = search ? [search, search, search] : [];
  const [itemsResult, totalRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT u.id, u.student_no, u.display_name, u.class_name, u.grade_level, u.locale,
              t.id AS team_id, t.name AS team_name
       FROM users u
       LEFT JOIN team_members tm ON tm.user_id = u.id
       LEFT JOIN teams t ON t.id = tm.team_id
       ${where}
       ORDER BY u.class_name, u.student_no
       LIMIT ? OFFSET ?`,
    )
      .bind(...binds, pageSize, offset)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM users u ${where}`)
      .bind(...binds)
      .first<{ count: number }>(),
  ]);
  return c.json({ items: itemsResult.results, total: totalRow?.count ?? 0, page, pageSize });
});

userRoutes.get('/template.csv', (c) => {
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', 'attachment; filename="students-template.csv"');
  return c.body('\uFEFF学号,姓名,班级,年级\n20260001,张三,六年级1班,6\n');
});

userRoutes.post('/import/validate', async (c) => {
  const { rows, errors } = validateRows(await readImportJson(c));
  const conflicts =
    errors.length === 0 ? await teacherLoginConflicts(c.env, rows) : new Set<string>();
  rows.forEach((row, index) => {
    if (conflicts.has(row.studentNumber)) {
      errors.push({ row: index + 2, field: 'studentNumber', message: '学号与教师账号冲突' });
    }
  });
  const existing = errors.length === 0 ? await existingStudents(c.env, rows) : new Map();
  const issued = await issueImportToken(c.env, 'users', rows);
  return c.json({
    token: issued.token,
    totalRows: rows.length,
    creates: rows.filter((row) => !existing.has(row.studentNumber)).length,
    updates: rows.filter((row) => existing.has(row.studentNumber)).length,
    rows,
    errors,
    expiresAt: new Date(issued.expiresAt).toISOString(),
  });
});

userRoutes.post('/import/commit', async (c) => {
  const body = importCommitSchema.safeParse(await readImportJson(c));
  if (!body.success) throw new AppError(422, 'VALIDATION_ERROR', '导入确认数据无效');
  const { rows, errors } = validateRows({ rows: body.data.rows });
  const conflicts = await teacherLoginConflicts(c.env, rows);
  rows.forEach((row, index) => {
    if (conflicts.has(row.studentNumber)) {
      errors.push({ row: index + 2, field: 'studentNumber', message: '学号与教师账号冲突' });
    }
  });
  if (errors.length > 0)
    throw new AppError(
      422,
      'IMPORT_VALIDATION_FAILED',
      '导入数据校验失败',
      errors.map((error) => ({ path: `第${error.row}行.${error.field}`, message: error.message })),
    );
  const checksum = await verifyImportToken(c.env, 'users', rows, body.data.token);
  const existing = await existingStudents(c.env, rows);
  const initialPassword = secret(c.env, 'INITIAL_STUDENT_PASSWORD');
  const pepper = secret(c.env, 'PASSWORD_PEPPER');
  const iterations = passwordIterations(c.env);
  const now = Date.now();

  const records = await mapInBatches(rows, 20, async (row) => {
    const old = existing.get(row.studentNumber);
    if (old) {
      return {
        id: old.id,
        ...row,
        passwordHash: old.password_hash,
        passwordSalt: old.password_salt,
        passwordIterations: old.password_iterations,
        gradeLevel: row.gradeLevel,
      };
    }
    const passwordSalt = randomToken(16);
    return {
      id: uuid(),
      ...row,
      passwordHash: await hashPassword(initialPassword, passwordSalt, iterations, pepper),
      passwordSalt,
      passwordIterations: iterations,
      gradeLevel: row.gradeLevel,
    };
  });

  const upsert = c.env.DB.prepare(
    `INSERT INTO users (
       id, login_id, role, student_no, display_name, class_name, grade_level, locale,
       password_hash, password_salt, password_iterations, created_at, updated_at
     )
     SELECT
       json_extract(value, '$.id'), json_extract(value, '$.studentNumber'), 'student',
       json_extract(value, '$.studentNumber'), json_extract(value, '$.name'),
       json_extract(value, '$.className'), json_extract(value, '$.gradeLevel'), NULL,
       json_extract(value, '$.passwordHash'),
       json_extract(value, '$.passwordSalt'), json_extract(value, '$.passwordIterations'), ?, ?
     FROM json_each(?)
     WHERE true
     ON CONFLICT(login_id) DO UPDATE SET
       display_name = excluded.display_name,
       class_name = excluded.class_name,
       grade_level = excluded.grade_level,
       updated_at = excluded.updated_at`,
  ).bind(now, now, JSON.stringify(records));
  const audit = c.env.DB.prepare(
    `INSERT INTO import_jobs (
      id, type, checksum, row_count, inserted_count, updated_count, created_by, committed_at
    ) VALUES (?, 'users', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    uuid(),
    checksum,
    rows.length,
    rows.length - existing.size,
    existing.size,
    c.get('user').id,
    now,
  );
  await c.env.DB.batch([upsert, audit]);
  return c.json({
    ok: true,
    inserted: rows.length - existing.size,
    updated: existing.size,
    message: '学生导入成功',
  });
});

async function resetPasswords(c: Context<AppHonoEnv>, userIds: string[]) {
  const rows = await c.env.DB.prepare(
    `SELECT id FROM users
     WHERE role = 'student' AND id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(userIds))
    .all<{ id: string }>();
  if (rows.results.length !== userIds.length) {
    throw new AppError(404, 'USER_NOT_FOUND', '部分学生不存在');
  }
  const initialPassword = secret(c.env, 'INITIAL_STUDENT_PASSWORD');
  const pepper = secret(c.env, 'PASSWORD_PEPPER');
  const iterations = passwordIterations(c.env);
  const records = await mapInBatches(rows.results, 20, async ({ id }) => {
    const salt = randomToken(16);
    return { id, salt, hash: await hashPassword(initialPassword, salt, iterations, pepper) };
  });
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE users
       SET password_hash = (
             SELECT json_extract(value, '$.hash') FROM json_each(?)
             WHERE json_extract(value, '$.id') = users.id
           ),
           password_salt = (
             SELECT json_extract(value, '$.salt') FROM json_each(?)
             WHERE json_extract(value, '$.id') = users.id
           ),
           password_iterations = ?, updated_at = ?
       WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
    ).bind(
      JSON.stringify(records),
      JSON.stringify(records),
      iterations,
      now,
      JSON.stringify(records),
    ),
    c.env.DB.prepare(
      `DELETE FROM sessions
       WHERE user_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
    ).bind(JSON.stringify(records)),
  ]);
}

userRoutes.post('/:id/reset-password', async (c) => {
  await resetPasswords(c, [c.req.param('id')]);
  return c.json({ ok: true, message: '密码已重置，原有登录已失效' });
});

userRoutes.post('/reset-passwords', async (c) => {
  const parsed = passwordResetManySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new AppError(422, 'VALIDATION_ERROR', '重置名单无效', zodIssues(parsed.error.issues));
  await resetPasswords(c, parsed.data.userIds);
  return c.json({ ok: true, count: parsed.data.userIds.length, message: '所选学生密码已重置' });
});
