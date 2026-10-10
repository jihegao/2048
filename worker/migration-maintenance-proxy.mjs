function maintenance() {
  return Response.json(
    { error: { code: 'MIGRATION_MAINTENANCE', message: '迁移维护中，请稍后重试' } },
    { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' } },
  );
}

// No secrets, D1, DO, assets or scheduled work. Use only inside a confirmed
// maintenance window to shield OLD while restoring its original Worker version.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    let method;
    const headers = new Headers();
    if (path === '/api/health' && request.method === 'GET') {
      method = 'GET';
    } else if (
      ['/api/_migration/key-proof', '/api/_migration/objects/probe'].includes(path) &&
      request.method === 'POST'
    ) {
      const authorization = request.headers.get('Authorization') ?? '';
      if (
        authorization.length > 12_000 ||
        !/^Migration [A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(authorization)
      )
        return maintenance();
      method = 'POST';
      headers.set('Authorization', authorization);
    } else return maintenance();
    const upstream = await env.ORIGINAL.fetch(
      new Request(`https://original.internal${path}`, { method, headers }),
    );
    if (upstream.headers.has('Set-Cookie')) return maintenance();
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
