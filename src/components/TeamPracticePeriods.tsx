import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
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
const VIEWS: PracticeView[] = ['periods', 'standings', 'matches'];
const VIEW_LABELS = {
  periods: 'teamPractice.periods',
  standings: 'teamPractice.combatStandings',
  matches: 'teamPractice.matchDetails',
} as const;

export function TeamPracticePeriods({
  teacher = false,
  standingsOnly = false,
}: {
  teacher?: boolean;
  standingsOnly?: boolean;
}) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const manager = teacher && !standingsOnly;
  const root = teacher ? '/api/teacher/team-practice-periods' : '/api/team-practice-periods';
  const periods = useApiData<{ items: TeamPracticePeriod[] }>(root);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const requestedView = searchParams.get('view');
  const view: PracticeView = manager
    ? (VIEWS.find((value) => value === requestedView) ?? 'periods')
    : 'standings';
  const requestedId = manager ? searchParams.get('periodId') : selectedId;
  const items = periods.data?.items ?? [];
  const selected =
    items.find((period) => period.id === requestedId) ??
    items.find((period) => period.status === 'open') ??
    items[0];

  const select = (periodId: string, nextView = view) => {
    if (!manager) {
      setSelectedId(periodId);
      return;
    }
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('view', nextView);
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
          <h2>{t(standingsOnly ? 'leaderboard.teamBoard' : 'teamPractice.title')}</h2>
          <p>{t(standingsOnly ? 'leaderboard.teamNote' : 'teamPractice.note')}</p>
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
      {manager ? (
        <div className="tab-list" role="tablist" aria-label={t('teamPractice.pageTitle')}>
          {VIEWS.map((value) => (
            <button
              key={value}
              id={`team-practice-tab-${value}`}
              type="button"
              role="tab"
              className={`tab-button ${view === value ? 'is-active' : ''}`}
              aria-selected={view === value}
              aria-controls="team-practice-panel"
              disabled={busy}
              onClick={() => select(selected?.id ?? '', value)}
            >
              {t(VIEW_LABELS[value])}
            </button>
          ))}
        </div>
      ) : null}
      <div
        id={manager ? 'team-practice-panel' : undefined}
        role={manager ? 'tabpanel' : undefined}
        aria-labelledby={manager ? `team-practice-tab-${view}` : undefined}
      >
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
                            <button
                              className="text-button"
                              type="button"
                              disabled={busy}
                              onClick={() => select(period.id, 'standings')}
                            >
                              {t('teamPractice.viewStandings')}
                            </button>
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
          <EmptyState title={t('teamPractice.noPeriods')} />
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
              {data.standings.map((row) => (
                <tr key={row.team_id}>
                  {standingsOnly ? (
                    <td>{data.standings.findIndex((entry) => entry.points === row.points) + 1}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
