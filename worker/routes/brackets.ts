import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  bracketKinds,
  bracketSize,
  emptyBracket,
  projectBracket,
  type BracketEntry,
  type BracketKind,
  type BracketState,
} from '../../shared/brackets';
import type { AppHonoEnv } from '../app-types';
import { AppError } from '../lib/errors';

export const teacherBracketRoutes = new Hono<AppHonoEnv>();
teacherBracketRoutes.use(
  '*',
  bodyLimit({
    maxSize: 32768,
    onError: () => {
      throw new AppError(413, 'BRACKET_TOO_LARGE', '对阵数据过大');
    },
  }),
);
const kindSchema = z.enum(bracketKinds);
const writeSchema = z
  .object({
    revision: z.number().int().min(0),
    state: z
      .object({
        title: z.string().max(100),
        names: z.array(z.string().max(180)).max(16),
        winners: z.array(z.array(z.string().max(100).nullable()).max(8)).max(4),
      })
      .strict(),
  })
  .strict();
function readKind(value: string): BracketKind {
  const parsed = kindSchema.safeParse(value);
  if (!parsed.success) throw new AppError(404, 'BRACKET_NOT_FOUND', '对阵页面不存在');
  return parsed.data;
}
export async function readCatalog(db: D1Database, kind: BracketKind): Promise<BracketEntry[]> {
  if (kind === 'teams8') {
    const rows = await db
      .prepare(
        `SELECT t.id, t.name, t.logo,
          (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS memberCount
         FROM teams t WHERE t.deleted_at IS NULL ORDER BY t.name, t.id LIMIT 10001`,
      )
      .all<{ id: string; name: string; logo: string | null; memberCount: number }>();
    if (rows.results.length > 10000)
      throw new AppError(422, 'CATALOG_TOO_LARGE', '团队数量过多，请联系管理员');
    return rows.results.map((row) => ({ ...row, label: row.name }));
  }
  const rows = await db
    .prepare(
      "SELECT id, display_name, class_name, student_no FROM users WHERE role = 'student' ORDER BY display_name, student_no LIMIT 10001",
    )
    .all<{ id: string; display_name: string; class_name: string; student_no: string }>();
  if (rows.results.length > 10000)
    throw new AppError(422, 'CATALOG_TOO_LARGE', '学生数量过多，请联系管理员');
  return rows.results.map((row) => ({
    id: row.id,
    name: row.display_name,
    label: `${row.display_name} · ${row.class_name} · ${row.student_no}`,
    logo: null,
  }));
}
teacherBracketRoutes.get('/:kind', async (c) => {
  const kind = readKind(c.req.param('kind'));
  const [catalog, row] = await Promise.all([
    readCatalog(c.env.DB, kind),
    c.env.DB.prepare(
      'SELECT state_json, revision, updated_at FROM tournament_brackets WHERE kind = ?',
    )
      .bind(kind)
      .first<{ state_json: string; revision: number; updated_at: number }>(),
  ]);
  const state = row ? (JSON.parse(row.state_json) as BracketState) : emptyBracket(kind);
  return c.json({
    catalog,
    state: projectBracket(kind, catalog, state).state,
    revision: row?.revision ?? 0,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
  });
});
teacherBracketRoutes.put('/:kind', async (c) => {
  const kind = readKind(c.req.param('kind'));
  const parsed = writeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '对阵数据格式无效');
  const { revision, state } = parsed.data;
  const size = bracketSize(kind);
  if (
    state.names.length !== size ||
    state.winners.length !== Math.log2(size) ||
    state.winners.some((round, r) => round.length !== size / 2 ** (r + 1))
  )
    throw new AppError(422, 'VALIDATION_ERROR', '对阵席位或轮次不正确');
  const catalog = await readCatalog(c.env.DB, kind);
  const clean = projectBracket(kind, catalog, state).state;
  if (JSON.stringify(clean.winners) !== JSON.stringify(state.winners))
    throw new AppError(
      422,
      'INVALID_BRACKET_WINNER',
      '队伍或学生资料已变化，请重新载入并确认晋级结果',
    );
  const updatedAt = Date.now();
  const json = JSON.stringify(clean);
  const updatedBy = c.get('user').id;
  // A conditional write prevents another administrator's newer results being overwritten.
  let saved: { revision: number } | null;
  try {
    saved =
      revision === 0
        ? await c.env.DB.prepare(
            'INSERT INTO tournament_brackets (kind, state_json, revision, updated_by, updated_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(kind) DO NOTHING RETURNING revision',
          )
            .bind(kind, json, updatedBy, updatedAt)
            .first<{ revision: number }>()
        : await c.env.DB.prepare(
            'UPDATE tournament_brackets SET state_json = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE kind = ? AND revision = ? RETURNING revision',
          )
            .bind(json, updatedBy, updatedAt, kind, revision)
            .first<{ revision: number }>();
  } catch (error) {
    if (String(error).includes('TOURNAMENT_SELECTION_REQUIRED'))
      throw new AppError(
        409,
        'TOURNAMENT_SELECTION_REQUIRED',
        '已切换到多赛事管理，请刷新页面并选择对应赛事',
      );
    throw error;
  }
  if (!saved)
    throw new AppError(409, 'BRACKET_CONFLICT', '其他管理员已更新此对阵，请重新载入后再编辑');
  return c.json({
    state: clean,
    revision: saved.revision,
    updatedAt: new Date(updatedAt).toISOString(),
  });
});
