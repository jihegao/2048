import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import frozen, { hasUnsettledRoomState } from '../../worker/migration-freeze';
import { signJson } from '../../worker/lib/crypto';

const room = env.ROOMS.get(env.ROOMS.idFromName('synthetic-preserved-room'));
const guard = env.LOGIN_GUARD.get(env.LOGIN_GUARD.idFromName('synthetic-preserved-guard'));
const runtime = {
  roomId: 'synthetic-room',
  status: 'ended',
  revision: 17,
  players: [{ score: 128 }],
};
const blockedUntil = Date.now() + 900_000;

async function roomState() {
  return runInDurableObject(room, async (_instance, state) =>
    Object.fromEntries(await state.storage.list()),
  );
}

async function guardState() {
  return runInDurableObject(guard, async (_instance, state) =>
    state.storage.sql.exec('SELECT * FROM login_guard').toArray(),
  );
}

async function databaseState() {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  const result = {};
  for (const { name } of tables.results) {
    Object.assign(result, {
      [name]: (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results,
    });
  }
  return result;
}

describe.sequential('synthetic frozen Worker, without deploying', () => {
  let beforeDatabase: unknown;

  it('blocks release for live/countdown/unknown runtime or an uncommitted start intent', () => {
    for (const status of ['live', 'countdown', 'settling', 'unknown'])
      expect(hasUnsettledRoomState([['room-runtime', { status }]])).toBe(true);
    for (const status of ['open', 'full', 'ended', 'cancelled'])
      expect(hasUnsettledRoomState([['room-runtime', { status }]])).toBe(false);
    expect(hasUnsettledRoomState([['room-start-intent', { status: 'ended' }]])).toBe(true);
    expect(hasUnsettledRoomState([])).toBe(false);
  });

  beforeAll(async () => {
    await env.DB.prepare(
      `INSERT INTO users (id,login_id,role,display_name,password_hash,password_salt,password_iterations,created_at,updated_at)
       VALUES ('synthetic-teacher','synthetic-teacher','teacher','合成教师','synthetic-hash','synthetic-salt',100000,1,1)`,
    ).run();
    await runInDurableObject(room, async (_instance, state) => {
      await state.storage.put({
        'room-runtime': runtime,
        'room-start-intent': { revision: 16 },
        'teacher-dirty': true,
        'student-room-id': 'synthetic-waiting-room',
      });
    });
    await runInDurableObject(guard, async (_instance, state) => {
      state.storage.sql.exec(
        'CREATE TABLE login_guard (id INTEGER PRIMARY KEY, failures INTEGER, window_started_at INTEGER, blocked_until INTEGER)',
      );
      state.storage.sql.exec(
        'INSERT INTO login_guard VALUES (1,5,?,?)',
        blockedUntil - 900_000,
        blockedUntil,
      );
    });
    beforeDatabase = await databaseState();
    expect(Object.keys(beforeDatabase as Record<string, unknown>)).toHaveLength(17);
  });

  it('rejects GET writes, POST writes and socket upgrades on every hostname', async () => {
    for (const host of [
      'synthetic.example',
      'synthetic.workers.dev',
      'synthetic-preview.workers.dev',
    ]) {
      for (const [method, path] of [
        ['GET', '/api/me'],
        ['GET', '/api/practice/timed/current'],
        ['GET', '/api/rooms/synthetic-room/ws'],
        ['POST', '/api/auth/login'],
        ['POST', '/api/practice/submit'],
        ['POST', '/api/teacher/rooms/synthetic-room/start'],
        ['DELETE', '/api/teacher/users/synthetic-user'],
        ['GET', '/'],
      ]) {
        const response = await exports.default.fetch(`https://${host}${path}`, {
          method,
          headers: path.endsWith('/ws') ? { Upgrade: 'websocket' } : undefined,
        });
        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
  });

  it('ignores cron without touching business data', async () => {
    await frozen.scheduled();
    expect(await databaseState()).toEqual(beforeDatabase);
  });

  it('proves the frozen owner and stable DO state without returning stored data', async () => {
    const beforeRoom = await roomState();
    const beforeGuard = await guardState();
    const payload = {
      purpose: '2048-frozen-object-probe-v1',
      audience: 'synthetic-freeze',
      nonce: 'synthetic-probe-nonce-00000000',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      objects: [
        { kind: 'room', id: room.id.toString() },
        { kind: 'login-guard', id: guard.id.toString() },
      ],
    };
    const token = await signJson(
      payload,
      '2048-migration-object-probe-auth-v1\u0000synthetic-freeze-import',
    );
    const probe = async () =>
      exports.default.fetch('https://synthetic.example/api/_migration/objects/probe', {
        method: 'POST',
        headers: { Authorization: `Migration ${token}` },
      });
    const first = await probe();
    expect(first.status).toBe(200);
    const result = (await first.json()) as { objects: { digest: string; openSockets: number }[] };
    expect(result.objects).toHaveLength(2);
    expect(result.objects.every((object) => object.openSockets === 0)).toBe(true);
    expect(await (await probe()).json()).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('blocked_until');
    expect(JSON.stringify(result)).not.toContain('room-runtime');
    expect(await roomState()).toEqual(beforeRoom);
    expect(await guardState()).toEqual(beforeGuard);
    expect(await databaseState()).toEqual(beforeDatabase);
    expect(
      (
        await exports.default.fetch('https://synthetic.example/api/_migration/objects/probe', {
          method: 'POST',
        })
      ).status,
    ).toBe(401);
  });

  it('rejects RoomSession calls and retains runtime/start intent/expiry metadata', async () => {
    await evictDurableObject(room);
    for (const path of ['snapshot', 'start', 'join', 'cancel', 'arm-expiry', 'kick']) {
      expect((await room.fetch(`https://object/${path}`, { method: 'POST' })).status).toBe(503);
    }
    await runInDurableObject(room, async (instance) => instance.alarm());
    expect(await roomState()).toEqual({
      'room-runtime': runtime,
      'room-start-intent': { revision: 16 },
      'teacher-dirty': true,
      'student-room-id': 'synthetic-waiting-room',
    });
  });

  it('retains LoginGuard failures and the full block deadline', async () => {
    const before = await guardState();
    await evictDurableObject(guard);
    for (const action of ['check', 'success', 'failure']) {
      expect(
        (await guard.fetch('https://guard', { method: 'POST', body: JSON.stringify({ action }) }))
          .status,
      ).toBe(503);
    }
    expect(await guardState()).toEqual(before);
    expect((await guardState())[0].blocked_until).toBe(blockedUntil);
  });

  it('closes socket events without clearing or resaving old runtime', async () => {
    const before = await roomState();
    await runInDurableObject(room, async (instance, state) => {
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[1]);
      await instance.webSocketMessage(pair[1], '{"type":"move","seq":1,"direction":"left"}');
      await instance.webSocketClose(pair[1], 1000, 'synthetic close', true);
      await instance.webSocketError(pair[1], new Error('synthetic disconnect'));
    });
    expect(await roomState()).toEqual(before);
  });

  it('preserves every D1 table through the full synthetic event sequence', async () => {
    expect(await databaseState()).toEqual(beforeDatabase);
  });
});
