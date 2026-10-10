import assert from 'node:assert/strict';
import { test } from 'node:test';
import proxy from '../../worker/migration-maintenance-proxy.mjs';

test('maintenance proxy never forwards business, cookie or unapproved request data', async () => {
  const requests = [];
  const env = {
    ORIGINAL: {
      fetch: async (request) => {
        requests.push(request);
        return Response.json({ ok: true });
      },
    },
  };
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/api/me'],
    ['GET', '/api/practice/timed/current'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/health'],
    ['POST', '/api/_migration/objects/probe'],
  ]) {
    assert.equal(
      (await proxy.fetch(new Request(`https://old.example${path}`, { method }), env)).status,
      503,
    );
  }
  assert.equal(requests.length, 0);
  assert.equal(
    (
      await proxy.fetch(
        new Request('https://old.example/api/health?forward=login', {
          headers: { Cookie: 'synthetic-session', Authorization: 'synthetic-unrelated-auth' },
        }),
        env,
      )
    ).status,
    200,
  );
  assert.equal(requests[0].url, 'https://original.internal/api/health');
  assert.equal([...requests[0].headers].length, 0);
});

test('only an authenticated proof shape is forwarded, and cookies from OLD are refused', async () => {
  const authorization = `Migration synthetic-proof.${'a'.repeat(43)}`;
  let forwarded;
  const env = {
    ORIGINAL: {
      fetch: async (request) => {
        forwarded = request;
        return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'synthetic-session' } });
      },
    },
  };
  const response = await proxy.fetch(
    new Request('https://old.example/api/_migration/key-proof?ignored=1', {
      method: 'POST',
      headers: { Authorization: authorization, Cookie: 'synthetic-session' },
      body: 'not forwarded',
    }),
    env,
  );
  assert.equal(response.status, 503);
  assert.equal(forwarded.url, 'https://original.internal/api/_migration/key-proof');
  assert.equal(forwarded.headers.get('Authorization'), authorization);
  assert.equal(forwarded.headers.has('Cookie'), false);
  assert.equal(await forwarded.text(), '');
});
