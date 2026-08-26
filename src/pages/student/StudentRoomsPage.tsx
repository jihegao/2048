import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { RoomSummary } from '../../../shared/types';
import {
  Alert,
  EmptyState,
  LoadingBlock,
  PageHeader,
  Pagination,
  StatusBadge,
} from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { api, queryString } from '../../lib/api';

interface RoomPage {
  items: RoomSummary[];
  total: number;
  pageSize: number;
}

export function StudentRoomsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState('');
  const [notice, setNotice] = useState('');
  const path = useMemo(
    () => `/api/rooms${queryString({ page, pageSize: 20, mode })}`,
    [page, mode],
  );
  const rooms = useApiData<RoomPage>(path);

  const enter = async (room: RoomSummary) => {
    setNotice('');
    if (room.isParticipant) {
      const destination = ['countdown', 'live'].includes(room.status)
        ? `/student/rooms/${room.id}/match`
        : `/student/rooms/${room.id}`;
      navigate(destination);
      return;
    }
    try {
      await api(`/api/rooms/${room.id}/join`, { method: 'POST' });
      navigate(`/student/rooms/${room.id}`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      <PageHeader title={t('rooms.studentTitle')} subtitle={t('rooms.studentSubtitle')} />
      {notice ? <Alert message={notice} /> : null}
      <section className="toolbar card">
        <select
          value={mode}
          aria-label={t('rooms.mode')}
          onChange={(event) => {
            setMode(event.target.value);
            setPage(1);
          }}
        >
          <option value="">{t('common.all')}</option>
          <option value="duel">{t('mode.duel')}</option>
          <option value="team_3v3">{t('mode.team_3v3')}</option>
        </select>
      </section>
      {rooms.error ? <Alert message={rooms.error} /> : null}
      {rooms.loading ? (
        <LoadingBlock />
      ) : rooms.data?.items.length ? (
        <>
          <div className="room-grid">
            {rooms.data.items.map((room) => {
              const canEnter =
                room.status === 'open' ||
                (room.isParticipant && ['open', 'full', 'countdown', 'live'].includes(room.status));
              const actionLabel = room.isParticipant
                ? ['countdown', 'live'].includes(room.status)
                  ? t('rooms.returnToMatch')
                  : t('rooms.enterLobby')
                : room.status === 'open'
                  ? t('rooms.join')
                  : t(`status.${room.status}`);
              return (
                <article className="room-card card" key={room.id}>
                  <div className="room-card__head">
                    <div>
                      <h2>{room.name}</h2>
                      <small>{room.code}</small>
                    </div>
                    <StatusBadge status={room.status} />
                  </div>
                  <dl className="room-card__facts">
                    <div>
                      <dt>{t('rooms.mode')}</dt>
                      <dd>{t(`mode.${room.mode}`)}</dd>
                    </div>
                    <div>
                      <dt>{t('rooms.duration')}</dt>
                      <dd>
                        {room.durationMinutes} {t('common.minutes')}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('rooms.participants')}</dt>
                      <dd>
                        {room.participantCount} / {room.participantCapacity}
                      </dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="button button--primary button--full"
                    disabled={!canEnter}
                    onClick={() => void enter(room)}
                  >
                    {actionLabel}
                  </button>
                </article>
              );
            })}
          </div>
          <Pagination
            page={page}
            total={rooms.data.total}
            pageSize={rooms.data.pageSize}
            onPage={setPage}
          />
        </>
      ) : (
        <EmptyState title={t('rooms.noRooms')} />
      )}
    </>
  );
}
