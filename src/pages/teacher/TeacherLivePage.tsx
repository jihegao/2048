import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import {
  teamLogoGlyph,
  type ServerTeacherState,
  type TeacherPlayerState,
} from '../../../shared/types';
import { GameBoard } from '../../components/GameBoard';
import { Alert, Card, LoadingBlock, Modal, PageHeader, StatusBadge } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { useNow } from '../../hooks/useNow';
import { useRoomSocket } from '../../hooks/useRoomSocket';
import { currentLocale } from '../../i18n';
import { formatClock, formatNumber } from '../../lib/format';

// A shared monotonic scale keeps each pillar from shrinking as its score rises.
export function scorePillarHeight(score: number): number {
  return score <= 0 ? 0 : Math.sqrt(score / (score + 4096)) * 100;
}

export function TeacherLivePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const initial = useApiData<ServerTeacherState>(id ? `/api/teacher/rooms/${id}/live` : null);
  const [liveState, setLiveState] = useState<ServerTeacherState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const state =
    liveState && (!initial.data || (liveState.revision ?? 0) >= (initial.data.revision ?? 0))
      ? liveState
      : initial.data;
  const now = useNow();
  const locale = currentLocale();
  const onState = useCallback((next: ServerTeacherState) => {
    setLiveState((current) =>
      current && (next.revision ?? 0) < (current.revision ?? 0) ? current : next,
    );
  }, []);
  const socket = useRoomSocket<ServerTeacherState>(id, onState);

  if (initial.loading && !state) return <LoadingBlock />;
  if (initial.error && !state) return <Alert message={initial.error} />;
  if (!state) return <Alert message={t('rooms.notStarted')} />;

  const remaining = state.endsAt ? Math.max(0, state.endsAt - now) : 0;
  const sidePlayers = (side: 1 | 2) => state.players.filter((player) => player.side === side);
  const sideTotal = (side: 1 | 2) =>
    sidePlayers(side).reduce((total, player) => total + player.game.score, 0);
  const isTeam = state.players.length === 6;
  const selected = state.players.find((player) => player.userId === selectedId) ?? null;

  const playerCard = (player: TeacherPlayerState) => (
    <article className="live-player card" key={player.userId}>
      <header>
        <div>
          <strong>{player.name}</strong>
          <small>{player.teamName ?? player.className}</small>
        </div>
        <span className={`presence ${player.online ? 'is-online' : ''}`}>
          {t(player.online ? 'common.online' : 'common.offline')}
        </span>
      </header>
      <button
        type="button"
        className="board-button"
        aria-label={`${t('rooms.enlargeBoard')} ${player.name}`}
        onClick={() => setSelectedId(player.userId)}
      >
        <GameBoard game={player.game} compact disabled />
      </button>
      <footer>
        <span>
          {t('common.score')} <strong>{formatNumber(player.game.score, locale)}</strong>
        </span>
        <span>
          {t('common.maxTile')} <strong>{formatNumber(player.game.maxTile, locale)}</strong>
        </span>
      </footer>
    </article>
  );

  const pillar = (side: 1 | 2) => {
    const players = sidePlayers(side);
    const total = sideTotal(side);
    const name = players[0]?.teamName ?? t(side === 1 ? 'rooms.sideA' : 'rooms.sideB');
    const logo = players[0]?.teamLogo;
    return (
      <aside className={`live-pillar live-pillar--${side}`} aria-label={name}>
        <span className="live-pillar__badge" aria-hidden="true">
          {logo ? teamLogoGlyph(logo) : side === 1 ? 'A' : 'B'}
        </span>
        <strong className="live-pillar__name">{name}</strong>
        <span className="live-pillar__score" aria-label={`${name} ${formatNumber(total, locale)}`}>
          {formatNumber(total, locale)}
        </span>
        <div className="live-pillar__track" aria-hidden="true">
          <div className="live-pillar__fill" style={{ height: `${scorePillarHeight(total)}%` }} />
        </div>
      </aside>
    );
  };

  return (
    <>
      <PageHeader
        title={t('rooms.liveTitle')}
        actions={
          <Link className="button button--ghost" to="/teacher/rooms">
            {t('rooms.backToRooms')}
          </Link>
        }
      />
      {!socket.connected ? <Alert message={t('match.connectionLost')} tone="info" /> : null}
      {isTeam ? (
        <section className="live-arena" aria-label={t('rooms.liveTitle')}>
          {pillar(1)}
          <div className="live-arena__center">
            <div className="live-arena__status">
              <StatusBadge status={state.roomStatus} />
              <span className="live-arena__title">{t('rooms.liveTitle')}</span>
              <strong role="timer">
                {state.roomStatus === 'live' ? formatClock(remaining) : '—'}
              </strong>
            </div>
            <div className="live-team-row" aria-label={t('rooms.sideA')}>
              {sidePlayers(1).map(playerCard)}
            </div>
            <div className="live-arena__versus" aria-hidden="true">
              VS
            </div>
            <div className="live-team-row" aria-label={t('rooms.sideB')}>
              {sidePlayers(2).map(playerCard)}
            </div>
          </div>
          {pillar(2)}
        </section>
      ) : (
        <>
          <Card className="live-overview">
            <div>
              <StatusBadge status={state.roomStatus} />
            </div>
            <div>
              <span>{t('rooms.sideA')}</span>
              <strong>{formatNumber(sideTotal(1), locale)}</strong>
            </div>
            <div className="timer">
              {state.roomStatus === 'live' ? formatClock(remaining) : '—'}
            </div>
            <div>
              <span>{t('rooms.sideB')}</span>
              <strong>{formatNumber(sideTotal(2), locale)}</strong>
            </div>
          </Card>
          {state.players.length ? (
            <div className="live-board-grid">{state.players.map(playerCard)}</div>
          ) : (
            <Card>
              <p>{t('rooms.notStarted')}</p>
            </Card>
          )}
        </>
      )}
      {selected ? (
        <Modal title={selected.name} onClose={() => setSelectedId(null)} wide>
          <div className="enlarged-board">
            <div className="score-strip">
              <div>
                <span>{t('common.score')}</span>
                <strong>{formatNumber(selected.game.score, locale)}</strong>
              </div>
              <div>
                <span>{t('common.maxTile')}</span>
                <strong>{formatNumber(selected.game.maxTile, locale)}</strong>
              </div>
            </div>
            <GameBoard game={selected.game} disabled />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
