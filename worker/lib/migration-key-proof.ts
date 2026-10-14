import {
  base64UrlDecode,
  base64UrlEncode,
  hashPassword,
  signJson,
  verifySignedJson,
} from './crypto';
import { migrationBinding } from './migration';

export const RUNTIME_SECRET_NAMES = [
  'PASSWORD_PEPPER',
  'PRACTICE_SIGNING_KEY',
  'IMPORT_SIGNING_KEY',
  'INITIAL_STUDENT_PASSWORD',
  'BOOTSTRAP_TEACHER_USERNAME',
  'BOOTSTRAP_TEACHER_PASSWORD',
  'BOOTSTRAP_TEACHER_NAME',
] as const;

export interface RuntimeKeyProof {
  purpose: '2048-runtime-key-proof-v1';
  audience: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  proofs: Record<string, string>;
  passwordFixture: { password: string; salt: string; iterations: number; expectedHash: string };
}

const encoder = new TextEncoder();
const authenticationDomain = '2048-migration-key-proof-auth-v1\u0000';

export async function runtimeKeyDigest(
  value: string,
  audience: string,
  nonce: string,
  name: string,
) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(value),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = JSON.stringify({ purpose: '2048-runtime-key-digest-v1', audience, nonce, name });
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))),
  );
}

export function signRuntimeKeyProof(proof: RuntimeKeyProof, importKey: string) {
  return signJson(proof, authenticationDomain + importKey);
}

function equalDigest(actual: string, expected: string): boolean {
  try {
    const left = base64UrlDecode(actual);
    const right = base64UrlDecode(expected);
    return (
      left.byteLength === 32 &&
      right.byteLength === 32 &&
      crypto.subtle.timingSafeEqual(left, right)
    );
  } catch {
    return false;
  }
}

export async function migrationKeyProof(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/_migration/key-proof') return null;
  const response = (payload: unknown, status: number) =>
    Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
  if (migrationBinding(env, 'MIGRATION_VERIFICATION_ENABLED') !== 'true') {
    return response({ error: { code: 'NOT_FOUND' } }, 404);
  }
  if (request.method !== 'POST') return response({ error: { code: 'METHOD_NOT_ALLOWED' } }, 405);
  const key = migrationBinding(env, 'IMPORT_SIGNING_KEY');
  const audience = migrationBinding(env, 'MIGRATION_AUDIENCE');
  if (typeof key !== 'string' || !key || typeof audience !== 'string' || !audience) {
    return response({ error: { code: 'SERVER_NOT_CONFIGURED' } }, 503);
  }
  const authorization = request.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Migration ') || authorization.length > 12_000) {
    return response({ error: { code: 'UNAUTHORIZED' } }, 401);
  }
  let proof: RuntimeKeyProof | null;
  try {
    proof = await verifySignedJson<RuntimeKeyProof>(
      authorization.slice(10),
      authenticationDomain + key,
    );
  } catch {
    proof = null;
  }
  const now = Date.now();
  if (
    !proof ||
    proof.purpose !== '2048-runtime-key-proof-v1' ||
    proof.audience !== audience ||
    !/^[A-Za-z0-9_-]{22,64}$/u.test(proof.nonce) ||
    !Number.isFinite(proof.issuedAt) ||
    !Number.isFinite(proof.expiresAt) ||
    proof.issuedAt > now + 5_000 ||
    proof.expiresAt < now ||
    proof.expiresAt <= proof.issuedAt ||
    proof.expiresAt - proof.issuedAt > 60_000 ||
    proof.issuedAt < now - 60_000 ||
    !proof.proofs ||
    typeof proof.proofs !== 'object'
  ) {
    return response({ error: { code: 'UNAUTHORIZED' } }, 401);
  }
  const matches: Record<string, boolean> = {};
  for (const name of RUNTIME_SECRET_NAMES) {
    const value = migrationBinding(env, name);
    matches[name] =
      typeof value === 'string' &&
      !!value &&
      typeof proof.proofs[name] === 'string' &&
      equalDigest(await runtimeKeyDigest(value, audience, proof.nonce, name), proof.proofs[name]);
  }
  const fixture = proof.passwordFixture;
  let passwordAlgorithmMatches = false;
  const pepper = migrationBinding(env, 'PASSWORD_PEPPER');
  if (
    fixture &&
    typeof fixture.password === 'string' &&
    fixture.password.startsWith('synthetic-') &&
    fixture.password.length <= 256 &&
    typeof fixture.salt === 'string' &&
    fixture.salt.length <= 64 &&
    fixture.iterations === 100_000 &&
    typeof fixture.expectedHash === 'string' &&
    typeof pepper === 'string'
  ) {
    try {
      passwordAlgorithmMatches = equalDigest(
        await hashPassword(fixture.password, fixture.salt, fixture.iterations, pepper),
        fixture.expectedHash,
      );
    } catch {
      passwordAlgorithmMatches = false;
    }
  }
  return response(
    {
      audience,
      nonce: proof.nonce,
      matches,
      passwordAlgorithmMatches,
      pbkdf2Iterations: Number(migrationBinding(env, 'PBKDF2_ITERATIONS')),
      ok:
        Object.values(matches).every(Boolean) &&
        passwordAlgorithmMatches &&
        Number(migrationBinding(env, 'PBKDF2_ITERATIONS')) === 100_000,
    },
    200,
  );
}
