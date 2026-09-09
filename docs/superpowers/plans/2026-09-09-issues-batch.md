# GitHub Issues Batch (#10 #15 #16 #12 #14 #11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve open issues #10, #15, #16, #12, #14, #11 in that order, one branch + PR per issue, per user-confirmed decisions: #14 students only; #16 iPadOS ≥16.4 only; #15 keyboard must work on touchscreen laptops; #11 drops move-verification and trusts client board state.

**Architecture:** React 19 + Vite SPA (`src/`), Hono Worker (`worker/`), Durable Objects (`RoomSession` per room, `LoginGuard`), D1 sessions. Sequential execution, each issue branched from `main` (or stacked if predecessor unmerged), TDD where tests exist (vitest unit / vitest-pool-workers integration / Playwright e2e).

**Tech Stack:** TypeScript, React, Hono, Cloudflare Workers/DO/D1, Vitest, Playwright.

**Verify commands (repo):** `npm run lint`, `npm run typecheck`, `npm test` (unit), `npm run test:worker`, `npx playwright test` (e2e; CI runs Chromium projects). Full gate: `npm run check`.

**Decisions locked with user (2026-09-09):**
- #14: single-session applies to students only; teachers/admins keep unlimited sessions. Kicked student's live WS must close (issue acceptance "实时连接校验").
- #16: only iPadOS ≥16.4 (unprefixed Fullscreen API available; no webkit-prefix JS work).
- #15: touchscreen laptops (e.g. Huawei HarmonyOS touch laptops, `maxTouchPoints > 0` + physical keyboard) must keep arrow-key control.
- #11: server ignores move actions, only accepts board state (client-asserted scores within deadline — trust model change accepted; contradicts original issue text "服务器不接收客户端分数", to be noted in PR/issue comment).

---

### Task 1: Issue #10 — lobby polling flicker

**Files:**
- Modify: `src/pages/student/RoomLobbyPage.tsx:48-49`
- Test: `tests/e2e/platform.spec.ts` (new test after 'student can find a team and join a room lobby')

- [ ] **Step 1: Create branch** `codex/issue-10-lobby-flicker` from `main`

- [ ] **Step 2: Write failing e2e test** (append after the lobby join test, ~line 608):

```ts
test('room lobby keeps content visible while polling refreshes', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  const lobbyRoom = (status: string) => ({
    room: {
      id: 'room-1', code: 'A2048', name: 'Grade 6 Challenge', mode: 'duel',
      durationMinutes: 5, status, isParticipant: true, participantCount: 1,
      participantCapacity: 2, lockedAt: '2026-08-26T08:00:00.000Z', startsAt: null,
      endsAt: null, createdAt: '2026-08-26T08:00:00.000Z',
      entries: [{ side: 'A', student_no: '20260001', display_name: 'Demo Student', team_name: null, team_code: null }],
    },
  });
  let detailRequests = 0;
  await page.route('**/api/rooms/room-1', async (route) => {
    detailRequests += 1;
    if (detailRequests > 1) await new Promise((resolve) => setTimeout(resolve, 2600));
    return route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(lobbyRoom('open')),
    });
  });
  await page.goto('/student/rooms');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '加入房间' : 'Join room' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '房间候场' : 'Room lobby',
  );
  await page.waitForTimeout(2300); // first poll (2s interval) is now in flight for ~0.3s more
  expect(detailRequests).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('status')).toHaveCount(0); // LoadingBlock must not flash
  await expect(page.locator('.lobby-card')).toBeVisible();
});
```

- [ ] **Step 3: Run it, verify FAIL** — `npx playwright test -g "keeps content visible"` (LoadingBlock `[role=status]` appears during in-flight poll)

- [ ] **Step 4: Fix `RoomLobbyPage.tsx`** — replace lines 48-49:

```tsx
  if (room.loading && !room.data) return <LoadingBlock />;
  if (!room.data) return <Alert message={room.error || t('match.notParticipant')} />;
```

and surface transient polling errors inline with the existing local error (after `{error ? <Alert message={error} /> : null}` add):

```tsx
  {room.error ? <Alert message={room.error} /> : null}
```

(keep the existing local `error` alert above it; render both under the header, before `<Card>`).

- [ ] **Step 5: Run test, verify PASS** — same command; then `npm run lint && npm run typecheck`
- [ ] **Step 6: Commit** `fix: keep lobby content mounted during polling refreshes` — push branch, `gh pr create` with "Closes #10"

---

### Task 2: Issue #15 — keyboard on touchscreen laptops

**Files:**
- Modify: `src/components/GameBoard.tsx:43`
- Modify: `src/pages/student/MatchPage.tsx:130-132`
- Modify: `src/pages/student/PracticePage.tsx:152-156`
- Test: `tests/e2e/platform.spec.ts:501-529`

- [ ] **Step 1: Branch** `codex/issue-15-touch-keyboard` from `main`

- [ ] **Step 2: Update the固化断言 (test-first)** — in test 'practice board accepts swipe on touch and keyboard on desktop', replace lines 525-528:

```ts
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      await page.keyboard.press(key);
    }
    await expect(board).toHaveText(afterSwipe ?? '');
```

with:

```ts
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => board.textContent()).not.toBe(afterSwipe);
```

(after a left swipe tiles are packed left, so ArrowRight always changes the board; the preceding multi-touch-cancel assertion `await expect(board).toHaveText(afterSwipe ?? '')` stays unchanged).

- [ ] **Step 3: Run touch projects, verify FAIL** — `npx playwright test -g "practice board accepts swipe" --project=<touch project names>` (keyboard still disabled via `maxTouchPoints`)

- [ ] **Step 4: Implement** — `GameBoard.tsx:43`:

```ts
    if (!onMove || disabled) return;
```

Hint text uses primary-pointer detection instead of touch capability. In both `MatchPage.tsx` (~131) and `PracticePage.tsx` (~152):

```tsx
            <p className="input-hint">
              {window.matchMedia('(pointer: coarse)').matches
                ? t('practice.touchHint')
                : t('practice.keyboardHint')}
            </p>
```

- [ ] **Step 5: Run, verify PASS** — same command (all projects); `npm run lint && npm run typecheck`
- [ ] **Step 6: Commit** `fix: keep keyboard controls on touch-capable laptops` — push, PR "Closes #15"

---

### Task 3: Issue #16 — iPad fullscreen (iPadOS ≥16.4)

**Files:**
- Modify: `src/styles.css:1159-1173` (fullscreen surface), `:1251-1255` (board sizing), `:1772-1790` (narrow media query), new `.fullscreen-exit` rules
- Modify: `src/pages/student/MatchPage.tsx`, `src/pages/student/PracticePage.tsx` (in-surface exit button)
- Test: `tests/e2e/platform.spec.ts` (extend fullscreen assertions in tests at ~450 and ~610)

- [ ] **Step 1: Branch** `codex/issue-16-ipad-fullscreen` from `main`

- [ ] **Step 2: Extend e2e first** — in test 'student can return to an active match from the room list', after `await expect(gameSurface.locator('.game-statusbar > strong')).toHaveCount(2);` (line ~640) replace the Escape-exit block with:

```ts
  await page.keyboard.press('Escape');
  await expect(gameSurface).not.toHaveClass(/is-fullscreen/u);

  await fullscreenButton.click();
  await expect(gameSurface).toHaveClass(/is-fullscreen/u);
  const exitButton = gameSurface.getByRole('button', {
    name: locale === 'zh-CN' ? '退出全屏' : 'Exit fullscreen',
  });
  await expect(exitButton).toBeVisible();
  await exitButton.click();
  await expect(gameSurface).not.toHaveClass(/is-fullscreen/u);
```

(and in the practice test at ~476, after Escape-exit add the same re-enter + `.fullscreen-exit` click-exit block).

- [ ] **Step 3: Run, verify FAIL** (no exit button inside the surface yet)

- [ ] **Step 4: Implement.** In both pages, inside `<div ref={fullscreenRef} className={...}>` as first child:

```tsx
        <button
          type="button"
          className="fullscreen-exit"
          onClick={() => void toggleFullscreen()}
        >
          {t('common.exitFullscreen')}
        </button>
```

`src/styles.css` — fullscreen surface block becomes (vh line kept as fallback, then dvh; padding uses `max()` with safe-area insets):

```css
.game-surface.is-fullscreen,
.game-surface:fullscreen {
  width: 100%;
  max-width: none;
  min-height: 100vh;
  min-height: 100dvh;
  margin: 0;
  padding:
    max(clamp(16px, 4vw, 40px), env(safe-area-inset-top))
    max(clamp(16px, 4vw, 40px), env(safe-area-inset-right))
    max(clamp(16px, 4vw, 40px), env(safe-area-inset-bottom))
    max(clamp(16px, 4vw, 40px), env(safe-area-inset-left));
  overflow: auto;
  background: var(--bg);
  position: relative;
}
```

Board sizing (~1251) gains a dvh fallback line:

```css
.game-surface.is-fullscreen .game-board,
.game-surface:fullscreen .game-board {
  width: min(100%, 520px, calc(100vh - 150px));
  width: min(100%, 520px, calc(100dvh - 150px));
  max-width: 520px;
}
```

New exit-button rules (place near the fullscreen block):

```css
.fullscreen-exit {
  display: none;
}
.game-surface.is-fullscreen .fullscreen-exit,
.game-surface:fullscreen .fullscreen-exit {
  display: inline-flex;
  position: absolute;
  top: max(10px, env(safe-area-inset-top));
  right: max(10px, env(safe-area-inset-right));
  z-index: 1001;
  padding: 8px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg);
  color: var(--ink);
  font: inherit;
}
```

Narrow media query (~1772-1790): wherever `calc(100vh - 16px)` sizes the fullscreen board, add a `calc(100dvh - 16px)` fallback line after it. Check `styles.css:1432` (`max-height: calc(100vh - 40px)`) during implementation — only change if it is fullscreen-related. `position: fixed; inset: 0; z-index: 1000` stays on `.game-surface.is-fullscreen` (pseudo-fullscreen fallback when the Fullscreen API throws).

- [ ] **Step 5: Run, verify PASS** — `npx playwright test -g "fullscreen"` plus the two extended tests; `npm run lint && npm run typecheck`. Note in PR: iPad Safari ≥16.4 needs manual/real-device acceptance (CI is Chromium-only).
- [ ] **Step 6: Commit** `fix: fit fullscreen board on iPad with dvh sizing and safe areas` — push, PR "Closes #16"

---

### Task 4: Issue #12 — auto-jump to match on start

**Files:**
- Modify: `src/pages/student/RoomLobbyPage.tsx` (subscribe WS; keep 2s poll as fallback)
- Test: `tests/e2e/platform.spec.ts` (new test; WS pushed via `page.routeWebSocket`)

- [ ] **Step 1: Branch** `codex/issue-12-auto-join` (from `main` if Task 1 merged, else stacked on it)

- [ ] **Step 2: Write failing e2e test** (after the polling test from Task 1):

```ts
test('room lobby auto-jumps to the match when the room starts', async ({ page }, testInfo) => {
  const locale = projectLocale(testInfo);
  await mockApi(page, 'student', locale);
  const lobbyRoom = (status: RoomStatus) => ({ /* same fixture shape as Task 1, status */ });
  let lobbyStatus: RoomStatus = 'open';
  await page.route('**/api/rooms/room-1', async (route) => {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(lobbyRoom(lobbyStatus)),
    });
  });
  let serverSocket: { send: (data: string) => void } | null = null;
  await page.routeWebSocket('**/api/rooms/*/ws', (socket) => {
    serverSocket = socket;
    socket.onMessage(() => undefined);
  });
  await page.goto('/student/rooms');
  await page.getByRole('button', { name: locale === 'zh-CN' ? '加入房间' : 'Join room' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    locale === 'zh-CN' ? '房间候场' : 'Room lobby',
  );
  await expect.poll(() => serverSocket !== null).toBe(true);
  lobbyStatus = 'countdown';
  const startNotice = {
    type: 'state', roomId: 'room-1', roomStatus: 'countdown', serverTime: Date.now(),
    startsAt: Date.now() + 3000, endsAt: Date.now() + 63_000, game: null, canControl: false,
  };
  serverSocket.send(JSON.stringify(startNotice));
  await expect(page).toHaveURL(/\/student\/rooms\/room-1\/match$/u);
  serverSocket.send(JSON.stringify(startNotice)); // duplicate must not loop
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page).toHaveURL(/\/student\/rooms\/room-1\/match$/u);
});
```

- [ ] **Step 3: Run, verify FAIL** (no WS subscription in lobby; URL never changes without refresh)

- [ ] **Step 4: Implement in `RoomLobbyPage.tsx`** — add imports (`useCallback`, `useRef`, `ServerPlayerState`, `useRoomSocket`), and after the `room` hook:

```tsx
  const jumpedRef = useRef(false);
  const onRoomState = useCallback(
    (message: ServerPlayerState) => {
      if (message.type !== 'state') return;
      if (
        !jumpedRef.current &&
        (message.roomStatus === 'countdown' || message.roomStatus === 'live')
      ) {
        jumpedRef.current = true;
        navigate(`/student/rooms/${id}/match`, { replace: true });
      }
    },
    [id, navigate],
  );
  useRoomSocket<ServerPlayerState>(id, onRoomState);
```

Keep the existing poll-based navigate effect (fallback for WS backoff windows) and the 2000ms interval. Backend needs no change: `start()` already broadcasts `state` (`worker/durable/room-session.ts:315`), and joined students pass the `active_participations` WS guard (`worker/routes/rooms.ts:249-254`).

- [ ] **Step 5: Run, verify PASS**; also rerun Task 1's polling test (no regression); `npm run lint && npm run typecheck`
- [ ] **Step 6: Commit** `feat: auto-join match from lobby when the room starts` — push, PR "Closes #12"

---

### Task 5: Issue #14 — student single-session login

**Files:**
- Modify: `worker/lib/auth.ts` (`createSession` deletes sibling sessions for students; new `closeStudentRoomSockets`)
- Modify: `worker/routes/auth.ts:33` (pass role, trigger kick)
- Modify: `worker/durable/room-session.ts` (new `/kick` endpoint)
- Test: `tests/worker/single-session.test.ts` (new)

- [ ] **Step 1: Branch** `codex/issue-14-single-session`

- [ ] **Step 2: Write failing worker test** `tests/worker/single-session.test.ts` (helpers copied from `tests/worker/realtime.test.ts:10-22, 40-60`):

```ts
import { env, exports, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ServerPlayerState } from '../../shared/types';

const origin = 'https://example.com';
const request = (path: string, init: RequestInit = {}) => exports.default.fetch(`${origin}${path}`, init);
async function login(loginId: string, password: string): Promise<string> {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password, locale: 'zh-CN' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}
async function importStudents(cookie: string) { /* copy realtime.test.ts import validate+commit flow */ }

describe('student single-session login', () => {
  it('new student login invalidates the previous session and closes its room socket', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    await importStudents(teacher); // P001, P002 (grade 6)
    const firstCookie = await login('P001', 'integration-student-password');
    // room setup: create duel room, both join, start, force live (copy realtime.test.ts:62-110)
    // open WS as P001 with firstCookie, await initial state
    const secondCookie = await login('P001', 'integration-student-password');
    // old REST session is dead:
    expect(((await (await request('/api/me', { headers: { Cookie: firstCookie } })).json()) as { user: unknown }).user).toBeNull();
    expect(((await (await request('/api/me', { headers: { Cookie: secondCookie } })).json()) as { user: { loginId: string } }).user).toMatchObject({ loginId: 'P001' });
    // only one P001 session row remains:
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM sessions WHERE user_id = (SELECT id FROM users WHERE login_id = 'P001')`,
    ).first<{ count: number }>();
    expect(count!.count).toBe(1);
    // old live WS is closed by the kick:
    const closedCode = await new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code), { once: true });
      // second login already happened; poll if kick arrives via waitUntil
    });
    expect(closedCode).toBe(4001);
  }, 15_000);

  it('teacher sessions are unlimited', async () => {
    const first = await login('teacher', 'integration-teacher-password');
    const second = await login('teacher', 'integration-teacher-password');
    for (const cookie of [first, second]) {
      expect(((await (await request('/api/me', { headers: { Cookie: cookie } })).json()) as { user: unknown }).user).not.toBeNull();
    }
  });
});
```

(Implementation fills the room-setup + WS-open helpers concretely from `realtime.test.ts`; the close listener must be attached BEFORE the second login to avoid a race.)

- [ ] **Step 3: Run `npm run test:worker -- single-session`, verify FAIL**

- [ ] **Step 4: Implement.** `worker/lib/auth.ts` — change signature and body of `createSession`:

```ts
export async function createSession(
  c: Context<AppHonoEnv>,
  user: { id: string; role: Role },
  credentialVersion: number,
): Promise<void> {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = Date.now();
  const insert = c.env.DB.prepare(
    `INSERT INTO sessions (
       token_hash, user_id, credential_version, created_at, expires_at, last_seen_at
     )
     SELECT ?, id, credential_version, ?, ?, ?
     FROM users
     WHERE id = ? AND credential_version = ?`,
  ).bind(tokenHash, now, now + SESSION_DURATION_SECONDS * 1000, now, user.id, credentialVersion);
  const results =
    user.role === 'student'
      ? await c.env.DB.batch([
          insert,
          c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(
            user.id,
            tokenHash,
          ),
        ])
      : [await insert.run()];
  if (results[0].meta.changes !== 1) {
    throw new AppError(401, 'CREDENTIALS_CHANGED', '密码已变更，请重新登录');
  }
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_DURATION_SECONDS,
  });
}

export async function closeStudentRoomSockets(env: Env, userId: string): Promise<void> {
  const rows = await env.DB.prepare(
    'SELECT room_id FROM active_participations WHERE user_id = ?',
  )
    .bind(userId)
    .all<{ room_id: string }>();
  await Promise.all(
    rows.results.map((row) =>
      env.ROOMS.get(env.ROOMS.idFromName(row.room_id)).fetch('https://room.internal/kick', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Room-Id': row.room_id },
        body: JSON.stringify({ userId }),
      }),
    ),
  );
}
```

`worker/routes/auth.ts:33` — replace call:

```ts
  await createSession(c, { id: row.id, role: row.role }, row.credential_version);
  if (row.role === 'student') {
    c.executionCtx.waitUntil(closeStudentRoomSockets(c.env, row.id));
  }
```

`worker/durable/room-session.ts` — add route in `fetch()` (next to `/cancel`):

```ts
    if (url.pathname === '/kick' && request.method === 'POST') {
      const body = (await request.json()) as { userId: string };
      return this.kickUser(body.userId ?? '');
    }
```

and the method:

```ts
  private async kickUser(userId: string): Promise<Response> {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.role !== 'student' || attachment.userId !== userId) continue;
      const player = this.runtime?.players.find((candidate) => candidate.userId === userId);
      if (player?.controllerSocketId === attachment.socketId) {
        player.controllerSocketId = null;
        await this.persist();
      }
      socket.close(4001, 'Session replaced');
    }
    this.pushTeacherState();
    return Response.json({ ok: true });
  }
```

(`pushTeacherState` is introduced in Task 6; until then inline the same loop that `broadcast()` uses but filter `attachment.role === 'teacher'`.)

- [ ] **Step 5: Run `npm run test:worker`, verify PASS including existing password-change/business tests**; `npm run lint && npm run typecheck`
- [ ] **Step 6: Commit** `feat: enforce single-session login for students` — push, PR "Closes #14" (note: password-change still nukes all sessions — unchanged behavior covered by existing tests)

---

### Task 6: Issue #11 — board-state sync rework

**Files:**
- Modify: `shared/types.ts:173-177` (`PlayerClientMessage` → board upload)
- Modify: `worker/durable/room-session.ts` (accept boards, no per-move student broadcast, ~1s merged teacher push, targeted connect/close sends)
- Modify: `src/pages/student/MatchPage.tsx` (ref-held authoritative local board, upload per move, stale-snapshot guard + one-shot re-upload)
- Test: `tests/worker/realtime.test.ts` (rewrite move flow, add merge/no-downlink/stale/deadline assertions)

- [ ] **Step 1: Branch** `codex/issue-11-board-sync` (stack on `main` after Tasks 4-5 merge if possible)

- [ ] **Step 2: Update worker tests first** (`tests/worker/realtime.test.ts`):
  - Replace `'move'` sends (lines 200-206) with board uploads built from the initial state: `const nextBoard = applyMove(initialPlayerState.game!, validDirection, Date.now()).snapshot;` then `socket.send(JSON.stringify({ type: 'board', game: nextBoard }))`. Controller tab: snapshot `/snapshot` then reflects `seq: 1`.
  - New test 'live match streams boards up only, teacher gets merged snapshots':

```ts
  it('uploads boards without per-move student downlink and merges teacher snapshots', async () => {
    /* setup: import P001/P002, room, join x2, start, force startsAt past, runDurableObjectAlarm → live;
       open student sockets S1(P001, controller), S2(P002), teacher socket T via teacher cookie /api/rooms/:id/ws */
    const s1Messages: ServerPlayerState[] = [];
    S1.addEventListener('message', (e) => s1Messages.push(JSON.parse(String(e.data))));
    const teacherMessages: ServerTeacherState[] = [];
    T.addEventListener('message', (e) => teacherMessages.push(JSON.parse(String(e.data))));
    const base1 = /* P001 initial game from snapshot */;
    for (let i = 0; i < 3; i += 1) {
      const dir = (['up','down','left','right'] as const).find((d) => projectMove(game1.board, d).moved)!;
      game1 = applyMove(game1, dir, Date.now()).snapshot;
      S1.send(JSON.stringify({ type: 'board', game: game1 }));
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(s1Messages.filter((m) => m.type === 'state' && m.game)).toHaveLength(0); // no ACK/board downlink
    // merged teacher push fires via alarm, exactly one snapshot with latest seq:
    const teacherBefore = teacherMessages.length;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    const added = teacherMessages.slice(teacherBefore).filter((m) => m.type === 'teacher-snapshot');
    expect(added.length).toBeLessThanOrEqual(1);
    expect(added[added.length - 1]?.players.find((p) => /* P001 */)?.game.seq).toBe(game1.seq);
    // stale board (older seq) is ignored:
    S1.send(JSON.stringify({ type: 'board', game: { ...game1, seq: 1 } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(((await (await stub.fetch('https://room.internal/snapshot', { headers: snapshotHeaders })).json()) as ServerPlayerState).game?.seq).toBe(game1.seq);
    // deadline settle uses last accepted board:
    /* force endsAt past + alarm; assert match_players score = game1.score, status ended */
  }, 15_000);
```

- [ ] **Step 3: Run `npm run test:worker -- realtime`, verify FAIL**

- [ ] **Step 4: Implement protocol** — `shared/types.ts`:

```ts
export type PlayerClientMessage = {
  type: 'board';
  game: GameSnapshot;
};
```

(`directions` stays exported; DO's `directions` import is removed.)

- [ ] **Step 5: Implement DO** (`worker/durable/room-session.ts`):

Validation helper (top of file):

```ts
function isValidClientBoard(value: unknown): value is GameSnapshot {
  if (!value || typeof value !== 'object') return false;
  const game = value as Partial<GameSnapshot>;
  return (
    Array.isArray(game.board) &&
    game.board.length === 16 &&
    game.board.every((tile) => Number.isInteger(tile) && tile >= 0) &&
    Number.isInteger(game.score) &&
    game.score >= 0 &&
    Number.isInteger(game.maxTile) &&
    game.maxTile >= 0 &&
    Number.isFinite(game.maxTileReachedAt) &&
    Number.isInteger(game.moveCount) &&
    game.moveCount >= 0 &&
    Number.isInteger(game.rngState) &&
    Number.isInteger(game.seq) &&
    game.seq >= 0 &&
    (game.status === 'playing' || game.status === 'over')
  );
}
```

New state + methods:

```ts
  private teacherDirty = false;

  private hasTeacherSocket(): boolean {
    return this.ctx
      .getWebSockets()
      .some((socket) => (socket.deserializeAttachment() as SocketAttachment | null)?.role === 'teacher');
  }

  private pushTeacherState(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.role === 'teacher') this.sendState(socket, attachment);
    }
  }

  private async scheduleTeacherSnapshot(): Promise<void> {
    if (!this.hasTeacherSocket()) return;
    this.teacherDirty = true;
    const target = Date.now() + 1000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }
```

`webSocketMessage` body after the controller check becomes:

```ts
    if (parsed.type !== 'board' || !isValidClientBoard(parsed.game)) {
      this.sendState(socket, attachment);
      return;
    }
    if (parsed.game.seq < player.game.seq) return; // stale out-of-order upload
    player.game = parsed.game;
    await this.persist();
    if (this.runtime.players.every((candidate) => candidate.game.status === 'over')) {
      await this.settle('all_game_over', Date.now());
      return;
    }
    await this.scheduleTeacherSnapshot();
```

`alarm()`:

```ts
  async alarm(): Promise<void> {
    await this.advanceClock(Date.now());
    if (this.runtime?.status === 'live' && this.teacherDirty) {
      this.teacherDirty = false;
      this.pushTeacherState();
    }
  }
```

`connectWebSocket`: replace final `this.broadcast()` with `this.sendState(socket, attachment); if (attachment.role === 'student') this.pushTeacherState();`
`webSocketClose`: replace final `this.broadcast()` with `this.pushTeacherState();`
`advanceClock` / `settle` / `start` / `cancel` keep full `broadcast()` (lifecycle → lobby #12 relies on it; settle is the immediate final push).

- [ ] **Step 6: Implement client** (`src/pages/student/MatchPage.tsx`):

```tsx
  const [liveState, setLiveState] = useState<ServerPlayerState | null>(null);
  const liveStateRef = useRef<ServerPlayerState | null>(null);
  const resyncNeeded = useRef(false);
  const now = useNow();
  const state = liveState ?? initial.data;

  const onState = useCallback((next: ServerPlayerState) => {
    const current = liveStateRef.current;
    const stale =
      current?.roomStatus === 'live' &&
      next.roomStatus === 'live' &&
      current.canControl &&
      next.canControl &&
      next.game !== null &&
      current.game !== null &&
      next.game.seq < current.game.seq;
    if (stale) {
      resyncNeeded.current = true; // server missed our newer board (e.g. after reconnect)
      return;
    }
    liveStateRef.current = next;
    setLiveState(next);
  }, []);

  const socket = useRoomSocket<ServerPlayerState>(id, onState);

  useEffect(() => {
    if (initial.data && !liveStateRef.current) liveStateRef.current = initial.data;
  }, [initial.data]);

  useEffect(() => {
    const latest = liveStateRef.current;
    if (!resyncNeeded.current || !socket.connected || !latest?.game) return;
    resyncNeeded.current = false;
    socket.send({ type: 'board', game: latest.game });
  }, [socket, socket.connected, liveState]);

  const move = useCallback(
    (direction: Direction) => {
      const current = liveStateRef.current;
      if (!current?.game || current.roomStatus !== 'live' || !current.canControl) return;
      if (current.game.status === 'over') return;
      const predicted = applyMove(current.game, direction, Date.now()).snapshot;
      const next = { ...current, game: predicted };
      liveStateRef.current = next;
      setLiveState(next);
      socket.send({ type: 'board', game: predicted });
    },
    [socket],
  );
```

(add `useEffect`, `useRef` imports; remove the old `seq`-send code; `disabled` prop and render body unchanged).

- [ ] **Step 7: Run all gates** — `npm run test:worker -- realtime`, `npm test`, `npx playwright test` (match/return tests unchanged: mocked WS ignores messages), `npm run lint && npm run typecheck`
- [ ] **Step 8: Commit** `feat: board-state sync with merged teacher snapshots` — push, PR "Closes #11", body documents: trust-model change (client-asserted boards/scores, deadline-enforced only; diverges from issue's original replay-verification text per user decision 2026-09-09), stale-upload guard via seq, legacy `move` senders get a one-time state correction (clients should refresh).

---

## Self-Review (done at planning time)

- Spec coverage: #10 ✓(Task1) #15 ✓(Task2) #16 ✓(Task3, real-device caveat noted) #12 ✓(Task4) #14 ✓(Task5, students only + WS kick) #11 ✓(Task6, simplified model)
- Cross-task type consistency: `PlayerClientMessage` change in Task 6 is the only protocol break; Tasks 1-5 do not send moves from pages except `MatchPage` (untouched until Task 6). Task 5's `pushTeacherState` forward-reference resolved by inline filter fallback.
- Execution order matters: Task 4 e2e reuses Task 1's fixture pattern; Task 6 rewrites the same DO file as Task 5 — run sequentially, rebase/stack when predecessors are unmerged.
