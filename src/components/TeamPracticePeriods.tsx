import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, EmptyState, LoadingBlock } from './ui';
import { useApiData } from '../hooks/useApiData';
import { api } from '../lib/api';
import { currentLocale } from '../i18n';
import { formatDate, formatNumber } from '../lib/format';

export interface TeamPracticePeriod {
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

type PracticeView = 'periods' | 'standings' | 'matches';

export function TeamPracticePeriods({
  teacher = false,
  standingsOnly = false,
  resultsView,
}: {
  teacher?: boolean;
  standingsOnly?: boolean;
  resultsView?: 'standings' | 'matches';
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const manager = teacher && !standingsOnly && !resultsView;
  const root = teacher ? '/api/teacher/team-practice-periods' : '/api/team-practice-periods';
  const periods = useApiData<{ items: TeamPracticePeriod[] }>(root);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const view: PracticeView = resultsView ?? (manager ? 'periods' : 'standings');
  const requestedId = teacher ? searchParams.get('periodId') : selectedId;
  const items = periods.data?.items ?? [];
  const selected =
    items.find((period) => period.id === requestedId) ??
    items.find((period) => period.status === 'open') ??
    items[0];

  const select = (periodId: string) => {
    if (!teacher) {
      setSelectedId(periodId);
      return;
    }
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('roomId');
      if (periodId) next.set('periodId', periodId);
      else next.delete('periodId');
      return next;
    });
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    try {
      const response = await api<{ period: TeamPracticePeriod }>(root, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setName('');
      await periods.reload();
      select(response.period.id);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!selected || !window.confirm(t('teamPractice.confirmClose'))) return;
    setBusy(true);
    setNotice('');
    try {
      await api(`${root}/${selected.id}/close`, { method: 'POST' });
      await periods.reload();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="quick-section card team-practice-content">
      {!manager ? (
        <>
          <h2>{t(view === 'matches' ? 'teamPractice.matchDetails' : 'leaderboard.teamBoard')}</h2>
          <p>{t('leaderboard.teamNote')}</p>
          {teacher ? (
            <Link
              className="text-button"
              to={`/teacher/seasons?type=team&periodId=${encodeURIComponent(selected?.id ?? '')}`}
            >
              {t('seasons.manage')}
            </Link>
          ) : null}
        </>
      ) : null}
      {notice ? <Alert message={notice} /> : null}
      {periods.error ? <Alert message={periods.error} /> : null}
      {periods.loading && !periods.data ? <LoadingBlock /> : null}
      {selected ? (
        <div className="team-practice-selector">
          <label className="field">
            <span>{t('teamPractice.periodName')}</span>
            <select value={selected.id} onChange={(event) => select(event.target.value)}>
              {items.map((period) => (
                <option value={period.id} key={period.id}>
                  {period.name}
                </option>
              ))}
            </select>
          </label>
          <p>
            {t(`teamPractice.status.${selected.status}`)} ·{' '}
            {formatDate(selected.created_at, locale)}
          </p>
        </div>
      ) : null}
      <div>
        {manager && view === 'periods' ? (
          <>
            <h2>{t('teamPractice.title')}</h2>
            {!periods.loading &&
            !periods.error &&
            !items.some((period) => period.status === 'open') ? (
              <form
                className="stack-form team-practice-create"
                onSubmit={(event) => void create(event)}
              >
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
            {selected?.status === 'open' ? (
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() => void close()}
              >
                {t('teamPractice.close')}
              </button>
            ) : null}
            {items.length ? (
              <>
                <h3>{t('teamPractice.periodHistory')}</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('teamPractice.periodName')}</th>
                        <th>{t('leaderboard.status')}</th>
                        <th>{t('rooms.createdAt')}</th>
                        <th>{t('teamPractice.closedAt')}</th>
                        <th>{t('teamPractice.frozenAt')}</th>
                        <th>{t('common.actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((period) => (
                        <tr key={period.id}>
                          <td>{period.name}</td>
                          <td>{t(`teamPractice.status.${period.status}`)}</td>
                          <td>{formatDate(period.created_at, locale)}</td>
                          <td>
                            {period.closed_at === null ? '—' : formatDate(period.closed_at, locale)}
                          </td>
                          <td>
                            {period.frozen_at === null ? '—' : formatDate(period.frozen_at, locale)}
                          </td>
                          <td>
                            <Link
                              className="text-button"
                              to={`/teacher/results?view=teamStandings&periodId=${encodeURIComponent(period.id)}`}
                            >
                              {t('teamPractice.viewStandings')}
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
          </>
        ) : selected ? (
          <TeamPracticeResults
            key={selected.id}
            root={root}
            periodId={selected.id}
            standingsOnly={standingsOnly}
            view={view}
          />
        ) : null}
        {!periods.loading && !periods.error && !items.length ? (
          <EmptyState
            title={t('teamPractice.noPeriods')}
            action={
              teacher && !manager ? (
                <Link className="button button--primary" to="/teacher/seasons?type=team">
                  {t('seasons.manage')}
                </Link>
              ) : undefined
            }
          />
        ) : null}
      </div>
    </section>
  );
}

function TeamPracticeResults({
  root,
  periodId,
  standingsOnly,
  view,
}: {
  root: string;
  periodId: string;
  standingsOnly: boolean;
  view: PracticeView;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const results = useApiData<{
    period: TeamPracticePeriod;
    standings: Standing[];
    matches: Match[];
  }>(`${root}/${periodId}/results`);
  if (results.error) return <Alert message={results.error} />;
  if (results.loading || !results.data) return <LoadingBlock />;
  const data = results.data;
  if (view === 'matches' ? !data.matches.length : !data.standings.length) {
    return (
      <EmptyState
        title={t(view === 'matches' ? 'teamPractice.noMatches' : 'teamPractice.noStandings')}
      />
    );
  }
  return (
    <>
      {view !== 'matches' ? (
        <h3>{t(standingsOnly ? 'teamPractice.standings' : 'teamPractice.combatStandings')}</h3>
      ) : null}
      {view !== 'matches' ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('leaderboard.rank')}</th>
                <th>{t('teamPractice.team')}</th>
                {!standingsOnly ? <th>{t('teamPractice.matches')}</th> : null}
                {!standingsOnly ? <th>{t('teamPractice.wins')}</th> : null}
                {!standingsOnly ? <th>{t('teamPractice.draws')}</th> : null}
                {!standingsOnly ? <th>{t('teamPractice.losses')}</th> : null}
                <th>{t('teamPractice.points')}</th>
              </tr>
            </thead>
            <tbody>
              {data.standings.map((row) => (
                <tr key={row.team_id}>
                  <td>{data.standings.findIndex((entry) => entry.points === row.points) + 1}</td>
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
      ) : null}
      {!standingsOnly && view !== 'standings' ? <h3>{t('teamPractice.matchDetails')}</h3> : null}
      {!standingsOnly && view !== 'standings' ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('teamPractice.startedAt')}</th>
                <th>{t('teamPractice.team')}</th>
                <th>{t('common.score')}</th>
                <th>{t('teamPractice.outcome')}</th>
                <th>{t('teamPractice.points')}</th>
                {root.startsWith('/api/teacher/') ? <th>{t('common.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.matches.map((row) => (
                <tr key={`${row.room_id}-${row.team_id}`}>
                  <td>{formatDate(row.started_at, locale)}</td>
                  <td>{row.team_name_snapshot}</td>
                  <td>{formatNumber(row.team_score, locale)}</td>
                  <td>{t(`teamPractice.result.${row.outcome}`)}</td>
                  <td>{formatNumber(row.points, locale)}</td>
                  {root.startsWith('/api/teacher/') ? (
                    <td>
                      <Link
                        className="text-button"
                        to={`/teacher/results?view=teamMatches&periodId=${encodeURIComponent(periodId)}&roomId=${encodeURIComponent(row.room_id)}`}
                      >
                        {t('seasons.matchResult')}
                      </Link>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
