import { DurableObject } from 'cloudflare:workers';
import { migrationKeyProof } from './lib/migration-key-proof';
import { sha256, verifySignedJson } from './lib/crypto';
import { migrationBinding } from './lib/migration';

const FROZEN_ARTIFACT = '2048-frozen-v1';

interface ObjectProbe {
  purpose: '2048-frozen-object-probe-v1';
  audience: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  objects: { kind: 'room' | 'login-guard'; id: string }[];
}

function versionId(env: Env): string | null {
  const metadata = migrationBinding(env, 'CF_VERSION_METADATA') as { id?: unknown } | undefined;
  return typeof metadata?.id === 'string' ? metadata.id : null;
}

async function objectProbe(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/_migration/objects/probe') return null;
  const unavailable = () => Response.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
  if (migrationBinding(env, 'MIGRATION_VERIFICATION_ENABLED') !== 'true') return unavailable();
  const key = migrationBinding(env, 'IMPORT_SIGNING_KEY');
  const audience = migrationBinding(env, 'MIGRATION_AUDIENCE');
  const authorization = request.headers.get('Authorization') ?? '';
  if (
    request.method !== 'POST' ||
    typeof key !== 'string' ||
    !key ||
    typeof audience !== 'string' ||
    !authorization.startsWith('Migration ') ||
    authorization.length > 12_000
  )
    return unavailable();
  let probe: ObjectProbe | null;
  try {
    probe = await verifySignedJson<ObjectProbe>(
      authorization.slice(10),
      `2048-migration-object-probe-auth-v1\u0000${key}`,
    );
  } catch {
    probe = null;
  }
  const now = Date.now();
  if (
    !probe ||
    probe.purpose !== '2048-frozen-object-probe-v1' ||
    probe.audience !== audience ||
    !/^[A-Za-z0-9_-]{22,64}$/u.test(probe.nonce) ||
    !Number.isFinite(probe.issuedAt) ||
    !Number.isFinite(probe.expiresAt) ||
    probe.issuedAt > now + 5_000 ||
    probe.issuedAt < now - 60_000 ||
    probe.expiresAt < now ||
    probe.expiresAt <= probe.issuedAt ||
    probe.expiresAt - probe.issuedAt > 60_000 ||
    !Array.isArray(probe.objects) ||
    probe.objects.length < 1 ||
    probe.objects.length > 20 ||
    probe.objects.some(
      (item) =>
        !item || !['room', 'login-guard'].includes(item.kind) || !/^[a-f0-9]{64}$/u.test(item.id),
    )
  ) {
    return unavailable();
  }
  const results = [];
  if (!versionId(env)) {
    return Response.json({ error: { code: 'VERSION_METADATA_MISSING' } }, { status: 503 });
  }
  for (const object of probe.objects) {
    const namespace = object.kind === 'room' ? env.ROOMS : env.LOGIN_GUARD;
    const response = await namespace
      .get(namespace.idFromString(object.id))
      .fetch('https://object.internal/_migration/probe', {
        method: 'POST',
        headers: { 'X-2048-Migration-Probe': FROZEN_ARTIFACT },
      });
    if (response.status !== 200)
      return Response.json({ error: { code: 'DO_VERSION_NOT_FROZEN' } }, { status: 503 });
    const result = (await response.json()) as {
      artifact?: string;
      objectId?: string;
      kind?: string;
      versionId?: string | null;
    };
    if (
      result.artifact !== FROZEN_ARTIFACT ||
      result.objectId !== object.id ||
      result.kind !== object.kind ||
      result.versionId !== versionId(env)
    ) {
      return Response.json({ error: { code: 'DO_VERSION_NOT_FROZEN' } }, { status: 503 });
    }
    results.push(result);
  }
  return Response.json(
    { artifact: FROZEN_ARTIFACT, versionId: versionId(env), nonce: probe.nonce, objects: results },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

// Standalone maintenance artifact. OLD may use it only after a verified drain.
// Authenticated checks return key equality and storage digests without stored data.
// Business requests never access D1 or DO storage.
function unavailable(): Response {
  return Response.json(
    { error: { code: 'MIGRATION_MAINTENANCE', message: '迁移维护中，请稍后重试' } },
    {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '300' },
    },
  );
}

function closeSocket(socket: WebSocket): void {
  try {
    socket.close(1013, 'Migration maintenance');
  } catch {
    // A disconnected socket needs no persistence or retry.
  }
}

export function hasUnsettledRoomState(kv: [string, unknown][]): boolean {
  const state = new Map(kv);
  if (state.has('room-start-intent')) return true;
  const runtime = state.get('room-runtime');
  if (runtime === undefined) return false;
  const status = runtime && typeof runtime === 'object' && (runtime as { status?: unknown }).status;
  return !['open', 'full', 'ended', 'cancelled'].includes(String(status));
}

class FrozenObject extends DurableObject<Env> {
  protected readonly kind: 'room' | 'login-guard' = 'room';

  async fetch(request: Request): Promise<Response> {
    for (const socket of this.ctx.getWebSockets()) closeSocket(socket);
    if (
      new URL(request.url).pathname === '/_migration/probe' &&
      request.headers.get('X-2048-Migration-Probe') === FROZEN_ARTIFACT
    ) {
      const kv = [...(await this.ctx.storage.list())];
      let loginRows: unknown[] = [];
      if (
        this.kind === 'login-guard' &&
        this.ctx.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='login_guard'")
          .toArray().length
      ) {
        loginRows = this.ctx.storage.sql.exec('SELECT * FROM login_guard ORDER BY id').toArray();
      }
      const nextAlarmAt = await this.ctx.storage.getAlarm();
      const storageDigest = await sha256(JSON.stringify({ kv, loginRows }));
      const digest = await sha256(JSON.stringify({ kv, loginRows, alarm: nextAlarmAt }));
      return Response.json({
        artifact: FROZEN_ARTIFACT,
        versionId: versionId(this.env),
        kind: this.kind,
        objectId: this.ctx.id.toString(),
        digest,
        storageDigest,
        nextAlarmAt,
        pendingBusiness: this.kind === 'room' && hasUnsettledRoomState(kv),
        openSockets: this.ctx
          .getWebSockets()
          .filter((socket) => socket.readyState === WebSocket.OPEN).length,
      });
    }
    return unavailable();
  }

  async alarm(): Promise<void> {
    // No business settlement, storage change or new alarm. Retain OLD state.
  }

  async webSocketMessage(socket: WebSocket): Promise<void> {
    closeSocket(socket);
  }

  async webSocketClose(): Promise<void> {
    // Preserve the old runtime instead of persisting connection side effects.
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    closeSocket(socket);
  }
}

// Keep both existing class exports so OLD namespace identities remain intact.
export class RoomSession extends FrozenObject {}
export class LoginGuard extends FrozenObject {
  protected readonly kind = 'login-guard' as const;
}

export default {
  fetch: async (request: Request, env: Env): Promise<Response> =>
    (await migrationKeyProof(request, env)) ?? (await objectProbe(request, env)) ?? unavailable(),
  scheduled: async (): Promise<void> => {
    // Cron may still invoke the Worker; maintenance performs no business work.
  },
};
