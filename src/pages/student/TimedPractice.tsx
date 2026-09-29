import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Direction, GameSnapshot } from '../../../shared/types';
import { GameBoard } from '../../components/GameBoard';
import { GameStatusBar } from '../../components/GameStatusBar';
import { Alert, Card, LoadingBlock } from '../../components/ui';
import { useNow } from '../../hooks/useNow';
import { currentLocale } from '../../i18n';
import { api } from '../../lib/api';
import { formatClock, formatNumber } from '../../lib/format';

interface TimedSession {
  id: string;
  seed: number;
  seq: number;
  snapshot: GameSnapshot;
  startedAt: string;
  deadlineAt: string;
  serverNow: string;
}

interface TimedResult {
  id: string;
  score: number;
  maxTile: number;
  validMoveCount: number;
  finalBoard: number[];
  endedAt: string;
  endReason: 'time_limit' | 'game_over';
}

type TimedResponse =
  | { status: 'none' }
  | { status: 'active'; session: TimedSession }
  | { status: 'settled'; result: TimedResult };

export function TimedPractice() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [session, setSession] = useState<TimedSession | null>(null);
  const [result, setResult] = useState<TimedResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(false);
  const [notice, setNotice] = useState('');
  const [serverOffset, setServerOffset] = useState(0);
  const now = useNow(250);
  const finishing = useRef(false);

  const accept = useCallback(
    (response: TimedResponse) => {
      if (response.status === 'active') {
        setServerOffset(Date.parse(response.session.serverNow) - Date.now());
        setSession(response.session);
        setResult(null);
        finishing.current = false;
      } else if (response.status === 'settled') {
        setResult(response.result);
        setSession(null);
        setNotice(t('practice.timedSaved'));
        finishing.current = false;
      }
    },
    [t],
  );

  const start = useCallback(async () => {
    setLoading(true);
    setNotice('');
    try {
      const current = await api<TimedResponse>('/api/practice/timed/current');
      accept(
        current.status === 'none'
          ? await api<TimedResponse>('/api/practice/timed/start', { method: 'POST' })
          : current,
      );
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    queueMicrotask(() => void start());
  }, [start]);

  const deadline = session ? Date.parse(session.deadlineAt) : 0;
  const remaining = Math.max(0, deadline - now - serverOffset);

  useEffect(() => {
    if (!session || remaining > 0 || finishing.current || moving) return;
    finishing.current = true;
    void api<TimedResponse>('/api/practice/timed/finish', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id }),
    })
      .then(accept)
      .catch((reason) => {
        setNotice(reason instanceof Error ? reason.message : String(reason));
        finishing.current = false;
      });
  }, [session, remaining, moving, accept]);

  const move = useCallback(
    async (direction: Direction) => {
      if (!session || moving || remaining <= 0) return;
      setMoving(true);
      try {
        const response = await api<TimedResponse>('/api/practice/timed/move', {
          method: 'POST',
          body: JSON.stringify({ sessionId: session.id, seq: session.seq + 1, direction }),
        });
        accept(response);
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : String(reason));
        // Reconcile before accepting another operation after an uncertain response.
        try {
          accept(await api<TimedResponse>('/api/practice/timed/current'));
        } catch {
          /* retry via Refresh */
        }
      } finally {
        setMoving(false);
      }
    },
    [session, moving, remaining, accept],
  );

  const game = session?.snapshot;
  return (
    <>
      {notice ? <Alert message={notice} tone={result ? 'success' : 'error'} /> : null}
      {loading ? (
        <LoadingBlock />
      ) : result ? (
        <Card className="match-panel">
          <h2>{t('practice.timedFinished')}</h2>
          <p>
            {t(
              result.endReason === 'game_over' ? 'practice.timedGameOver' : 'practice.timedExpired',
            )}
          </p>
          <div className="score-strip">
            <div>
              <span>{t('common.score')}</span>
              <strong>{formatNumber(result.score, locale)}</strong>
            </div>
            <div>
              <span>{t('common.maxTile')}</span>
              <strong>{formatNumber(result.maxTile, locale)}</strong>
            </div>
          </div>
          <button type="button" className="button button--primary" onClick={() => void start()}>
            {t('practice.playAgain')}
          </button>
        </Card>
      ) : game ? (
        <div className="game-surface">
          <GameStatusBar
            score={formatNumber(game.score, locale)}
            scoreLabel={t('common.score')}
            time={formatClock(remaining)}
            timeLabel={t('practice.timeRemaining')}
            timeTone={remaining > 0 ? 'live' : 'ended'}
          />
          <div className="match-layout match-layout--student">
            <Card className="match-panel">
              <div className="score-strip">
                <div>
                  <span>{t('common.score')}</span>
                  <strong>{formatNumber(game.score, locale)}</strong>
                </div>
                <div>
                  <span>{t('common.maxTile')}</span>
                  <strong>{formatNumber(game.maxTile, locale)}</strong>
                </div>
              </div>
              <div
                className={`practice-clock ${remaining <= 0 ? 'practice-clock--ended' : ''}`}
                role="timer"
                aria-label={`${t('practice.timeRemaining')} ${formatClock(remaining)}`}
              >
                <strong>{formatClock(remaining)}</strong>
              </div>
              <GameBoard
                game={game}
                onMove={(direction) => void move(direction)}
                disabled={moving || remaining <= 0 || game.status === 'over'}
              />
              <small className="authority-hint">{t('practice.timedHint')}</small>
            </Card>
          </div>
        </div>
      ) : (
        <button type="button" className="button button--primary" onClick={() => void start()}>
          {t('leaderboard.retry')}
        </button>
      )}
    </>
  );
}
