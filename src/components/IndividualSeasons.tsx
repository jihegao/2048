import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { LeaderboardPeriod } from '../../shared/types';
import { Alert, EmptyState, LoadingBlock, Modal, StatusBadge } from './ui';
import { useApiData } from '../hooks/useApiData';
import { currentLocale } from '../i18n';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';

function toDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function PeriodEditor({
  period,
  onClose,
  onSaved,
}: {
  period: LeaderboardPeriod | null;
  onClose: () => void;
  onSaved: (period: LeaderboardPeriod, message: string) => void;
}) {
  const { t } = useTranslation();
  const locked = period !== null && period.status !== 'upcoming';
  const [name, setName] = useState(period?.name ?? '');
  const [startAt, setStartAt] = useState(period ? toDateTimeLocal(period.startAt) : '');
  const [endAt, setEndAt] = useState(period ? toDateTimeLocal(period.endAt) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = locked
        ? { name }
        : {
            name,
            startAt: new Date(startAt).toISOString(),
            endAt: new Date(endAt).toISOString(),
          };
      const response = await api<{ period: LeaderboardPeriod }>(
        period
          ? `/api/teacher/leaderboard-periods/${period.id}`
          : '/api/teacher/leaderboard-periods',
        {
          method: period ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        },
      );
      onSaved(
        response.period,
        t(period ? 'leaderboard.periodUpdated' : 'leaderboard.periodCreated'),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t(period ? 'leaderboard.editPeriod' : 'leaderboard.createPeriod')}
      onClose={onClose}
    >
      <form className="stack-form" onSubmit={(event) => void save(event)}>
        {error ? <Alert message={error} /> : null}
        {locked ? <Alert message={t('leaderboard.periodLocked')} tone="info" /> : null}
        <label className="field">
          <span>{t('leaderboard.periodName')}</span>
          <input
            value={name}
            maxLength={80}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('leaderboard.startAt')}</span>
          <input
            type="datetime-local"
            value={startAt}
            required
            disabled={locked}
            onChange={(event) => setStartAt(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t('leaderboard.endAt')}</span>
          <input
            type="datetime-local"
            value={endAt}
            required
            disabled={locked}
            onChange={(event) => setEndAt(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button button--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function IndividualSeasons() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const periods = useApiData<{ items: LeaderboardPeriod[] }>('/api/teacher/leaderboard-periods');
  const [editorPeriod, setEditorPeriod] = useState<LeaderboardPeriod | null | undefined>(undefined);
  const [notice, setNotice] = useState('');
  return (
    <>
      {notice ? <Alert message={notice} tone="success" /> : null}
      {periods.error ? <Alert message={periods.error} /> : null}
      <div className="leaderboard-admin-toolbar card">
        <h2>{t('seasons.individual')}</h2>
        <button
          type="button"
          className="button button--primary"
          onClick={() => setEditorPeriod(null)}
        >
          {t('leaderboard.createPeriod')}
        </button>
      </div>
      {periods.loading ? (
        <LoadingBlock />
      ) : periods.data?.items.length ? (
        <section className="leaderboard-period-history">
          <h2>{t('leaderboard.periodHistory')}</h2>
          <div className="table-wrap card">
            <table>
              <thead>
                <tr>
                  <th>{t('leaderboard.periodName')}</th>
                  <th>{t('leaderboard.status')}</th>
                  <th>{t('leaderboard.startAt')}</th>
                  <th>{t('leaderboard.endAt')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {periods.data.items.map((period) => (
                  <tr key={period.id}>
                    <td>{period.name}</td>
                    <td>
                      <StatusBadge status={period.status} />
                    </td>
                    <td>{formatDate(period.startAt, locale)}</td>
                    <td>{formatDate(period.endAt, locale)}</td>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setEditorPeriod(period)}
                      >
                        {t(
                          period.status === 'upcoming'
                            ? 'leaderboard.editPeriod'
                            : 'leaderboard.renamePeriod',
                        )}
                      </button>
                      <Link
                        className="text-button"
                        to={`/teacher/results?view=leaderboard&periodId=${encodeURIComponent(period.id)}`}
                      >
                        {t('seasons.viewResults')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <EmptyState
          title={t('leaderboard.noPeriods')}
          action={
            <button
              type="button"
              className="button button--primary"
              onClick={() => setEditorPeriod(null)}
            >
              {t('leaderboard.createPeriod')}
            </button>
          }
        />
      )}

      {editorPeriod !== undefined ? (
        <PeriodEditor
          period={editorPeriod}
          onClose={() => setEditorPeriod(undefined)}
          onSaved={(_saved, message) => {
            setEditorPeriod(undefined);
            setNotice(message);
            void periods.reload();
          }}
        />
      ) : null}
    </>
  );
}
