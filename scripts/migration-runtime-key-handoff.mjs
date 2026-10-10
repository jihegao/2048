import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTarget } from './migration-deployment-targets.mjs';

export const secretNames = [
  'PASSWORD_PEPPER',
  'PRACTICE_SIGNING_KEY',
  'IMPORT_SIGNING_KEY',
  'INITIAL_STUDENT_PASSWORD',
  'BOOTSTRAP_TEACHER_USERNAME',
  'BOOTSTRAP_TEACHER_PASSWORD',
  'BOOTSTRAP_TEACHER_NAME',
];
const oldOrigin = 'https://2048.gaojihe.cn';
const newOrigin = 'https://2048-challenge-platform.jihe-gao-323.workers.dev';
const newAccount = '3232ebc7e9bb0199b92e3d70b07825af';
const workerName = '2048-challenge-platform';
const apiBase = `https://api.cloudflare.com/client/v4/accounts/${newAccount}`;
const workerPath = `/workers/scripts/${workerName}`;

export function buildProof(secrets, audience) {
  const nonce = randomBytes(24).toString('base64url');
  const now = Date.now();
  const salt = randomBytes(16).toString('base64url');
  const password = 'synthetic-migration-password-fixture';
  const payload = {
    purpose: '2048-runtime-key-proof-v1',
    audience,
    nonce,
    issuedAt: now,
    expiresAt: now + 60_000,
    proofs: Object.fromEntries(
      secretNames.map((name) => [
        name,
        createHmac('sha256', secrets[name])
          .update(JSON.stringify({ purpose: '2048-runtime-key-digest-v1', audience, nonce, name }))
          .digest('base64url'),
      ]),
    ),
    passwordFixture: {
      password,
      salt,
      iterations: 100_000,
      expectedHash: pbkdf2Sync(
        `${password}\u0000${secrets.PASSWORD_PEPPER}`,
        Buffer.from(salt, 'base64url'),
        100_000,
        32,
        'sha256',
      ).toString('base64url'),
    },
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac(
    'sha256',
    `2048-migration-key-proof-auth-v1\u0000${secrets.IMPORT_SIGNING_KEY}`,
  )
    .update(body)
    .digest('base64url');
  return { payload, authorization: `Migration ${body}.${signature}` };
}

function safeAssert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyRuntime(secrets, origin, audience) {
  safeAssert([oldOrigin, newOrigin].includes(origin), 'Unsupported verification origin');
  const proof = buildProof(secrets, audience);
  const response = await fetch(`${origin}/api/_migration/key-proof`, {
    method: 'POST',
    headers: { Authorization: proof.authorization },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  safeAssert(
    response.status === 200,
    'Runtime proof unavailable or original signing key does not match',
  );
  const result = await response.json();
  safeAssert(
    result.audience === audience && result.nonce === proof.payload.nonce,
    'Runtime proof identity failed',
  );
  safeAssert(
    result.ok === true &&
      result.passwordAlgorithmMatches === true &&
      result.pbkdf2Iterations === 100_000 &&
      secretNames.every((name) => result.matches?.[name] === true),
    'Original runtime keys or password algorithm did not match',
  );
  // Never return proof tokens, signatures, derived hashes, response text or key values.
  return {
    audience,
    all_seven_keys_match: true,
    password_algorithm_matches: true,
    pbkdf2_iterations: 100_000,
  };
}

async function api(token, route, method = 'GET', body) {
  const allowed = [
    `${workerPath}/settings`,
    `${workerPath}/deployments`,
    `${workerPath}/schedules`,
    `${workerPath}/subdomain`,
    `${workerPath}/secrets`,
    `${workerPath}/secrets-bulk`,
    `/workers/domains?service=${workerName}&zone_id=eedf1732deb3080a6c42bde1b86ceb27`,
  ];
  safeAssert(allowed.includes(route), 'API route rejected');
  safeAssert(
    method === 'GET' || (method === 'PATCH' && route === `${workerPath}/secrets-bulk`),
    'API mutation rejected',
  );
  const response = await fetch(`${apiBase}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  safeAssert(response.ok && result.success === true, 'Scoped NEW Worker API operation failed');
  return result.result;
}

async function closedWorker(token) {
  const { config, target } = checkTarget('new-preparation');
  const settings = await api(token, `${workerPath}/settings`);
  const binding = (name) => settings.bindings?.find((item) => item.name === name);
  safeAssert(
    binding('DB')?.id === config.d1_databases[0].database_id && binding('DB')?.type === 'd1',
    'NEW D1 binding does not match',
  );
  for (const name of [
    'MIGRATION_MODE',
    'MIGRATION_USE_D1_CONTROL',
    'MIGRATION_VERIFICATION_ENABLED',
    'MIGRATION_AUDIENCE',
  ]) {
    safeAssert(
      binding(name)?.type === 'plain_text' && binding(name).text === config.vars[name],
      'NEW preparation mode does not match',
    );
  }
  for (const [name, className, field] of [
    ['ROOMS', 'RoomSession', 'roomNamespace'],
    ['LOGIN_GUARD', 'LoginGuard', 'loginNamespace'],
  ]) {
    const actual = binding(name);
    safeAssert(
      actual?.type === 'durable_object_namespace' && actual.class_name === className,
      'NEW DO binding does not match',
    );
    safeAssert(
      typeof actual.namespace_id === 'string' && actual.namespace_id.length === 32,
      'NEW DO namespace is unresolved',
    );
    const expected = target[field];
    safeAssert(
      typeof expected === 'string' && actual.namespace_id === expected,
      'NEW namespace was not pinned before credential handoff',
    );
    safeAssert(
      actual.script_name === undefined || actual.script_name === workerName,
      'External Worker binding rejected',
    );
  }
  const domains = await api(
    token,
    `/workers/domains?service=${workerName}&zone_id=eedf1732deb3080a6c42bde1b86ceb27`,
  );
  safeAssert(
    Array.isArray(domains) && domains.length === 0,
    'NEW preparation Worker has a public custom domain',
  );
  const schedules = await api(token, `${workerPath}/schedules`);
  safeAssert(
    Array.isArray(schedules?.schedules) && schedules.schedules.length === 0,
    'NEW preparation cron is enabled',
  );
  const subdomain = await api(token, `${workerPath}/subdomain`);
  safeAssert(
    subdomain.enabled === true && subdomain.previews_enabled === false,
    'NEW verification entry differs from the fixed plan',
  );
  for (const [method, route] of [
    ['GET', '/api/me'],
    ['GET', '/api/practice/timed/current'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/practice/start'],
    ['GET', '/'],
  ]) {
    const response = await fetch(`${newOrigin}${route}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    safeAssert(
      response.status === 503 && !response.headers.has('Set-Cookie'),
      'NEW business endpoint is open',
    );
  }
  return { account_id: newAccount, worker: workerName, public_business_closed: true };
}

async function main() {
  const action = process.argv[2];
  safeAssert(
    ['check-source', 'check-new', 'handoff-new'].includes(action),
    'Choose an explicit key-handoff action',
  );
  for (const name of Object.keys((await import('./migration-deployment-targets.mjs')).targets))
    checkTarget(name);
  const secrets = Object.fromEntries(secretNames.map((name) => [name, process.env[name]]));
  safeAssert(
    secretNames.every((name) => typeof secrets[name] === 'string' && secrets[name].length > 0),
    'Original GitHub encrypted secrets are incomplete',
  );
  const result = { action, source: await verifyRuntime(secrets, oldOrigin, '2048-old-production') };
  if (action !== 'check-source') {
    const token = process.env.CF_2048_NEW_RUNTIME_SECRETS_TOKEN;
    safeAssert(
      typeof token === 'string' && token.length > 0,
      'Dedicated NEW Worker token is missing',
    );
    result.isolation = await closedWorker(token);
    if (action === 'handoff-new') {
      safeAssert(
        process.env.APPROVED_KEY_HANDOFF === 'true',
        'Separate key-handoff approval is missing',
      );
      await api(token, `${workerPath}/secrets-bulk`, 'PATCH', {
        secrets: Object.fromEntries(
          secretNames.map((name) => [name, { name, type: 'secret_text', text: secrets[name] }]),
        ),
      });
      result.isolation = await closedWorker(token);
    }
    result.target = await verifyRuntime(secrets, newOrigin, '2048-new-production');
  }
  console.log(
    JSON.stringify({
      ...result,
      checked_at: new Date().toISOString(),
      production_migration_ready: false,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // HTTP errors can retain credential-bearing headers; never print exception details.
    console.error(
      `Key handoff stopped: ${
        [
          'Original GitHub encrypted secrets are incomplete',
          'Separate key-handoff approval is missing',
          'Dedicated NEW Worker token is missing',
          'Runtime proof unavailable or original signing key does not match',
          'Original runtime keys or password algorithm did not match',
        ].includes(error.message)
          ? error.message
          : 'verification failed; inspect only safe target/status evidence'
      }`,
    );
    process.exitCode = 1;
  });
}
