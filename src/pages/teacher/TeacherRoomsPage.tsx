import { type FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { RoomMode, RoomSummary } from '../../../shared/types';
import { currentLocale } from '../../i18n';
import { api, queryString } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useApiData } from '../../hooks/useApiData';
import {
  Alert,
  EmptyState,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  StatusBadge,
} from '../../components/ui';

interface RoomPage {
  items: RoomSummary[];
  total: number;
  page: number;
  pageSize: number;
}

interface RoomForm {
  name: string;
  mode: RoomMode;
  durationMinutes: number;
}

const EMPTY_FORM: RoomForm = { name: '', mode: 'duel', durationMinutes: 5 };

export function TeacherRoomsPage() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RoomForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const path = useMemo(
    () => `/api/teacher/rooms${queryString({ page, pageSize: 20, status, query })}`,
    [page, status, query],
  );
  const rooms = useApiData<RoomPage>(path);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialog('create');
  };

  const openEdit = (room: RoomSummary) => {
    setEditingId(room.id);
    setForm({ name: room.name, mode: room.mode, durationMinutes: room.durationMinutes });
    setDialog('edit');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const response = await api<{ message: string }>(
        editingId ? `/api/teacher/rooms/${editingId}` : '/api/teacher/rooms',
        { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify(form) },
      );
      setNotice({ message: response.message, error: false });
      setDialog(null);
      await rooms.reload();
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const action = async (room: RoomSummary, kind: 'start' | 'cancel') => {
    if (kind === 'cancel' && !window.confirm(t('rooms.confirmCancel'))) return;
    setNotice(null);
    try {
      const response = await api<{ message: string }>(`/api/teacher/rooms/${room.id}/${kind}`, {
        method: 'POST',
      });
      setNotice({ message: response.message, error: false });
      await rooms.reload();
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    }
  };

  return (
    <>
      <PageHeader
        title={t('rooms.title')}
        subtitle={t('rooms.subtitle')}
        actions={
          <button type="button" className="button button--primary" onClick={openCreate}>
            {t('rooms.create')}
          </button>
        }
      />
      {notice ? <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} /> : null}
      <section className="toolbar card">
        <label className="search-field">
          <span className="sr-only">{t('common.search')}</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder={t('rooms.namePlaceholder')}
          />
        </label>
        <label className="select-field">
          <span className="sr-only">{t('rooms.status')}</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">{t('common.all')}</option>
            {['open', 'full', 'countdown', 'live', 'ended', 'cancelled'].map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </section>
      {rooms.error ? <Alert message={rooms.error} /> : null}
      {rooms.loading ? (
        <LoadingBlock />
      ) : rooms.data?.items.length ? (
        <>
          <div className="table-wrap card">
            <table>
              <thead>
                <tr>
                  <th>{t('rooms.name')}</th>
                  <th>{t('rooms.mode')}</th>
                  <th>{t('rooms.duration')}</th>
                  <th>{t('rooms.participants')}</th>
                  <th>{t('rooms.status')}</th>
                  <th>{t('rooms.createdAt')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rooms.data.items.map((room) => (
                  <tr key={room.id}>
                    <td>
                      <strong>{room.name}</strong>
                      <small className="table-subtext">{room.code}</small>
                    </td>
                    <td>{t(`mode.${room.mode}`)}</td>
                    <td>
                      {room.durationMinutes} {t('common.minutes')}
                    </td>
                    <td>
                      {room.participantCount} / {room.participantCapacity}
                    </td>
                    <td>
                      <StatusBadge status={room.status} />
                    </td>
                    <td>{formatDate(room.createdAt, locale)}</td>
                    <td>
                      <div className="table-actions">
                        {room.status === 'open' && !room.lockedAt ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => openEdit(room)}
                          >
                            {t('common.edit')}
                          </button>
                        ) : null}
                        {room.status === 'full' ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void action(room, 'start')}
                          >
                            {t('rooms.start')}
                          </button>
                        ) : null}
                        {['countdown', 'live', 'ended'].includes(room.status) ? (
                          <Link className="text-button" to={`/teacher/rooms/${room.id}/live`}>
                            {t('rooms.openLive')}
                          </Link>
                        ) : null}
                        {['open', 'full'].includes(room.status) ? (
                          <button
                            type="button"
                            className="text-button text-button--danger"
                            onClick={() => void action(room, 'cancel')}
                          >
                            {t('rooms.cancelRoom')}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            total={rooms.data.total}
            pageSize={rooms.data.pageSize}
            onPage={setPage}
          />
        </>
      ) : (
        <EmptyState
          title={t('rooms.noRooms')}
          action={
            <button type="button" className="button button--primary" onClick={openCreate}>
              {t('rooms.create')}
            </button>
          }
        />
      )}

      {dialog ? (
        <Modal
          title={t(dialog === 'create' ? 'rooms.createTitle' : 'rooms.settingsTitle')}
          onClose={() => setDialog(null)}
        >
          <form className="stack-form" onSubmit={submit}>
            <label className="field">
              <span>{t('rooms.name')}</span>
              <input
                required
                maxLength={80}
                value={form.name}
                placeholder={t('rooms.namePlaceholder')}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label className="field">
              <span>{t('rooms.mode')}</span>
              <select
                value={form.mode}
                onChange={(event) => setForm({ ...form, mode: event.target.value as RoomMode })}
              >
                <option value="duel">{t('mode.duel')}</option>
                <option value="team_3v3">{t('mode.team_3v3')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('rooms.duration')}</span>
              <input
                required
                type="number"
                min={1}
                max={10}
                step={1}
                value={form.durationMinutes}
                onChange={(event) =>
                  setForm({ ...form, durationMinutes: Number(event.target.value) })
                }
              />
              <small>{t('rooms.durationHelp')}</small>
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setDialog(null)}
              >
                {t('common.cancel')}
              </button>
              <button type="submit" className="button button--primary" disabled={busy}>
                {t('common.save')}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
