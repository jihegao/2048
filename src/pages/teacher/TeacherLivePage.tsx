import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import type { ServerTeacherState, TeacherPlayerState } from '../../../shared/types';
import { GameBoard } from '../../components/GameBoard';
import { Alert, Card, LoadingBlock, Modal, PageHeader, StatusBadge } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { useNow } from '../../hooks/useNow';
import { useRoomSocket } from '../../hooks/useRoomSocket';
import { currentLocale } from '../../i18n';
import { formatClock, formatNumber } from '../../lib/format';

export function TeacherLivePage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const initial = useApiData<ServerTeacherState>(id ? `/api/teacher/rooms/${id}/live` : null);
  const [liveState, setLiveState] = useState<ServerTeacherState | null>(null);
  const [selected, setSelected] = useState<TeacherPlayerState | null>(null);
  const state = liveState ?? initial.data;
  const now = useNow();
  const locale = currentLocale();
  const onState = useCallback((next: ServerTeacherState) => setLiveState(next), []);
  const socket = useRoomSocket<ServerTeacherState>(id, onState);

  if (initial.loading && !state) return <LoadingBlock />;
  if (initial.error && !state) return <Alert message={initial.error} />;
  if (!state) return <Alert message={t('rooms.notStarted')} />;
  const remaining = state.endsAt ? state.endsAt - now : 0;
  const sideTotal = (side: 1 | 2) =>
    state.players
      .filter((player) => player.side === side)
      .reduce((total, player) => total + player.game.score, 0);

  return (
    <>
      <PageHeader
        title={t('rooms.liveTitle')}
        subtitle={t('rooms.liveSubtitle')}
        actions={
          <Link className="button button--ghost" to="/teacher/rooms">
            {t('rooms.backToRooms')}
          </Link>
        }
      />
      {!socket.connected ? <Alert message={t('match.connectionLost')} tone="info" /> : null}
      <Card className="live-overview">
        <div>
          <StatusBadge status={state.roomStatus} />
        </div>
        <div>
          <span>{t('rooms.sideA')}</span>
          <strong>{formatNumber(sideTotal(1), locale)}</strong>
        </div>
        <div className="timer">{state.roomStatus === 'live' ? formatClock(remaining) : '—'}</div>
        <div>
          <span>{t('rooms.sideB')}</span>
          <strong>{formatNumber(sideTotal(2), locale)}</strong>
        </div>
      </Card>
      {state.players.length ? (
        <div className="live-board-grid">
          {state.players.map((player) => (
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
                onClick={() => setSelected(player)}
              >
                <GameBoard game={player.game} compact disabled />
              </button>
              <footer>
                <span>
                  {t('common.score')} <strong>{formatNumber(player.game.score, locale)}</strong>
                </span>
                <span>
                  {t('common.maxTile')} <strong>{player.game.maxTile}</strong>
                </span>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <Card>
          <p>{t('rooms.notStarted')}</p>
        </Card>
      )}
      {selected ? (
        <Modal title={selected.name} onClose={() => setSelected(null)} wide>
          <div className="enlarged-board">
            <div className="score-strip">
              <div>
                <span>{t('common.score')}</span>
                <strong>{formatNumber(selected.game.score, locale)}</strong>
              </div>
              <div>
                <span>{t('common.maxTile')}</span>
                <strong>{selected.game.maxTile}</strong>
              </div>
            </div>
            <GameBoard game={selected.game} disabled />
          </div>
        </Modal>
      ) : null}
    </>
  );
}
