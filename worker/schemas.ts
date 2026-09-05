import { z } from 'zod';
import { directions, locales, roomModes } from '../shared/types';
import type { GradeLevel } from '../shared/types';

export const localeSchema = z.enum(locales);
export const roomModeSchema = z.enum(roomModes);
export const directionSchema = z.enum(directions);
export const gradeLevelSchema = z
  .number({ error: '年级必须为1到12之间的整数' })
  .int('年级必须为整数')
  .min(1, '年级必须在1到12之间')
  .max(12, '年级必须在1到12之间')
  .transform((value) => value as GradeLevel);

export const loginSchema = z.object({
  loginId: z.string().trim().min(1, '请输入账号').max(64, '账号过长'),
  password: z.string().min(1, '请输入密码').max(256, '密码过长'),
  locale: localeSchema.optional(),
});

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, '请输入当前密码').max(256, '当前密码过长'),
    newPassword: z.string().min(12, '新密码至少需要12个字符').max(256, '新密码不能超过256个字符'),
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: '新密码不能与当前密码相同',
    path: ['newPassword'],
  });

export const roomInputSchema = z.object({
  name: z.string().trim().min(1, '请输入房间名称').max(80, '房间名称不能超过80个字符'),
  mode: roomModeSchema,
  durationMinutes: z
    .number({ error: '时长必须为数字' })
    .int('时长必须为整数')
    .min(1, '时长不能少于1分钟')
    .max(10, '时长不能超过10分钟')
    .default(5),
});

export const roomPatchSchema = roomInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, '至少提供一个修改字段');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().trim().max(100).optional(),
});

export const passwordResetManySchema = z.object({
  userIds: z.array(z.uuid()).min(1, '请至少选择一名学生').max(200, '单次最多重置200名学生'),
});

export const studentImportRowSchema = z.object({
  studentNumber: z.string().trim().min(1, '学号不能为空').max(40, '学号过长'),
  name: z.string().trim().min(1, '姓名不能为空').max(80, '姓名过长'),
  className: z.string().trim().min(1, '班级不能为空').max(80, '班级过长'),
  gradeLevel: gradeLevelSchema,
});

const leaderboardPeriodFields = z.object({
  name: z.string().trim().min(1, '周期名称不能为空').max(80, '周期名称不能超过80个字符'),
  startAt: z
    .string()
    .trim()
    .pipe(z.iso.datetime({ offset: true })),
  endAt: z
    .string()
    .trim()
    .pipe(z.iso.datetime({ offset: true })),
});

export const leaderboardPeriodInputSchema = leaderboardPeriodFields;
export const leaderboardPeriodPatchSchema = leaderboardPeriodFields
  .partial()
  .refine((value) => Object.keys(value).length > 0, '至少提供一个修改字段');

export const studentLeaderboardQuerySchema = z.object({
  type: z.literal('practice').default('practice'),
  period: z.literal('current').default('current'),
});

export const teacherLeaderboardQuerySchema = z.object({
  periodId: z.uuid(),
  gradeLevel: z.coerce.number().pipe(gradeLevelSchema).optional(),
});

export const teamImportRowSchema = z.object({
  name: z.string().trim().min(1, '团队名称不能为空').max(80, '团队名称过长'),
  memberStudentNumbers: z
    .array(z.string().trim().min(1))
    .length(3, '团队必须包含三名成员')
    .refine((members) => new Set(members).size === 3, '团队成员学号不能重复'),
});

export const importValidateSchema = z.object({
  rows: z.array(z.unknown()),
});

export const importCommitSchema = z.object({
  rows: z.array(z.unknown()),
  token: z.string().min(20, '导入确认凭据无效'),
});

export const practiceCompleteSchema = z.object({
  challenge: z.string().min(20),
  moves: z.array(directionSchema).max(200_000, '练习步数超出限制'),
});
