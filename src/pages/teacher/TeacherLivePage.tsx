import { type CSSProperties, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import type { ServerTeacherState, TeacherPlayerState } from '../../../shared/types';
import { MathPattern } from '../../components/BrandArt';
import { TeamLogo } from '../../components/TeamLogo';
import { useFullscreen } from '../../hooks/useFullscreen';
import { scorePillarHeight, shortTeamName } from '../../lib/live-score';
import { GameBoard } from '../../components/GameBoard';
import { Alert, Card, LoadingBlock, Modal, PageHeader, StatusBadge } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { useNow } from '../../hooks/useNow';
import { useRoomSocket } from '../../hooks/useRoomSocket';
import { currentLocale } from '../../i18n';
import { formatClock, formatNumber } from '../../lib/format';

export function TeacherLivePage() {
  const { t } = useTranslation();
  const { ref, isFullscreen, isFallback, toggle } = useFullscreen();
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
  const sideName = (side: 1 | 2) => {
    const player = sidePlayers(side)[0];
    return (
      (isTeam ? player?.teamName : player?.name) ?? t(side === 1 ? 'rooms.sideA' : 'rooms.sideB')
    );
  };
  const selected = state.players.find((player) => player.userId === selectedId) ?? null;

  const playerCard = (player: TeacherPlayerState) => (
    <article className={`live-player card live-player--${player.side}`} key={player.userId}>
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
    const name = sideName(side);
    const logo = players[0]?.teamLogo;
    const rise = scorePillarHeight(total);
    return (
      <aside className={`live-pillar live-pillar--${side}`} aria-label={name}>
        <MathPattern />
        <span className="live-pillar__star live-pillar__star--top" aria-hidden="true">
          ✦
        </span>
        <span className="live-pillar__star live-pillar__star--bottom" aria-hidden="true">
          ✦
        </span>
        <strong
          className="live-pillar__name"
          title={name}
          aria-label={name}
          style={
            { '--name-length': Math.min(10, Math.max(1, Array.from(name).length)) } as CSSProperties
          }
        >
          {shortTeamName(name)}
        </strong>
        <div className="live-pillar__shaft" style={{ '--rise': `${rise}%` } as CSSProperties}>
          <div className="live-pillar__track" aria-hidden="true">
            <div className="live-pillar__fill" style={{ height: `${rise}%` }} />
          </div>
          <div className="live-pillar__rider">
            <span className="live-pillar__score-label">
              {t(isTeam ? 'results.teamScore' : 'common.score')}
            </span>
            <span
              className="live-pillar__score"
              style={{ '--digits': String(total).length } as CSSProperties}
              aria-label={`${name} ${formatNumber(total, locale)}`}
            >
              {Array.from(String(total)).map((digit, index) => (
                <i key={index}>{digit}</i>
              ))}
            </span>
            <TeamLogo logo={logo} label={`${name} ${t('teams.logoLabel')}`} />
            <span className="live-pillar__platform" aria-hidden="true" />
          </div>
        </div>
      </aside>
    );
  };

  return (
    <div ref={ref} className={`live-view ${isFullscreen ? 'is-fullscreen' : ''}`}>
      <PageHeader
        title={t('rooms.liveTitle')}
        actions={
          <>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void toggle()}
              aria-pressed={isFullscreen}
            >
              {t(isFullscreen ? 'common.exitFullscreen' : 'common.fullscreen')}
            </button>
            <Link className="button button--ghost" to="/teacher/rooms">
              {t('rooms.backToRooms')}
            </Link>
          </>
        }
      />
      {isFallback ? <Alert tone="info" message={t('rooms.fullscreenFallback')} /> : null}
      {!socket.connected ? <Alert message={t('match.connectionLost')} tone="info" /> : null}
      {state.players.length ? (
        <section
          className={`live-arena ${isTeam ? 'live-arena--team' : 'live-arena--duel'}`}
          aria-label={t('rooms.liveTitle')}
        >
          {pillar(1)}
          <div className="live-arena__center">
            <div className="arena-scoreboard">
              {[1, 2].map((side) => (
                <div key={side} className={`arena-total arena-total--${side}`}>
                  <span>{sideName(side as 1 | 2)}</span>
                  <strong>{formatNumber(sideTotal(side as 1 | 2), locale)}</strong>
                </div>
              ))}
            </div>
            <div
              className={`live-arena__status ${state.roomStatus === 'live' && remaining <= 30_000 ? 'is-warning' : ''}`}
            >
              <StatusBadge status={state.roomStatus} />
              <span className="live-arena__title">{t('rooms.liveTitle')}</span>
              <strong role="timer">
                <small>{t(state.roomStatus === 'ended' ? 'match.ended' : 'match.remaining')}</small>
                {state.roomStatus === 'live' ? formatClock(remaining) : '—'}
              </strong>
            </div>
            <div className="live-arena__boards">
              <div className="live-team-row" aria-label={t('rooms.sideA')}>
                {sidePlayers(1).map(playerCard)}
              </div>
              <div className="live-arena__versus" aria-hidden="true">
                {isTeam ? (
                  <>
                    {sideName(1)} <span>VS</span> {sideName(2)}
                  </>
                ) : (
                  <span>VS</span>
                )}
              </div>
              <div className="live-team-row" aria-label={t('rooms.sideB')}>
                {sidePlayers(2).map(playerCard)}
              </div>
            </div>
          </div>
          {pillar(2)}
        </section>
      ) : (
        <Card>
          <p>{t('rooms.notStarted')}</p>
        </Card>
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
    </div>
  );
}
