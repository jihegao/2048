import type { UserSummary } from '../../shared/types';

export type LoginCheckCode = 'cookieMissing' | 'sessionInvalid' | 'checkUnknown' | 'superseded';
export class LoginCheckError extends Error {
  constructor(public readonly code: LoginCheckCode) {
    super(code);
  }
}

// Keep these checks separate from API 401 revalidation: a failed login check
// must never expire or restore a different identity as a side effect.
async function post(path: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Check failed');
    return await response.json();
  } catch {
    throw new LoginCheckError('checkUnknown');
  } finally {
    clearTimeout(timer);
  }
}

export async function checkLoginCookie(): Promise<void> {
  const started = (await post('/api/auth/cookie-check')) as { challenge?: unknown } | null;
  if (typeof started?.challenge !== 'string') throw new LoginCheckError('checkUnknown');
  const result = (await post('/api/auth/cookie-check/confirm', started)) as {
    supported?: unknown;
  } | null;
  if (result?.supported === false) throw new LoginCheckError('cookieMissing');
  if (result?.supported !== true) throw new LoginCheckError('checkUnknown');
}

export async function confirmLoginSession(expectedId: string): Promise<UserSummary> {
  const result = (await post('/api/auth/session-confirm')) as {
    state?: unknown;
    user?: UserSummary | null;
  } | null;
  if (result?.state === 'missing') throw new LoginCheckError('cookieMissing');
  if (result?.state === 'invalid') throw new LoginCheckError('sessionInvalid');
  if (result?.state !== 'valid' || !result.user?.id) throw new LoginCheckError('checkUnknown');
  if (result.user.id !== expectedId) throw new LoginCheckError('sessionInvalid');
  return result.user;
}
