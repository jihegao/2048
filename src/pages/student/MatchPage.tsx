import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import type { Direction, ServerPlayerState, ServerScoreSummary } from '../../../shared/types';
import { useAuth } from '../../auth/AuthContext';
import { GameBoard } from '../../components/GameBoard';
import { GameStatusBar } from '../../components/GameStatusBar';
import { Alert, Card, LoadingBlock, PageHeader } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { useFullscreen } from '../../hooks/useFullscreen';
import { useRoomSocket } from '../../hooks/useRoomSocket';
import { currentLocale } from '../../i18n';
import { formatClock, formatNumber } from '../../lib/format';
import { MatchSync } from '../../lib/match-sync';

export function MatchPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { user } = useAuth();
  const initial = useApiData<ServerPlayerState>(id ? `/api/rooms/${id}/match` : null);
  const sync = useMemo(() => {
    let storage: Storage | undefined;
    try {
      storage = window.sessionStorage;
    } catch {
      /* play also works when browser storage is disabled */
    }
    return new MatchSync(storage, `match:${user?.id}:${id}`);
  }, [id, user?.id]);
  const [, refresh] = useState(0);
  const redraw = useCallback(() => refresh((tick) => tick + 1), []);
  const onState = useCallback(
    (next: ServerPlayerState | ServerScoreSummary) => {
      sync.accept(next);
      redraw();
    },
    [sync, redraw],
  );

  const { connected, send, reconnect } = useRoomSocket<ServerPlayerState | ServerScoreSummary>(
    id,
    onState,
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!initial.data || cancelled) return;
      sync.accept(initial.data, false);
      redraw();
    });
    return () => {
      cancelled = true;
    };
  }, [initial.data, sync, redraw]);

  useEffect(() => {
    let cancelled = false;
    const flush = () => {
      if (cancelled) return;
      const message = sync.progress();
      if (message) {
        if (connected && sync.reconnectNeeded()) reconnect();
        else if (send(message)) sync.sent();
      }
      redraw();
    };
    queueMicrotask(flush);
    const timer = window.setInterval(flush, 1000);
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [sync, connected, send, reconnect, redraw]);

  const move = useCallback(
    (direction: Direction) => {
      if (!sync.move(direction)) return;
      const message = sync.progress();
      if (message && send(message)) sync.sent();
      redraw();
    },
    [send, sync, redraw],
  );
  const state = sync.state ?? initial.data;
  const now = sync.now;
  const locale = currentLocale();
  const { ref: fullscreenRef, isFullscreen, toggle: toggleFullscreen } = useFullscreen();

  if (initial.loading && !state) return <LoadingBlock />;
  if (initial.error && !state) return <Alert message={initial.error} />;
  if (!state?.game) return <Alert message={t('match.notParticipant')} />;

  const beforeStart = state.roomStatus === 'countdown' && state.startsAt;
  const countdownSeconds = beforeStart ? Math.max(0, Math.ceil((state.startsAt! - now) / 1000)) : 0;
  const countdownMs = beforeStart ? Math.max(0, state.startsAt! - now) : 0;
  const remaining = state.endsAt ? Math.max(0, state.endsAt - now) : 0;
  const clockTone =
    state.roomStatus === 'countdown'
      ? 'countdown'
      : state.roomStatus === 'live' && remaining <= 60_000
        ? 'warning'
        : state.roomStatus === 'live'
          ? 'live'
          : state.roomStatus === 'ended'
            ? 'ended'
            : 'idle';
  const clockLabel =
    state.roomStatus === 'countdown'
      ? t('match.startsInLabel')
      : state.roomStatus === 'live'
        ? t('match.remaining')
        : t('match.ended');
  const clockValue =
    state.roomStatus === 'countdown'
      ? formatClock(countdownMs)
      : state.roomStatus === 'live' || state.roomStatus === 'ended'
        ? formatClock(remaining)
        : '—';
  const clockStatus =
    state.roomStatus === 'countdown'
      ? t('match.countdown', { seconds: countdownSeconds })
      : state.roomStatus === 'live'
        ? t('match.inProgress')
        : state.roomStatus === 'ended'
          ? t('match.ended')
          : t('match.waiting');
  const disabled = sync.disabled;
  const scores = state.scores;
  const ownTotal = scores
    ? scores.sideScores[scores.side] - scores.ownScore + state.game.score
    : undefined;
  const opposingTotal = scores?.sideScores[scores.side === 1 ? 2 : 1];
  const isTeam = scores?.mode === 'team_3v3';

  return (
    <>
      <PageHeader
        title={t('match.title')}
        actions={
          <div className="button-group">
            <Link className="button button--ghost" to="/student">
              {t('rooms.backToHome')}
            </Link>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void toggleFullscreen()}
            >
              {isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
            </button>
          </div>
        }
      />
      {!connected ? <Alert message={t('match.connectionLost')} tone="info" /> : null}
      {sync.final ? (
        <Alert
          message={t(
            sync.finalAcknowledged
              ? state.settled
                ? 'match.scoreSettled'
                : 'match.scoreSubmitted'
              : sync.uploadExpired
                ? 'match.scoreUploadExpired'
                : 'match.scoreUploading',
          )}
          tone={sync.uploadExpired ? 'error' : 'info'}
        />
      ) : null}
      {connected && !state.canControl ? (
        <Alert message={t('match.observerTab')} tone="info" />
      ) : null}
      <div ref={fullscreenRef} className={`game-surface ${isFullscreen ? 'is-fullscreen' : ''}`}>
        <div className="fullscreen-bar">
          <button type="button" className="fullscreen-exit" onClick={() => void toggleFullscreen()}>
            {t('common.exitFullscreen')}
          </button>
        </div>
        <GameStatusBar
          score={formatNumber(state.game.score, locale)}
          scoreLabel={t('common.score')}
          time={clockValue}
          timeLabel={clockLabel}
          timeTone={clockTone}
        />
        <div className="match-scores" role="group" aria-label={t('match.liveScores')}>
          <div className="match-scores__side">
            <span>{t(isTeam ? 'match.myTeamScore' : 'match.myScore')}</span>
            <strong>{ownTotal === undefined ? '—' : formatNumber(ownTotal, locale)}</strong>
          </div>
          <span className="match-scores__separator" aria-hidden="true">
            :
          </span>
          <div className="match-scores__side">
            <span>{t(isTeam ? 'match.opposingTeamScore' : 'match.opponentScore')}</span>
            <strong>
              {opposingTotal === undefined ? '—' : formatNumber(opposingTotal, locale)}
            </strong>
          </div>
          {isTeam ? (
            <small className="match-scores__personal">
              {t('match.myScore')}: {formatNumber(state.game.score, locale)}
            </small>
          ) : null}
        </div>
        <div className="match-layout match-layout--student">
          <div
            className={`match-clock match-clock--${clockTone}`}
            role="timer"
            aria-label={`${clockStatus} ${clockLabel} ${clockValue}`}
          >
            <strong>{clockValue}</strong>
          </div>
          <Card className="match-panel">
            <div className="score-strip">
              <div>
                <span>{t('common.score')}</span>
                <strong>{formatNumber(state.game.score, locale)}</strong>
              </div>
              <div>
                <span>{t('common.maxTile')}</span>
                <strong>{formatNumber(state.game.maxTile, locale)}</strong>
              </div>
            </div>
            <GameBoard game={state.game} onMove={move} disabled={disabled} />
            <p className="input-hint">
              {window.matchMedia('(pointer: coarse)').matches
                ? t('practice.touchHint')
                : t('practice.keyboardHint')}
            </p>
            <small className="authority-hint">{t('match.localAuthoritative')}</small>
          </Card>
        </div>
      </div>
    </>
  );
}
