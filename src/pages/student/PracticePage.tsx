import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyMove, createGame } from '../../../shared/game';
import type { Direction, GameSnapshot } from '../../../shared/types';
import { GameBoard } from '../../components/GameBoard';
import { GameStatusBar } from '../../components/GameStatusBar';
import { Alert, Card, LoadingBlock, PageHeader } from '../../components/ui';
import { currentLocale } from '../../i18n';
import { useNow } from '../../hooks/useNow';
import { useFullscreen } from '../../hooks/useFullscreen';
import { api } from '../../lib/api';
import { formatClock, formatNumber } from '../../lib/format';

interface PracticeStart {
  challenge: string;
  seed: number;
  startedAt: string;
  engineVersion: string;
}

export function PracticePage() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [challenge, setChallenge] = useState('');
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [moves, setMoves] = useState<Direction[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const completed = useRef(new Set<string>());
  const now = useNow(1000);
  const { ref: fullscreenRef, isFullscreen, toggle: toggleFullscreen } = useFullscreen();

  const start = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    setSaving(false);
    try {
      const response = await api<PracticeStart>('/api/practice/start', { method: 'POST' });
      const parsedStartTime = Date.parse(response.startedAt);
      const startTime = Number.isFinite(parsedStartTime) ? parsedStartTime : Date.now();
      setChallenge(response.challenge);
      setGame(createGame(response.seed, startTime));
      setStartedAt(startTime);
      setEndedAt(null);
      setMoves([]);
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void start());
  }, [start]);

  const complete = useCallback(async (token: string, replayMoves: Direction[]) => {
    if (completed.current.has(token)) return;
    completed.current.add(token);
    setSaving(true);
    try {
      const response = await api<{ message: string }>('/api/practice/complete', {
        method: 'POST',
        body: JSON.stringify({ challenge: token, moves: replayMoves }),
      });
      setNotice({ message: response.message, error: false });
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setSaving(false);
    }
  }, []);

  const move = useCallback(
    (direction: Direction) => {
      if (!game || game.status === 'over' || saving) return;
      const nextMoves = [...moves, direction];
      const next = applyMove(game, direction, Date.now()).snapshot;
      setMoves(nextMoves);
      setGame(next);
      if (next.status === 'over') {
        setEndedAt(Date.now());
        void complete(challenge, nextMoves);
      }
    },
    [challenge, complete, game, moves, saving],
  );

  const elapsedMs = startedAt ? Math.max(0, (endedAt ?? now) - startedAt) : 0;

  return (
    <>
      <PageHeader
        title={t('practice.title')}
        subtitle={t('practice.subtitle')}
        actions={
          <div className="button-group">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void toggleFullscreen()}
            >
              {isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
            </button>
            <button type="button" className="button button--ghost" onClick={() => void start()}>
              {t('practice.newGame')}
            </button>
          </div>
        }
      />
      {notice ? <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} /> : null}
      {loading || !game ? (
        <LoadingBlock />
      ) : (
        <div ref={fullscreenRef} className={`game-surface ${isFullscreen ? 'is-fullscreen' : ''}`}>
          <GameStatusBar
            score={formatNumber(game.score, locale)}
            scoreLabel={t('common.score')}
            time={formatClock(elapsedMs)}
            timeLabel={t('practice.elapsedTime')}
            timeTone={game.status === 'over' ? 'ended' : 'live'}
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
                className={`practice-clock ${game.status === 'over' ? 'practice-clock--ended' : ''}`}
                role="timer"
                aria-label={`${t('practice.elapsedTime')} ${formatClock(elapsedMs)}`}
              >
                <strong>{formatClock(elapsedMs)}</strong>
              </div>
              <GameBoard game={game} onMove={move} disabled={saving || game.status === 'over'} />
              <p className="input-hint">
                {navigator.maxTouchPoints > 0
                  ? t('practice.touchHint')
                  : t('practice.keyboardHint')}
              </p>
              <small className="authority-hint">
                {saving
                  ? t('practice.saving')
                  : game.status === 'over'
                    ? t('practice.gameOver')
                    : t('practice.notSavedHint')}
              </small>
              {game.status === 'over' ? (
                <button
                  type="button"
                  className="button button--primary button--full"
                  onClick={() => void start()}
                >
                  {t('practice.playAgain')}
                </button>
              ) : null}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
