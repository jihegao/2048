import type { Context } from 'hono';
import type { AppHonoEnv } from '../app-types';
import { AppError } from './errors';

const MAX_IMPORT_REQUEST_BYTES = 8 * 1024 * 1024;

export async function readImportJson(c: Context<AppHonoEnv>): Promise<unknown> {
  const declaredLength = Number(c.req.header('Content-Length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_REQUEST_BYTES) {
    throw new AppError(413, 'IMPORT_PAYLOAD_TOO_LARGE', '导入请求体积过大');
  }

  const body = c.req.raw.body;
  if (!body) return null;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let json = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_IMPORT_REQUEST_BYTES) {
      await reader.cancel();
      throw new AppError(413, 'IMPORT_PAYLOAD_TOO_LARGE', '导入请求体积过大');
    }
    json += decoder.decode(value, { stream: true });
  }
  json += decoder.decode();

  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
