import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorPayload } from '../../shared/types';

export class AppError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
    public readonly issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof AppError) {
    const payload: ApiErrorPayload = {
      error: { code: error.code, message: error.message, issues: error.issues },
    };
    return c.json(payload, error.status);
  }

  const requestId = c.get('requestId') as string | undefined;
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'unhandled_error',
      requestId,
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  return c.json<ApiErrorPayload>(
    { error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求' } },
    500,
  );
}

export function zodIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>,
): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
