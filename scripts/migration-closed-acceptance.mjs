import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMove, createGame } from '../shared/game.ts';
import { CandidateClient } from './migration-candidate-client.mjs';

const origin = 'https://mingcheng1024.cn';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const directions = ['left', 'down', 'right', 'up'];
const require = createRequire(import.meta.url);

export function finishingMoves(seed, now = Date.now()) {
  let game = createGame(seed, now);
  const moves = [];
  for (let i = 0; game.status !== 'over' && i < 10000; i++) {
    const choices = directions.map((direction) => ({
      direction,
      ...applyMove(game, direction, now + moves.length + 1),
    }));
    const selected = choices.find((x) => x.moved);
    assert.ok(selected, 'Synthetic practice has no valid finishing move');
    moves.push(selected.direction);
    game = selected.snapshot;
  }
  assert.equal(game.status, 'over', 'Synthetic practice must finish normally');
  return { moves, game };
}

async function json(client, route, method = 'GET', body, status = 200) {
  const response = await client.request(route, method, body);
  // Never print a response, credential, cookie, proof, CSV, username or record.
  assert.equal(response.status, status, 'Closed acceptance API status failed');
  try {
    return await response.json();
  } catch {
    throw new Error('Closed acceptance JSON invalid');
  }
}

async function pause(ms) {
  assert.ok(ms >= 0 && ms <= 5000);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function socketMove(client, roomId, WebSocket = require('ws')) {
  const { url, headers } = client.websocket(`/api/rooms/${roomId}/ws`);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, followRedirects: false, handshakeTimeout: 20000 });
    let sent = false;
    let expected;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Closed acceptance WebSocket timed out'));
    }, 25000);
    const fail = (reason = 'transport') => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error(`Closed acceptance WebSocket failed: ${reason}`));
    };
    socket.on('error', () => fail('transport'));
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      fail(`http-${response.statusCode}`);
    });
    socket.on('close', (code) => {
      if (!sent || !expected?.verified) fail(`close-${code}`);
    });
    socket.on('message', (bytes) => {
      try {
        const state = JSON.parse(bytes.toString());
        if (state.type !== 'state' || state.roomStatus !== 'live' || !state.game) return;
        assert.equal(state.players, undefined, 'Private student state leaked roster');
        if (!sent) {
          assert.equal(state.canControl, true);
          const chosen = directions
            .map((direction) => ({ direction, ...applyMove(state.game, direction) }))
            .find((x) => x.moved);
          assert.ok(chosen);
          expected = chosen.snapshot;
          sent = true;
          socket.send(
            JSON.stringify({ type: 'move', seq: state.game.seq + 1, direction: chosen.direction }),
          );
          // A skipped sequence returns authoritative state without accepting
          // another move; the socket queue handles it after the valid move.
          socket.send(
            JSON.stringify({
              type: 'move',
              seq: state.game.seq + 100,
              direction: chosen.direction,
            }),
          );
        } else if (state.game.seq === expected.seq) {
          assert.deepEqual(state.game.board, expected.board);
          assert.equal(state.game.score, expected.score);
          expected.verified = true;
          clearTimeout(timer);
          socket.close(1000, 'Controlled acceptance complete');
          resolve(true);
        }
      } catch {
        fail('synthetic-state-check');
      }
    });
  });
}

export async function acceptance(env = process.env) {
  assert.equal(env.CONFIRMED_MAINTENANCE_WINDOW, 'true');
  assert.equal(env.VERIFIED_SOURCE_FROZEN, 'true');
  assert.equal(env.VERIFIED_FULL_COPY, 'true');
  assert.equal(env.VERIFIED_LOGIN_GUARD_WINDOW, 'true');
  assert.match(env.EXPECTED_CANDIDATE_VERSION ?? '', uuid);
  assert.match(env.ACCEPTANCE_FIXTURE_TAG ?? '', /^MIG261011[A-Z0-9]{6,12}$/u);
  for (const key of [
    'IMPORT_SIGNING_KEY',
    'BOOTSTRAP_TEACHER_USERNAME',
    'BOOTSTRAP_TEACHER_PASSWORD',
    'INITIAL_STUDENT_PASSWORD',
  ])
    assert.ok(env[key], 'Approved original encrypted secret missing');
  const key = env.IMPORT_SIGNING_KEY;
  const version = env.EXPECTED_CANDIDATE_VERSION;
  const tag = env.ACCEPTANCE_FIXTURE_TAG;
  const teacher = new CandidateClient(key, version);
  const studentClients = Array.from({ length: 6 }, () => new CandidateClient(key, version));
  const checks = [];
  const checked = (name) => {
    checks.push(name);
    console.log(JSON.stringify({ closed_acceptance_completed_check: name }));
  };
  const publicResponse = await fetch(`${origin}/api/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(publicResponse.status, 503);
  assert.equal(publicResponse.headers.get('set-cookie'), null);
  checked('public_business_remains_closed');
  assert.equal((await json(teacher, '/api/health')).ok, true);
  // One attempt only: never brute force, reset a password or bootstrap over an existing user.
  const logged = await json(teacher, '/api/auth/login', 'POST', {
    loginId: env.BOOTSTRAP_TEACHER_USERNAME,
    password: env.BOOTSTRAP_TEACHER_PASSWORD,
    locale: 'zh-CN',
  });
  assert.equal(logged.user.role, 'teacher');
  checked('original_teacher_password_and_role');
  const users = await json(teacher, '/api/teacher/users?pageSize=1');
  assert.ok(users.total >= Number(env.SOURCE_USER_COUNT ?? 1037));
  const history = await teacher.request('/api/teacher/results/export.csv');
  assert.equal(history.status, 200);
  const historyText = await history.text();
  assert.ok(historyText.length > 0);
  const baselineHistoryDigest = createHash('sha256').update(historyText).digest('hex');
  const offline = await json(teacher, '/api/teacher/teams/export');
  assert.equal(offline.version, 1);
  assert.ok(offline.teams.length > 0);
  checked('retained_users_history_and_offline_team_export');
  const rows = Array.from({ length: 6 }, (_, i) => ({
    studentNumber: `${tag}S${i + 1}`,
    name: `${tag} controlled ${i + 1}`,
    className: tag,
    gradeLevel: 6,
  }));
  const importRows = async (type, values) => {
    const base = `/api/teacher/${type}/import`;
    const preview = await json(teacher, `${base}/validate`, 'POST', { rows: values });
    assert.equal(preview.errors.length, 0, 'Controlled fixture import validation failed');
    return json(teacher, `${base}/commit`, 'POST', { rows: values, token: preview.token });
  };
  // All fixtures have a unique tag and must be privately preserved, then removed
  // before public release. Never overwrite a real student or team by name.
  const conflicts = await json(teacher, `/api/teacher/users?query=${tag}&pageSize=100`);
  assert.equal(conflicts.total, 0, 'Controlled fixture tag already exists');
  await importRows('users', rows);
  await importRows('teams', [
    { name: `${tag} team A`, memberStudentNumbers: rows.slice(0, 3).map((r) => r.studentNumber) },
    { name: `${tag} team B`, memberStudentNumbers: rows.slice(3).map((r) => r.studentNumber) },
  ]);
  for (let i = 0; i < 6; i++) {
    const student = await json(studentClients[i], '/api/auth/login', 'POST', {
      loginId: rows[i].studentNumber,
      password: env.INITIAL_STUDENT_PASSWORD,
      locale: i % 2 ? 'en' : 'zh-CN',
    });
    assert.equal(student.user.role, 'student');
  }
  const forbidden = await studentClients[0].request('/api/teacher/users');
  assert.equal(forbidden.status, 403);
  checked('controlled_original_initial_password_and_role_isolation');
  const practice = await json(studentClients[0], '/api/practice/start', 'POST', {});
  const finished = finishingMoves(practice.seed, Date.parse(practice.startedAt));
  const saved = await json(studentClients[0], '/api/practice/complete', 'POST', {
    challenge: practice.challenge,
    moves: finished.moves,
  });
  assert.equal(saved.result.score, finished.game.score);
  assert.equal(saved.result.maxTile, finished.game.maxTile);
  checked('free_practice_normal_finish_and_saved_score');
  const timed = await json(studentClients[1], '/api/practice/timed/start', 'POST', {});
  assert.equal(timed.status, 'active');
  assert.equal(Date.parse(timed.session.deadlineAt) - Date.parse(timed.session.startedAt), 180000);
  const planned = finishingMoves(timed.session.seed, Date.parse(timed.session.startedAt));
  assert.ok(planned.moves.length <= 5000);
  let state = timed;
  for (let i = 0; i < planned.moves.length && state.status === 'active'; i += 64) {
    state = await json(studentClients[1], '/api/practice/timed/moves', 'POST', {
      sessionId: timed.session.id,
      seq: i + 1,
      directions: planned.moves.slice(i, i + 64),
    });
  }
  if (state.status !== 'settled')
    state = await json(studentClients[1], '/api/practice/timed/finish', 'POST', {
      sessionId: timed.session.id,
    });
  assert.equal(state.status, 'settled');
  assert.equal(state.result.score, planned.game.score);
  checked('timed_practice_sequence_replay_and_settlement');
  const room = (
    await json(
      teacher,
      '/api/teacher/rooms',
      'POST',
      { name: `${tag} match`, mode: 'team_3v3', durationMinutes: 1 },
      201,
    )
  ).room;
  assert.match(room.id, uuid);
  await json(studentClients[0], `/api/rooms/${room.id}/join`, 'POST', {});
  await json(studentClients[3], `/api/rooms/${room.id}/join`, 'POST', {});
  const start = await json(teacher, `/api/teacher/rooms/${room.id}/start`, 'POST', {});
  assert.equal(start.endsAt - start.startsAt, 60000);
  while (Date.now() < start.startsAt + 200)
    await pause(Math.min(3000, start.startsAt + 200 - Date.now()));
  const snapshot = await json(studentClients[0], `/api/rooms/${room.id}/match`);
  assert.ok(snapshot.game);
  assert.equal(snapshot.players, undefined);
  const live = await json(teacher, `/api/teacher/rooms/${room.id}/live`);
  assert.equal(live.players.length, 6);
  await socketMove(studentClients[0], room.id);
  const deadline = start.endsAt + 60000;
  let ended;
  do {
    await pause(3000);
    ended = (await json(teacher, `/api/teacher/rooms/${room.id}`)).room;
  } while (ended.status !== 'ended' && Date.now() < deadline);
  assert.equal(ended.status, 'ended', 'Controlled match must settle naturally');
  const result = (await json(teacher, `/api/teacher/results/${room.id}`)).result;
  assert.equal(result.players.length, 6);
  checked('actual_websocket_move_private_snapshot_and_natural_match_settlement');
  const waiting = (
    await json(
      studentClients[0],
      '/api/rooms',
      'POST',
      { name: `${tag} waiting`, durationMinutes: 1 },
      201,
    )
  ).room;
  assert.equal(waiting.status, 'open');
  assert.match(waiting.id, uuid);
  checked('controlled_waiting_room_created_with_expiry');
  for (const client of [...studentClients, teacher]) {
    await json(client, '/api/auth/logout', 'POST', {});
    client.clearCookies();
  }
  return {
    closed_acceptance_phase_one_passed: true,
    production_migration_ready: false,
    fixture_tag: tag,
    synthetic_match_room: room.id,
    synthetic_waiting_room: waiting.id,
    checks,
    retained_history_export_digest: baselineHistoryDigest,
    must_preserve_all_new_writes_and_remove_only_controlled_fixtures_before_release: true,
    checked_at: new Date().toISOString(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  acceptance()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => {
      const line = /migration-closed-acceptance\.mjs:(\d+):(\d+)/u.exec(error?.stack ?? '');
      const socketReason =
        /^Closed acceptance WebSocket (?:failed: (?:transport|http-\d{3}|close-\d{4}|synthetic-state-check)|timed out)$/u.test(
          error?.message ?? '',
        )
          ? error.message
          : undefined;
      console.error(
        JSON.stringify({
          closed_acceptance_failed: true,
          script_line: line ? Number(line[1]) : null,
          socket_reason: socketReason,
        }),
      );
      console.error(
        'Closed NEW acceptance stopped; data must be preserved. No request, response or credential details logged.',
      );
      process.exitCode = 1;
    });
}
