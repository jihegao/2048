// worker/migration-source-verification.mjs
import original from './__2048_original_module__.js';

// worker/lib/crypto.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function base64UrlEncode(bytes) {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
function base64UrlDecode(value) {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return base64ToBytes(padded);
}
async function hashPassword(password, salt, iterations, pepper) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`${password}\0${pepper}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64UrlDecode(salt),
      iterations,
    },
    key,
    256,
  );
  return base64UrlEncode(new Uint8Array(bits));
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
async function verifySignedJson(token, secret) {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) return null;
  const expected = await hmac(secret, body);
  const actual = base64UrlDecode(signature);
  if (
    expected.byteLength !== actual.byteLength ||
    !crypto.subtle.timingSafeEqual(expected, actual)
  ) {
    return null;
  }
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(body)));
  } catch {
    return null;
  }
}

// worker/lib/migration.ts
function migrationBinding(env, name) {
  return env[name];
}

// worker/lib/migration-key-proof.ts
var RUNTIME_SECRET_NAMES = [
  'PASSWORD_PEPPER',
  'PRACTICE_SIGNING_KEY',
  'IMPORT_SIGNING_KEY',
  'INITIAL_STUDENT_PASSWORD',
  'BOOTSTRAP_TEACHER_USERNAME',
  'BOOTSTRAP_TEACHER_PASSWORD',
  'BOOTSTRAP_TEACHER_NAME',
];
var encoder2 = new TextEncoder();
var authenticationDomain = '2048-migration-key-proof-auth-v1\0';
async function runtimeKeyDigest(value, audience, nonce, name) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder2.encode(value),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = JSON.stringify({ purpose: '2048-runtime-key-digest-v1', audience, nonce, name });
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder2.encode(message))),
  );
}
function equalDigest(actual, expected) {
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
async function migrationKeyProof(request, env) {
  if (new URL(request.url).pathname !== '/api/_migration/key-proof') return null;
  const response = (payload, status) =>
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
  if (!authorization.startsWith('Migration ') || authorization.length > 12e3) {
    return response({ error: { code: 'UNAUTHORIZED' } }, 401);
  }
  let proof;
  try {
    proof = await verifySignedJson(authorization.slice(10), authenticationDomain + key);
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
    proof.issuedAt > now + 5e3 ||
    proof.expiresAt < now ||
    proof.expiresAt <= proof.issuedAt ||
    proof.expiresAt - proof.issuedAt > 6e4 ||
    proof.issuedAt < now - 6e4 ||
    !proof.proofs ||
    typeof proof.proofs !== 'object'
  ) {
    return response({ error: { code: 'UNAUTHORIZED' } }, 401);
  }
  const matches = {};
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
    fixture.iterations === 1e5 &&
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
        Number(migrationBinding(env, 'PBKDF2_ITERATIONS')) === 1e5,
    },
    200,
  );
}

// worker/migration-source-verification.mjs
import { RoomSession, LoginGuard } from './__2048_original_module__.js';
var migration_source_verification_default = {
  ...original,
  async fetch(request, env, context) {
    return (await migrationKeyProof(request, env)) ?? original.fetch(request, env, context);
  },
};
export { LoginGuard, RoomSession, migration_source_verification_default as default };
