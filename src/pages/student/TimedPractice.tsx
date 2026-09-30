import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Direction } from '../../../shared/types';
import { TimedPracticeSync, type TimedView } from '../../lib/timed-practice-sync';
import { GameBoard } from '../../components/GameBoard';
import { GameStatusBar } from '../../components/GameStatusBar';
import { Alert, Card, LoadingBlock } from '../../components/ui';
import { currentLocale } from '../../i18n';
import { api } from '../../lib/api';
import { formatClock, formatNumber } from '../../lib/format';

export function TimedPractice() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [view, setView] = useState<TimedView>({
    loading: true,
    session: null,
    result: null,
    error: '',
    pendingCount: 0,
    remainingMs: 0,
    disabled: true,
  });
  const sync = useRef<TimedPracticeSync | null>(null);

  useEffect(() => {
    const client = new TimedPracticeSync(api, setView);
    sync.current = client;
    void client.start();
    const flush = () => void client.flush();
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      client.dispose();
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, []);

  const move = useCallback((direction: Direction) => sync.current?.move(direction), []);
  const start = () => sync.current?.start();
  const { session, result, loading, error } = view;
  const remaining = view.remainingMs;
  const notice = result
    ? t('practice.timedSaved')
    : error === 'sync_retry'
      ? t('practice.timedSyncRetry')
      : error;
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
              <GameBoard game={game} onMove={move} disabled={view.disabled} />
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
