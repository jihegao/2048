import { AppError } from './errors';

export function secret(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(503, 'SERVER_NOT_CONFIGURED', '服务器尚未完成安全配置');
  }
  return value;
}

export function passwordIterations(env: Env): number {
  const parsed = Number(env.PBKDF2_ITERATIONS);
  if (!Number.isInteger(parsed) || parsed < 100_000) {
    throw new AppError(503, 'SERVER_NOT_CONFIGURED', '密码安全参数配置无效');
  }
  return parsed;
}
