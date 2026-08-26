import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { applyMove, createGame } from '../../../shared/game';
import type { Direction, GameSnapshot } from '../../../shared/types';
import { GameBoard } from '../../components/GameBoard';
import { Alert, Card, LoadingBlock, PageHeader } from '../../components/ui';
import { currentLocale } from '../../i18n';
import { api } from '../../lib/api';
import { formatNumber } from '../../lib/format';

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
  const [moves, setMoves] = useState<Direction[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const completed = useRef(new Set<string>());

  const start = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    setSaving(false);
    try {
      const response = await api<PracticeStart>('/api/practice/start', { method: 'POST' });
      setChallenge(response.challenge);
      setGame(createGame(response.seed, Date.parse(response.startedAt)));
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
      if (next.status === 'over') void complete(challenge, nextMoves);
    },
    [challenge, complete, game, moves, saving],
  );

  return (
    <>
      <PageHeader
        title={t('practice.title')}
        subtitle={t('practice.subtitle')}
        actions={
          <button type="button" className="button button--ghost" onClick={() => void start()}>
            {t('practice.newGame')}
          </button>
        }
      />
      {notice ? <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} /> : null}
      {loading || !game ? (
        <LoadingBlock />
      ) : (
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
            <GameBoard game={game} onMove={move} disabled={saving || game.status === 'over'} />
            <p className="input-hint">
              {navigator.maxTouchPoints > 0 ? t('practice.touchHint') : t('practice.keyboardHint')}
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
      )}
    </>
  );
}
