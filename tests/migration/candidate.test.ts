import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import candidate from '../../worker/migration-candidate';
import { authorizedCandidateRequest } from '../../worker/lib/migration-candidate-gate';
import { hashPassword, sha256, signJson } from '../../worker/lib/crypto';
import { CandidateClient, candidateHeaders } from '../../scripts/migration-candidate-client.mjs';

const origin = 'https://mingcheng1024.cn';
const versionId = '11111111-1111-4111-8111-111111111111';
const candidateEnv = {
  ...env,
  MIGRATION_AUDIENCE: '2048-new-production',
  MIGRATION_CANDIDATE_ENABLED: 'true',
  CF_VERSION_METADATA: { id: versionId },
} as unknown as Env;

async function signedRequest(
  path: string,
  init: RequestInit = {},
  overrides: Record<string, unknown> = {},
) {
  const request = new Request(origin + path, init);
  const issuedAt = Date.now();
  const proof = {
    purpose: '2048-closed-candidate-v1',
    audience: '2048-new-production',
    versionId,
    nonce: 'A'.repeat(32),
    issuedAt,
    expiresAt: issuedAt + 60000,
    method: request.method,
    url: request.url,
    bodyDigest: await sha256(new Uint8Array(await request.clone().arrayBuffer())),
    ...overrides,
  };
  request.headers.set(
    'X-2048-Migration-Authorization',
    await signJson(proof, '2048-closed-candidate-auth-v1\u0000synthetic-import-key'),
  );
  return request;
}

async function phase(value: 'normal' | 'frozen') {
  await env.DB.prepare('UPDATE __2048_write_fence SET phase=? WHERE id=1').bind(value).run();
}

describe.sequential('closed NEW candidate using synthetic data only', () => {
  beforeEach(async () => {
    await phase('normal');
  });

  it('blocks public API, assets and WebSocket before invoking application bindings', async () => {
    const unreachable = {
      MIGRATION_AUDIENCE: '2048-new-production',
      MIGRATION_CANDIDATE_ENABLED: 'true',
      MIGRATION_VERIFICATION_ENABLED: 'false',
      get DB() {
        throw new Error('Public traffic reached D1');
      },
      get ASSETS() {
        throw new Error('Public traffic reached assets');
      },
      get ROOMS() {
        throw new Error('Public traffic reached DO');
      },
    } as unknown as Env;
    for (const path of [
      '/',
      '/api/me',
      '/api/practice/timed/current',
      '/api/rooms/synthetic/ws',
      '/api/auth/login',
    ]) {
      const response = await candidate.fetch(
        new Request(origin + path),
        unreachable,
        createExecutionContext(),
      );
      expect(response.status).toBe(503);
      expect(response.headers.has('Set-Cookie')).toBe(false);
    }
    const post = await candidate.fetch(
      new Request(origin + '/api/auth/login', { method: 'POST', body: '{}' }),
      unreachable,
      createExecutionContext(),
    );
    expect(post.status).toBe(503);
    await candidate.scheduled();
  });

  it('keeps the application frozen even for a correctly signed operator', async () => {
    await phase('frozen');
    const before = (await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results;
    const response = await candidate.fetch(
      await signedRequest('/api/health'),
      candidateEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect((await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(before);
  });

  it('accepts only the exact signed request and removes the operator header', async () => {
    const request = new Request(origin + '/api/health', {
      headers: candidateHeaders('synthetic-import-key', versionId, '/api/health'),
    });
    const accepted = await authorizedCandidateRequest(request, candidateEnv);
    expect(accepted?.headers.has('X-2048-Migration-Authorization')).toBe(false);
    const response = await candidate.fetch(
      await signedRequest('/api/health'),
      candidateEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('rejects changed identities, methods, bodies, URLs and validity intervals', async () => {
    const now = Date.now();
    for (const mismatch of [
      { purpose: 'another-purpose' },
      { audience: '2048-old-production' },
      { versionId: '22222222-2222-4222-8222-222222222222' },
      { method: 'DELETE' },
      { url: origin + '/api/teacher/users' },
      { bodyDigest: 'changed' },
      { issuedAt: now - 1000, expiresAt: now - 1 },
      { issuedAt: now, expiresAt: now + 60001 },
      { issuedAt: now + 10000, expiresAt: now + 20000 },
      { nonce: 'short' },
    ]) {
      expect(
        await authorizedCandidateRequest(
          await signedRequest('/api/health', {}, mismatch),
          candidateEnv,
        ),
      ).toBeNull();
    }
    const tampered = await signedRequest('/api/health');
    const token = tampered.headers.get('X-2048-Migration-Authorization')!;
    tampered.headers.set('X-2048-Migration-Authorization', token.slice(0, -2) + 'xx');
    expect(await authorizedCandidateRequest(tampered, candidateEnv)).toBeNull();
    expect(
      await authorizedCandidateRequest(await signedRequest('/api/health'), {
        ...candidateEnv,
        MIGRATION_CANDIDATE_ENABLED: 'false',
      } as unknown as Env),
    ).toBeNull();
  });

  it('preserves normal authentication and Origin checks during controlled acceptance', async () => {
    const salt = 'AAECAwQFBgcICQoLDA0ODw';
    await env.DB.prepare(
      'UPDATE users SET password_hash=?,password_salt=?,password_iterations=100000 WHERE id=?',
    )
      .bind(
        await hashPassword('synthetic-password', salt, 100000, 'synthetic-pepper'),
        salt,
        'teacher',
      )
      .run();
    const login = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ loginId: 'synthetic-teacher', password: 'synthetic-password' }),
    };
    const crossOrigin = await candidate.fetch(
      await signedRequest('/api/auth/login', {
        ...login,
        headers: { ...login.headers, Origin: 'https://untrusted.example' },
      }),
      candidateEnv,
      createExecutionContext(),
    );
    expect(crossOrigin.status).toBe(403);
    const unauthenticated = await candidate.fetch(
      await signedRequest('/api/teacher/users'),
      candidateEnv,
      createExecutionContext(),
    );
    expect(unauthenticated.status).toBe(401);
    const client = new CandidateClient('synthetic-import-key', versionId, async (input, init) => {
      expect(init?.redirect).toBe('error');
      // Node forbids redirects; workerd Request accepts only follow/manual.
      // This adapter makes no network request and invokes the local app directly.
      return candidate.fetch(
        new Request(input instanceof Request ? input : String(input), {
          ...init,
          redirect: 'manual',
        }),
        candidateEnv,
        createExecutionContext(),
      );
    });
    const response = await client.request('/api/auth/login', 'POST', {
      loginId: 'synthetic-teacher',
      password: 'synthetic-password',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('__Host-session');
    expect((await client.request('/api/teacher/users')).status).toBe(200);
    client.clearCookies();
    expect((await client.request('/api/teacher/users')).status).toBe(401);
    const publicResponse = await candidate.fetch(
      new Request(origin + '/api/health'),
      candidateEnv,
      createExecutionContext(),
    );
    expect(publicResponse.status).toBe(503);
  });

  it('rejects a signed oversized body without waiting for an unused stream branch', async () => {
    const request = await signedRequest('/api/auth/login', {
      method: 'POST',
      body: 'x'.repeat(65537),
    });
    expect(await authorizedCandidateRequest(request, candidateEnv)).toBeNull();
  });

  it('rearms retained waiting rooms only for an authenticated signed teacher, preserving deadlines', async () => {
    const route = '/api/teacher/_migration/rearm-waiting';
    const deadline = Date.now() + 3600000;
    await env.DB.prepare('UPDATE rooms SET self_room_expires_at=? WHERE id=?')
      .bind(deadline, 'waiting-room')
      .run();
    const request = async (userId?: string, originHeader = origin) => {
      const headers = new Headers({ Origin: originHeader });
      if (userId) {
        const token = `synthetic-rearm-${userId}`;
        await env.DB.prepare(
          `INSERT INTO sessions(token_hash,user_id,credential_version,created_at,expires_at,last_seen_at)
           SELECT ?,id,credential_version,?,?,? FROM users WHERE id=?
           ON CONFLICT(token_hash) DO NOTHING`,
        )
          .bind(await sha256(token), Date.now(), Date.now() + 3600000, Date.now(), userId)
          .run();
        headers.set('Cookie', `__Host-session=${token}`);
      }
      return candidate.fetch(
        await signedRequest(route, { method: 'POST', headers }),
        candidateEnv,
        createExecutionContext(),
      );
    };
    expect((await request()).status).toBe(401);
    expect((await request('student-1')).status).toBe(403);
    expect((await request('teacher', 'https://untrusted.example')).status).toBe(403);
    const response = await request('teacher');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, rearmed: 1, expired: 0 });
    expect(
      await env.DB.prepare('SELECT self_room_expires_at FROM rooms WHERE id=?')
        .bind('waiting-room')
        .first('self_room_expires_at'),
    ).toBe(deadline);
    const stub = env.ROOMS.get(env.ROOMS.idFromName('waiting-room'));
    expect(
      await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm()),
    ).toBe(deadline);
    await phase('frozen');
    const frozen = await candidate.fetch(
      await signedRequest(route, { method: 'POST', headers: { Origin: origin } }),
      candidateEnv,
      createExecutionContext(),
    );
    expect(frozen.status).toBe(503);
  });
});
