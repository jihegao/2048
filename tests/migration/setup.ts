import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await env.DB.batch(env.TEST_FIXTURE_INSERTS.map((sql) => env.DB.prepare(sql)));
await env.DB.batch(
  env.TEST_FENCE_SQL.trim()
    .split('\n')
    .map((sql) => env.DB.prepare(sql)),
);
