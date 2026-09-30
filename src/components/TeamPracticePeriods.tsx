import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, LoadingBlock } from './ui';
import { useApiData } from '../hooks/useApiData';
import { api } from '../lib/api';
import { currentLocale } from '../i18n';
import { formatDate, formatNumber } from '../lib/format';

interface Period {
  id: string;
  name: string;
  status: 'open' | 'closing' | 'frozen';
  created_at: number;
  closed_at: number | null;
  frozen_at: number | null;
}

interface Standing {
  team_id: string;
  team_name_snapshot: string;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  matches: number;
}

interface Match {
  room_id: string;
  team_id: string;
  team_name_snapshot: string;
  outcome: 'win' | 'draw' | 'loss';
  points: number;
  team_score: number;
  started_at: number;
}

export function TeamPracticePeriods({
  teacher = false,
  standingsOnly = false,
}: {
  teacher?: boolean;
  standingsOnly?: boolean;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const root = teacher ? '/api/teacher/team-practice-periods' : '/api/team-practice-periods';
  const periods = useApiData<{ items: Period[] }>(root);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const activeId = selectedId || periods.data?.items[0]?.id || '';
  const results = useApiData<{ period: Period; standings: Standing[]; matches: Match[] }>(
    activeId ? `${root}/${activeId}/results` : null,
  );
  const selected = periods.data?.items.find((period) => period.id === activeId);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await api<{ period: Period }>(root, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setName('');
      setSelectedId(response.period.id);
      setNotice('');
      await periods.reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!selected || !window.confirm(t('teamPractice.confirmClose'))) return;
    setBusy(true);
    try {
      await api(`${root}/${selected.id}/close`, { method: 'POST' });
      setNotice('');
      await periods.reload();
      await results.reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="quick-section card">
      <h2>{t(standingsOnly ? 'leaderboard.teamBoard' : 'teamPractice.title')}</h2>
      <p>{t(standingsOnly ? 'leaderboard.teamNote' : 'teamPractice.note')}</p>
      {notice ? <Alert message={notice} /> : null}
      {periods.error ? <Alert message={periods.error} /> : null}
      {teacher &&
      !standingsOnly &&
      !periods.data?.items.some((period) => period.status === 'open') ? (
        <form className="stack-form" onSubmit={(event) => void create(event)}>
          <label className="field">
            <span>{t('teamPractice.periodName')}</span>
            <input
              value={name}
              maxLength={80}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button className="button button--primary" disabled={busy}>
            {t('teamPractice.open')}
          </button>
        </form>
      ) : null}
      {periods.loading && !periods.data ? <LoadingBlock /> : null}
      {periods.data?.items.length ? (
        <>
          <label className="field">
            <span>{t('teamPractice.periodName')}</span>
            <select value={activeId} onChange={(event) => setSelectedId(event.target.value)}>
              {periods.data.items.map((period) => (
                <option value={period.id} key={period.id}>
                  {period.name}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <p>
              {t(`teamPractice.status.${selected.status}`)} ·{' '}
              {formatDate(selected.created_at, locale)}
            </p>
          ) : null}
          {teacher && !standingsOnly && selected?.status === 'open' ? (
            <button
              type="button"
              className="button button--danger"
              disabled={busy}
              onClick={() => void close()}
            >
              {t('teamPractice.close')}
            </button>
          ) : null}
          {results.error ? <Alert message={results.error} /> : null}
          {results.loading && !results.data ? <LoadingBlock /> : null}
          {results.data ? (
            <>
              <h3>{t('teamPractice.standings')}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {standingsOnly ? <th>{t('leaderboard.rank')}</th> : null}
                      <th>{t('teamPractice.team')}</th>
                      {!standingsOnly ? <th>{t('teamPractice.matches')}</th> : null}
                      {!standingsOnly ? <th>{t('teamPractice.wins')}</th> : null}
                      {!standingsOnly ? <th>{t('teamPractice.draws')}</th> : null}
                      {!standingsOnly ? <th>{t('teamPractice.losses')}</th> : null}
                      <th>{t('teamPractice.points')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.data.standings.map((row) => (
                      <tr key={row.team_id}>
                        {standingsOnly ? (
                          <td>
                            {results.data!.standings.findIndex(
                              (entry) => entry.points === row.points,
                            ) + 1}
                          </td>
                        ) : null}
                        <td>{row.team_name_snapshot}</td>
                        {!standingsOnly ? <td>{formatNumber(row.matches, locale)}</td> : null}
                        {!standingsOnly ? <td>{formatNumber(row.wins, locale)}</td> : null}
                        {!standingsOnly ? <td>{formatNumber(row.draws, locale)}</td> : null}
                        {!standingsOnly ? <td>{formatNumber(row.losses, locale)}</td> : null}
                        <td>{formatNumber(row.points, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!standingsOnly ? <h3>{t('teamPractice.matchDetails')}</h3> : null}
              {!standingsOnly ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('rooms.createdAt')}</th>
                        <th>{t('teamPractice.team')}</th>
                        <th>{t('common.score')}</th>
                        <th>{t('teamPractice.outcome')}</th>
                        <th>{t('teamPractice.points')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.data.matches.map((row) => (
                        <tr key={`${row.room_id}-${row.team_id}`}>
                          <td>{formatDate(row.started_at, locale)}</td>
                          <td>{row.team_name_snapshot}</td>
                          <td>{formatNumber(row.team_score, locale)}</td>
                          <td>{t(`teamPractice.result.${row.outcome}`)}</td>
                          <td>{formatNumber(row.points, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <p>{t('teamPractice.noPeriods')}</p>
      )}
    </section>
  );
}
