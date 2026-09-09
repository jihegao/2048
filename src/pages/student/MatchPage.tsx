import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import type { Direction, ServerPlayerState } from '../../../shared/types';
import { applyMove } from '../../../shared/game';
import { GameBoard } from '../../components/GameBoard';
import { GameStatusBar } from '../../components/GameStatusBar';
import { Alert, Card, LoadingBlock, PageHeader } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { useFullscreen } from '../../hooks/useFullscreen';
import { useNow } from '../../hooks/useNow';
import { useRoomSocket } from '../../hooks/useRoomSocket';
import { currentLocale } from '../../i18n';
import { formatClock, formatNumber } from '../../lib/format';

interface PendingMove {
  seq: number;
  direction: Direction;
}

export function MatchPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const initial = useApiData<ServerPlayerState>(id ? `/api/rooms/${id}/match` : null);
  const [liveState, setLiveState] = useState<ServerPlayerState | null>(null);
  const [resendTick, setResendTick] = useState(0);
  const liveStateRef = useRef<ServerPlayerState | null>(null);
  const pendingMoves = useRef<PendingMove[]>([]);
  const resendNeeded = useRef(false);
  const now = useNow();
  const state = liveState ?? initial.data;

  const onState = useCallback((next: ServerPlayerState) => {
    if (next.roomStatus !== 'live' || !next.canControl || !next.game) {
      pendingMoves.current = [];
      resendNeeded.current = false;
      liveStateRef.current = next;
      setLiveState(next);
      return;
    }

    pendingMoves.current = pendingMoves.current.filter((move) => move.seq > next.game!.seq);
    let game = next.game;
    const replayable: PendingMove[] = [];
    for (const pending of pendingMoves.current) {
      if (pending.seq !== game.seq + 1) break;
      const result = applyMove(game, pending.direction, Date.now());
      if (!result.moved) break;
      game = result.snapshot;
      replayable.push(pending);
    }
    pendingMoves.current = replayable;
    const reconciled = { ...next, game };
    liveStateRef.current = reconciled;
    setLiveState(reconciled);
    if (replayable.length > 0) {
      resendNeeded.current = true;
      setResendTick((tick) => tick + 1);
    }
  }, []);

  const socket = useRoomSocket<ServerPlayerState>(id, onState);

  useEffect(() => {
    if (initial.data && !liveStateRef.current) liveStateRef.current = initial.data;
  }, [initial.data]);

  useEffect(() => {
    if (!resendNeeded.current) return;
    resendNeeded.current = false;
    for (const pending of pendingMoves.current) {
      if (!socket.send({ type: 'move', seq: pending.seq, direction: pending.direction })) {
        resendNeeded.current = true;
        break;
      }
    }
  }, [socket, resendTick]);

  const move = useCallback(
    (direction: Direction) => {
      const current = liveStateRef.current;
      if (!current?.game || current.roomStatus !== 'live' || !current.canControl) return;
      if (current.game.status === 'over') return;
      const result = applyMove(current.game, direction, Date.now());
      if (!result.moved) return;
      const predicted = result.snapshot;
      pendingMoves.current.push({ seq: predicted.seq, direction });
      const next = { ...current, game: predicted };
      liveStateRef.current = next;
      setLiveState(next);
      socket.send({ type: 'move', seq: predicted.seq, direction });
    },
    [socket],
  );
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
  const disabled = state.roomStatus !== 'live' || !state.canControl || state.game.status === 'over';

  return (
    <>
      <PageHeader
        title={t('match.title')}
        actions={
          <div className="button-group">
            <Link className="button button--ghost" to="/student/rooms">
              {t('rooms.backToRooms')}
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
      {!socket.connected ? <Alert message={t('match.connectionLost')} tone="info" /> : null}
      {socket.connected && !state.canControl ? (
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
            <small className="authority-hint">{t('match.serverAuthoritative')}</small>
          </Card>
        </div>
      </div>
    </>
  );
}
