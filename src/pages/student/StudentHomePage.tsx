import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomSummary } from '../../../shared/types';
import { Alert, Card, LoadingBlock, PageHeader, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';

interface HomeData {
  team: { id: string; name: string; code: string; logo: string | null; members: unknown[] } | null;
  rooms: RoomSummary[];
  recentCount: number;
}

const ACTIVE_ROOM_STATUSES = ['open', 'full', 'countdown', 'live'];
const ROOM_POLL_MS = 6000;

function isLiveRoom(room: RoomSummary): boolean {
  return room.status === 'countdown' || room.status === 'live';
}

export function StudentHomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [team, rooms, results] = await Promise.all([
        api<{ team: HomeData['team'] }>('/api/me/team'),
        api<{ items: RoomSummary[] }>('/api/rooms?pageSize=100'),
        api<{ items: unknown[] }>('/api/me/results'),
      ]);
      setError('');
      setData({ team: team.team, rooms: rooms.items, recentCount: results.items.length });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, ROOM_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const enterRoom = async (room: RoomSummary) => {
    setNotice('');
    if (!room.isParticipant) {
      setJoiningId(room.id);
      try {
        await api(`/api/rooms/${room.id}/join`, { method: 'POST' });
      } catch (reason: unknown) {
        setNotice(reason instanceof Error ? reason.message : String(reason));
        void load();
        return;
      } finally {
        setJoiningId(null);
      }
    }
    navigate(isLiveRoom(room) ? `/student/rooms/${room.id}/match` : `/student/rooms/${room.id}`);
  };

  const rooms = data?.rooms ?? [];
  const myRooms = rooms.filter(
    (room) => room.isParticipant && ACTIVE_ROOM_STATUSES.includes(room.status),
  );
  const joinableRooms = rooms.filter((room) => !room.isParticipant && room.status === 'open');

  const roomRow = (room: RoomSummary, actionLabel: string, busy: boolean) => (
    <article key={room.id} className="mini-room-row">
      <div>
        <strong>{room.name}</strong>
        <small>
          {t(`mode.${room.mode}`)} · {room.durationMinutes} {t('common.minutes')}
        </small>
      </div>
      <div className="mini-room-row__side">
        <StatusBadge status={room.status} />
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => void enterRoom(room)}
        >
          {busy ? t('rooms.joining') : actionLabel}
        </button>
      </div>
    </article>
  );

  return (
    <>
      <PageHeader title={t('home.studentTitle')} subtitle={t('home.studentSubtitle')} />
      {error ? <Alert message={error} /> : null}
      {notice ? <Alert message={notice} tone="error" /> : null}
      {!data ? (
        <LoadingBlock />
      ) : (
        <>
          <div className="student-home-grid">
            <Card className="home-team">
              <span>{t('home.currentTeam')}</span>
              <strong>{data.team?.name ?? t('home.noTeam')}</strong>
              <small>{data.team?.code ?? t('teams.fullTeamHint')}</small>
              <Link className="text-button" to="/student/team">
                {t('common.view')}
              </Link>
            </Card>
            <Card>
              <span>{t('common.recentResults')}</span>
              <strong className="home-number">{data.recentCount}</strong>
              <Link className="text-button" to="/student/results">
                {t('common.view')}
              </Link>
            </Card>
          </div>
          <section className="quick-section">
            <h2>{t('home.quickActions')}</h2>
            <div className="quick-grid">
              <Link className="quick-card quick-card--accent" to="/student/practice">
                <span className="quick-card__icon">◆</span>
                <strong>{t('home.startPractice')}</strong>
              </Link>
            </div>
          </section>
          {myRooms.length ? (
            <section className="quick-section">
              <h2>{t('home.myRooms')}</h2>
              <div className="mini-room-list">
                {myRooms.map((room) =>
                  roomRow(
                    room,
                    isLiveRoom(room) ? t('rooms.returnToMatch') : t('rooms.enterLobby'),
                    false,
                  ),
                )}
              </div>
            </section>
          ) : null}
          <section className="quick-section">
            <h2>{t('home.joinableRooms')}</h2>
            {joinableRooms.length ? (
              <div className="mini-room-list">
                {joinableRooms.map((room) => roomRow(room, t('rooms.join'), joiningId === room.id))}
              </div>
            ) : (
              <p>{t('home.noJoinableRooms')}</p>
            )}
          </section>
        </>
      )}
    </>
  );
}
