import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RoomSummary } from '../../../shared/types';
import { Alert, Card, LoadingBlock, PageHeader, StatusBadge } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { api } from '../../lib/api';

interface LobbyRoom extends RoomSummary {
  entries: Array<{
    side: 'A' | 'B';
    student_no: string | null;
    display_name: string | null;
    team_name: string | null;
    team_code: string | null;
  }>;
}

export function RoomLobbyPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const room = useApiData<{ room: LobbyRoom }>(id ? `/api/rooms/${id}` : null);
  const reloadRoom = room.reload;
  const [error, setError] = useState('');

  useEffect(() => {
    if (room.data?.room.status === 'countdown' || room.data?.room.status === 'live') {
      navigate(`/student/rooms/${id}/match`, { replace: true });
    }
  }, [id, navigate, room.data?.room.status]);

  useEffect(() => {
    const timer = window.setInterval(() => void reloadRoom(), 2000);
    return () => window.clearInterval(timer);
  }, [reloadRoom]);

  const leave = async () => {
    if (!window.confirm(t('rooms.confirmLeave'))) return;
    try {
      await api(`/api/rooms/${id}/leave`, { method: 'POST' });
      navigate('/student/rooms');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  if (room.loading) return <LoadingBlock />;
  if (room.error || !room.data) return <Alert message={room.error || t('match.notParticipant')} />;
  const data = room.data.room;
  const entry = (side: 'A' | 'B') => data.entries.find((candidate) => candidate.side === side);
  return (
    <>
      <PageHeader
        title={t('rooms.lobbyTitle')}
        subtitle={data.name}
        actions={
          <Link className="button button--ghost" to="/student/rooms">
            {t('rooms.backToRooms')}
          </Link>
        }
      />
      {error ? <Alert message={error} /> : null}
      <Card className="lobby-card">
        <div className="lobby-card__summary">
          <div>
            <span>{t('rooms.mode')}</span>
            <strong>{t(`mode.${data.mode}`)}</strong>
          </div>
          <div>
            <span>{t('rooms.duration')}</span>
            <strong>
              {data.durationMinutes} {t('common.minutes')}
            </strong>
          </div>
          <div>
            <span>{t('rooms.status')}</span>
            <StatusBadge status={data.status} />
          </div>
        </div>
        <div className="versus-grid">
          {(['A', 'B'] as const).map((side) => {
            const value = entry(side);
            return (
              <article key={side} className="side-card">
                <span>{side === 'A' ? t('rooms.sideA') : t('rooms.sideB')}</span>
                <strong>{value?.team_name ?? value?.display_name ?? t('rooms.emptySeat')}</strong>
                <small>{value?.team_code ?? value?.student_no ?? ''}</small>
              </article>
            );
          })}
        </div>
        <p className="lobby-message">
          {data.status === 'full' ? t('rooms.waitingTeacher') : t('rooms.waitingPlayers')}
        </p>
        <button type="button" className="button button--danger" onClick={() => void leave()}>
          {t('rooms.leave')}
        </button>
      </Card>
    </>
  );
}
