import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { RoomSummary } from '../../../shared/types';
import { Alert, Card, LoadingBlock, PageHeader, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';

interface HomeData {
  team: { id: string; name: string; code: string; members: unknown[] } | null;
  rooms: RoomSummary[];
  recentCount: number;
}

export function StudentHomePage() {
  const { t } = useTranslation();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void Promise.all([
      api<{ team: HomeData['team'] }>('/api/me/team'),
      api<{ items: RoomSummary[] }>('/api/rooms?pageSize=3&status=open'),
      api<{ items: unknown[] }>('/api/me/results'),
    ])
      .then(([team, rooms, results]) =>
        setData({ team: team.team, rooms: rooms.items, recentCount: results.items.length }),
      )
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);
  return (
    <>
      <PageHeader title={t('home.studentTitle')} subtitle={t('home.studentSubtitle')} />
      {error ? <Alert message={error} /> : null}
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
              <Link className="quick-card" to="/student/rooms">
                <span className="quick-card__icon">▦</span>
                <strong>{t('home.browseRooms')}</strong>
              </Link>
            </div>
          </section>
          <section className="quick-section">
            <h2>{t('home.joinableRooms')}</h2>
            {data.rooms.length ? (
              <div className="mini-room-list">
                {data.rooms.map((room) => (
                  <Link key={room.id} to="/student/rooms">
                    <div>
                      <strong>{room.name}</strong>
                      <small>
                        {t(`mode.${room.mode}`)} · {room.durationMinutes} {t('common.minutes')}
                      </small>
                    </div>
                    <StatusBadge status={room.status} />
                  </Link>
                ))}
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
