import { Hono } from 'hono';
import { ENGINE_VERSION, replayGame } from '../../shared/game';
import type { AppHonoEnv } from '../app-types';
import { signJson, verifySignedJson } from '../lib/crypto';
import { uuid } from '../lib/db';
import { secret } from '../lib/env';
import { AppError, zodIssues } from '../lib/errors';
import { practiceCompleteSchema } from '../schemas';

interface PracticeChallenge {
  challengeId: string;
  userId: string;
  seed: number;
  startedAt: number;
  expiresAt: number;
  engineVersion: string;
}

export const practiceRoutes = new Hono<AppHonoEnv>();

practiceRoutes.post('/start', async (c) => {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const challenge: PracticeChallenge = {
    challengeId: uuid(),
    userId: c.get('user').id,
    seed: random[0] || 1,
    startedAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    engineVersion: ENGINE_VERSION,
  };
  return c.json({
    challenge: await signJson(challenge, secret(c.env, 'PRACTICE_SIGNING_KEY')),
    seed: challenge.seed,
    startedAt: new Date(challenge.startedAt).toISOString(),
    engineVersion: challenge.engineVersion,
  });
});

practiceRoutes.post('/complete', async (c) => {
  const parsed = practiceCompleteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new AppError(422, 'VALIDATION_ERROR', '练习结果格式无效', zodIssues(parsed.error.issues));
  const challenge = await verifySignedJson<PracticeChallenge>(
    parsed.data.challenge,
    secret(c.env, 'PRACTICE_SIGNING_KEY'),
  );
  if (
    !challenge ||
    challenge.userId !== c.get('user').id ||
    challenge.engineVersion !== ENGINE_VERSION ||
    challenge.expiresAt < Date.now()
  ) {
    throw new AppError(409, 'PRACTICE_CHALLENGE_INVALID', '练习凭据无效或已过期');
  }
  const snapshot = replayGame(challenge.seed, parsed.data.moves, challenge.startedAt);
  if (snapshot.status !== 'over') {
    throw new AppError(422, 'PRACTICE_NOT_FINISHED', '练习尚未正常结束，不会保存成绩');
  }
  const endedAt = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO practice_results (
         id, challenge_id, user_id, engine_version, score, max_tile, valid_move_count,
         final_board_json, started_at, ended_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        uuid(),
        challenge.challengeId,
        challenge.userId,
        ENGINE_VERSION,
        snapshot.score,
        snapshot.maxTile,
        snapshot.moveCount,
        JSON.stringify(snapshot.board),
        challenge.startedAt,
        endedAt,
      )
      .run();
  } catch {
    throw new AppError(409, 'PRACTICE_ALREADY_SAVED', '这局练习成绩已经保存');
  }
  return c.json({
    ok: true,
    result: {
      score: snapshot.score,
      maxTile: snapshot.maxTile,
      validMoveCount: snapshot.moveCount,
      endedAt: new Date(endedAt).toISOString(),
    },
    message: '练习成绩已保存',
  });
});
