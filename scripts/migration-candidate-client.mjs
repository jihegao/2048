import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const origin = 'https://mingcheng1024.cn';
const header = 'X-2048-Migration-Authorization';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

// The key, signature, passwords, cookies and response bodies stay in the runner.
export function candidateHeaders(key, versionId, route, method = 'GET', body = '') {
  assert.ok(typeof key === 'string' && key.length > 0, 'Operator signing key is missing');
  assert.match(versionId, uuid, 'An exact deployed candidate version is required');
  assert.ok(typeof route === 'string' && route.startsWith('/api/'));
  const url = new URL(route, origin);
  assert.ok(url.origin === origin && !url.username && !url.password && !url.hash);
  assert.ok(url.pathname.startsWith('/api/'), 'Only candidate API requests are supported');
  assert.ok(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method));
  const bytes = Buffer.from(body);
  assert.ok(bytes.length <= 64 * 1024, 'Candidate request exceeds the reviewed body limit');
  assert.ok(!['GET', 'HEAD'].includes(method) || bytes.length === 0);
  const issuedAt = Date.now();
  const proof = {
    purpose: '2048-closed-candidate-v1',
    audience: '2048-new-production',
    versionId,
    nonce: randomBytes(24).toString('base64url'),
    issuedAt,
    expiresAt: issuedAt + 30000,
    method,
    url: url.href,
    bodyDigest: createHash('sha256').update(bytes).digest('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(proof)).toString('base64url');
  const signature = createHmac('sha256', `2048-closed-candidate-auth-v1\u0000${key}`)
    .update(encoded)
    .digest('base64url');
  return { Origin: origin, [header]: `${encoded}.${signature}` };
}

export class CandidateClient {
  #key;
  #version;
  #transport;
  #cookies = new Map();
  constructor(key, versionId, transport = globalThis.fetch) {
    candidateHeaders(key, versionId, '/api/health');
    assert.equal(typeof transport, 'function');
    this.#key = key;
    this.#version = versionId;
    this.#transport = transport;
  }

  async request(route, method = 'GET', value) {
    const body = value === undefined ? '' : JSON.stringify(value);
    const headers = candidateHeaders(this.#key, this.#version, route, method, body);
    if (this.#cookies.size)
      headers.Cookie = [...this.#cookies].map(([name, token]) => `${name}=${token}`).join('; ');
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      const transport = this.#transport;
      response = await transport(new URL(route, origin), {
        method,
        headers,
        ...(body ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new Error('Closed candidate request could not complete');
    }
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
      const match = /^(__Host-session(?:-[A-Za-z0-9_-]+)?)=([^;]*)$/u.exec(pair);
      if (!match) continue;
      assert.ok(attributes.some((attribute) => /^secure$/iu.test(attribute)));
      assert.ok(attributes.some((attribute) => /^path=\/$/iu.test(attribute)));
      assert.ok(!attributes.some((attribute) => /^domain=/iu.test(attribute)));
      if (!match[2] || attributes.some((attribute) => /^max-age=0$/iu.test(attribute)))
        this.#cookies.delete(match[1]);
      else this.#cookies.set(match[1], match[2]);
    }
    return response;
  }

  websocket(route) {
    assert.match(route, /^\/api\/rooms\/[A-Za-z0-9_-]+\/ws$/u);
    const headers = candidateHeaders(this.#key, this.#version, route);
    if (this.#cookies.size)
      headers.Cookie = [...this.#cookies].map(([name, token]) => `${name}=${token}`).join('; ');
    return { url: `wss://mingcheng1024.cn${route}`, headers };
  }

  clearCookies() {
    this.#cookies.clear();
  }
}
