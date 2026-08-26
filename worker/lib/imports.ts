import { sha256, signJson, verifySignedJson } from './crypto';
import { secret } from './env';
import { AppError } from './errors';

interface ImportTokenPayload {
  type: 'users' | 'teams';
  checksum: string;
  expiresAt: number;
}

export async function importChecksum(rows: unknown[]): Promise<string> {
  return sha256(JSON.stringify(rows));
}

export async function issueImportToken(
  env: Env,
  type: ImportTokenPayload['type'],
  rows: unknown[],
): Promise<{ token: string; expiresAt: number; checksum: string }> {
  const checksum = await importChecksum(rows);
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const token = await signJson(
    { type, checksum, expiresAt } satisfies ImportTokenPayload,
    secret(env, 'IMPORT_SIGNING_KEY'),
  );
  return { token, expiresAt, checksum };
}

export async function verifyImportToken(
  env: Env,
  expectedType: ImportTokenPayload['type'],
  rows: unknown[],
  token: string,
): Promise<string> {
  const payload = await verifySignedJson<ImportTokenPayload>(
    token,
    secret(env, 'IMPORT_SIGNING_KEY'),
  );
  const checksum = await importChecksum(rows);
  if (
    !payload ||
    payload.type !== expectedType ||
    payload.checksum !== checksum ||
    payload.expiresAt < Date.now()
  ) {
    throw new AppError(409, 'IMPORT_PREVIEW_EXPIRED', '导入预览已过期或内容发生变化，请重新校验');
  }
  return checksum;
}

export async function mapInBatches<T, R>(
  values: T[],
  batchSize: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    results.push(...(await Promise.all(values.slice(index, index + batchSize).map(mapper))));
  }
  return results;
}
