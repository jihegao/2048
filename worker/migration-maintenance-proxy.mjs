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
    if (path === '/' && ['GET', 'HEAD'].includes(request.method)) {
      const html =
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>2048 已迁移</title><body><main><h1>2048 已迁移</h1><p>请前往新站继续使用。原账号和已保存的对局数据已保留。</p><p><a href="https://mingcheng1024.cn/">打开 mingcheng1024.cn</a></p></main></body></html>';
      return new Response(request.method === 'HEAD' ? null : html, {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Retry-After': '300',
          'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }
    let method;
    const headers = new Headers();
    if (path === '/api/health' && request.method === 'GET') {
      method = 'GET';
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
