import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PersonalBestPracticeResult,
  PersonalDuelResult,
  PersonalResultsCategory,
  PersonalResultsResponse,
  PersonalResultsSummary,
  PersonalTimedPracticeResult,
  PersonalTeamMatchResult,
  StudentPracticeLeaderboardBoard,
  StudentPracticeLeaderboardResponse,
  StudentPracticeLeaderboardUnavailableResponse,
  StudentTeamLeaderboardResponse,
  StudentTeamLeaderboardUnavailableResponse,
} from '../../../shared/types';
import { teamLogoGlyph } from '../../../shared/types';
import { Alert, EmptyState, LoadingBlock, PageHeader } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { currentLocale } from '../../i18n';
import { formatDate, formatNumber } from '../../lib/format';
import { TeamPracticePeriods } from '../../components/TeamPracticePeriods';

type ResultsView = 'personal' | 'leaderboard' | 'team';
type PersonalCategoryView = 'practice' | 'duel' | 'team';
type LeaderboardView = 'overall' | 'grade';
type LeaderboardResponse =
  StudentPracticeLeaderboardResponse | StudentPracticeLeaderboardUnavailableResponse;
type TeamLeaderboardResponse =
  StudentTeamLeaderboardResponse | StudentTeamLeaderboardUnavailableResponse;

function ResultsTabs({
  value,
  onChange,
}: {
  value: ResultsView;
  onChange: (value: ResultsView) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="tab-list" role="tablist" aria-label={t('leaderboard.resultsView')}>
      {(['personal', 'leaderboard', 'team'] as const).map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          className={`tab-button ${value === view ? 'is-active' : ''}`}
          aria-selected={value === view}
          onClick={() => onChange(view)}
        >
          {t(
            view === 'personal'
              ? 'leaderboard.myRecords'
              : view === 'leaderboard'
                ? 'leaderboard.currentPractice'
                : 'leaderboard.teamBoard',
          )}
        </button>
      ))}
    </div>
  );
}

function PracticeLeaderboardTable({ board }: { board: StudentPracticeLeaderboardBoard }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  if (board.entries.length === 0) return <EmptyState title={t('leaderboard.noResults')} />;
  return (
    <div className="table-wrap card">
      <table>
        <thead>
          <tr>
            <th>{t('leaderboard.rank')}</th>
            <th>{t('leaderboard.className')}</th>
            <th>{t('leaderboard.maskedName')}</th>
            <th>{t('leaderboard.studentNumberSuffix')}</th>
            <th>{t('common.score')}</th>
            <th>{t('common.maxTile')}</th>
          </tr>
        </thead>
        <tbody>
          {board.entries.map((entry, index) => (
            <tr
              key={`${entry.rank}-${entry.studentNumberSuffix}-${entry.maskedName}-${index}`}
              className={entry.isCurrentUser ? 'leaderboard-row--current' : undefined}
            >
              <td>
                <strong>{entry.rank}</strong>
                {entry.isCurrentUser ? (
                  <span className="current-user-mark">{t('leaderboard.me')}</span>
                ) : null}
              </td>
              <td>{entry.className}</td>
              <td>{entry.maskedName}</td>
              <td>{entry.studentNumberSuffix}</td>
              <td>{formatNumber(entry.score, locale)}</td>
              <td>{formatNumber(entry.maxTile, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryCards({ summary }: { summary: PersonalResultsSummary }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const metrics = [
    ['played', summary.played],
    ['wins', summary.wins],
    ['draws', summary.draws],
    ['losses', summary.losses],
    ['points', summary.points],
  ] as const;
  return (
    <div className="personal-summary-grid">
      {metrics.map(([key, value]) => (
        <div className="card" key={key}>
          <span>{t(`personalResults.${key}`)}</span>
          <strong>{formatNumber(value, locale)}</strong>
        </div>
      ))}
    </div>
  );
}

function PracticeBest({ items }: { items: PersonalBestPracticeResult[] }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  if (!items.length) return <EmptyState title={t('personalResults.noPracticeResults')} />;
  return (
    <div className="table-wrap card personal-records-table">
      <table>
        <thead>
          <tr>
            <th>{t('leaderboard.rank')}</th>
            <th>{t('common.score')}</th>
            <th>{t('common.maxTile')}</th>
            <th>{t('results.validMoves')}</th>
            <th>{t('results.occurredAt')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.id}>
              <td>
                <strong>{index + 1}</strong>
              </td>
              <td>{formatNumber(item.score, locale)}</td>
              <td>{formatNumber(item.maxTile, locale)}</td>
              <td>{formatNumber(item.validMoveCount, locale)}</td>
              <td>{formatDate(item.occurredAt, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimedPracticeBest({ items }: { items: PersonalTimedPracticeResult[] }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  if (!items.length) return <EmptyState title={t('personalResults.noTimedResults')} />;
  return (
    <div className="table-wrap card personal-records-table">
      <table>
        <thead>
          <tr>
            <th>{t('leaderboard.rank')}</th>
            <th>{t('common.score')}</th>
            <th>{t('common.maxTile')}</th>
            <th>{t('results.validMoves')}</th>
            <th>{t('results.occurredAt')}</th>
            <th>{t('personalResults.endReason')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.id}>
              <td>{index + 1}</td>
              <td>{formatNumber(item.score, locale)}</td>
              <td>{formatNumber(item.maxTile, locale)}</td>
              <td>{formatNumber(item.validMoveCount, locale)}</td>
              <td>{formatDate(item.occurredAt, locale)}</td>
              <td>
                {t(
                  item.endReason === 'game_over'
                    ? 'practice.timedGameOver'
                    : 'practice.timedExpired',
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatchSummary<T>({ category }: { category: PersonalResultsCategory<T> }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  return (
    <div className="personal-period-grid">
      <section className="personal-period-panel">
        <header>
          <div>
            <span>{t('personalResults.currentPeriod')}</span>
            <strong>
              {category.currentPeriod?.period.name ?? t('personalResults.noActivePeriod')}
            </strong>
          </div>
          {category.currentPeriod ? (
            <small>
              {formatDate(category.currentPeriod.period.startAt, locale)} —{' '}
              {formatDate(category.currentPeriod.period.endAt, locale)}
            </small>
          ) : null}
        </header>
        {category.currentPeriod ? (
          <SummaryCards summary={category.currentPeriod.summary} />
        ) : (
          <p className="personal-period-empty">{t('personalResults.historyStillAvailable')}</p>
        )}
      </section>
      <section className="personal-period-panel">
        <header>
          <div>
            <span>{t('personalResults.history')}</span>
            <strong>{t('personalResults.allFormalMatches')}</strong>
          </div>
        </header>
        <SummaryCards summary={category.history.summary} />
      </section>
    </div>
  );
}

function DuelRecords({ category }: { category: PersonalResultsCategory<PersonalDuelResult> }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  return (
    <div className="personal-category-content">
      <MatchSummary category={category} />
      <h3>{t('personalResults.recentDetails')}</h3>
      {!category.history.items.length ? (
        <EmptyState title={t('personalResults.noDuelResults')} />
      ) : (
        <div className="table-wrap card personal-records-table">
          <table>
            <thead>
              <tr>
                <th>{t('results.occurredAt')}</th>
                <th>{t('results.room')}</th>
                <th>{t('personalResults.opponent')}</th>
                <th>{t('results.outcome')}</th>
                <th>{t('personalResults.points')}</th>
              </tr>
            </thead>
            <tbody>
              {category.history.items.map((item) => (
                <tr key={item.roomId}>
                  <td>{formatDate(item.occurredAt, locale)}</td>
                  <td>{item.roomName}</td>
                  <td>
                    {item.opponent
                      ? `${item.opponent.maskedName} · ${item.opponent.className} · ${item.opponent.studentNumberSuffix}`
                      : '—'}
                  </td>
                  <td>
                    <span className={`outcome outcome--${item.outcome}`}>
                      {t(`results.${item.outcome}`)}
                    </span>
                  </td>
                  <td>+{item.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TeamRecords({ category }: { category: PersonalResultsCategory<PersonalTeamMatchResult> }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  return (
    <div className="personal-category-content">
      <MatchSummary category={category} />
      <h3>{t('personalResults.recentDetails')}</h3>
      {!category.history.items.length ? (
        <EmptyState title={t('personalResults.noTeamResults')} />
      ) : (
        <div className="table-wrap card personal-records-table">
          <table>
            <thead>
              <tr>
                <th>{t('results.occurredAt')}</th>
                <th>{t('results.room')}</th>
                <th>{t('personalResults.myTeam')}</th>
                <th>{t('personalResults.opponentTeam')}</th>
                <th>{t('results.outcome')}</th>
                <th>{t('personalResults.points')}</th>
              </tr>
            </thead>
            <tbody>
              {category.history.items.map((item) => (
                <tr key={item.roomId}>
                  <td>{formatDate(item.occurredAt, locale)}</td>
                  <td>{item.roomName}</td>
                  <td>{item.team?.name ?? '—'}</td>
                  <td>{item.opponentTeam?.name ?? '—'}</td>
                  <td>
                    <span className={`outcome outcome--${item.outcome}`}>
                      {t(`results.${item.outcome}`)}
                    </span>
                  </td>
                  <td>+{item.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PersonalResults() {
  const { t } = useTranslation();
  const [categoryView, setCategoryView] = useState<PersonalCategoryView>('practice');
  const results = useApiData<PersonalResultsResponse>('/api/me/results');
  if (results.error) return <Alert message={results.error} />;
  if (results.loading) return <LoadingBlock />;
  if (!results.data) return <EmptyState title={t('results.noResults')} />;
  return (
    <div className="personal-results">
      <div
        className="tab-list tab-list--secondary personal-category-tabs"
        role="tablist"
        aria-label={t('personalResults.categoryView')}
      >
        {(['practice', 'duel', 'team'] as const).map((category) => (
          <button
            key={category}
            type="button"
            role="tab"
            className={`tab-button ${categoryView === category ? 'is-active' : ''}`}
            aria-selected={categoryView === category}
            onClick={() => setCategoryView(category)}
          >
            {t(`personalResults.${category}`)}
          </button>
        ))}
      </div>
      {categoryView === 'practice' ? (
        <div className="personal-category-content">
          <h3>{t('personalResults.unlimitedBest')}</h3>
          <p className="personal-category-note">{t('personalResults.practiceNote')}</p>
          <PracticeBest items={results.data.practiceBest} />
          <h3>{t('personalResults.timedBest')}</h3>
          <p className="personal-category-note">{t('personalResults.timedNote')}</p>
          <TimedPracticeBest items={results.data.timedPracticeBest ?? []} />
        </div>
      ) : categoryView === 'duel' ? (
        <DuelRecords category={results.data.duel} />
      ) : (
        <TeamRecords category={results.data.team} />
      )}
    </div>
  );
}

function CurrentPracticeLeaderboard() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [boardView, setBoardView] = useState<LeaderboardView>('grade');
  const leaderboard = useApiData<LeaderboardResponse>(
    '/api/leaderboard?type=practice&period=current',
  );

  if (leaderboard.error) {
    return (
      <>
        <Alert message={leaderboard.error} />
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void leaderboard.reload()}
        >
          {t('leaderboard.retry')}
        </button>
      </>
    );
  }
  if (leaderboard.loading) return <LoadingBlock />;
  if (!leaderboard.data || leaderboard.data.status === 'no_active_period') {
    return <EmptyState title={t('leaderboard.noActivePeriod')} />;
  }

  const board = boardView === 'overall' ? leaderboard.data.overall : leaderboard.data.grade;
  return (
    <div className="leaderboard-section">
      <section className="leaderboard-period card">
        <div>
          <span>{t('leaderboard.period')}</span>
          <strong>{leaderboard.data.period.name}</strong>
        </div>
        <small>
          {formatDate(leaderboard.data.period.startAt, locale)} —{' '}
          {formatDate(leaderboard.data.period.endAt, locale)}
        </small>
      </section>
      <p className="team-leaderboard-note">{t('leaderboard.legacyResultsNote')}</p>
      <div
        className="tab-list tab-list--secondary"
        role="tablist"
        aria-label={t('leaderboard.boardView')}
      >
        {(['overall', 'grade'] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            className={`tab-button ${boardView === view ? 'is-active' : ''}`}
            aria-selected={boardView === view}
            onClick={() => setBoardView(view)}
          >
            {t(view === 'overall' ? 'leaderboard.overall' : 'leaderboard.grade')}
          </button>
        ))}
      </div>
      {board.status === 'grade_missing' ? (
        <EmptyState title={t('leaderboard.gradeMissing')} />
      ) : (
        <>
          <div className="metric-grid metric-grid--leaderboard">
            <div className="card">
              <span>{t('leaderboard.participantCount')}</span>
              <strong>{formatNumber(board.participantCount, locale)}</strong>
            </div>
            <div className="card">
              <span>{t('leaderboard.myRank')}</span>
              <strong>
                {board.currentUserRank === null ? '—' : formatNumber(board.currentUserRank, locale)}
              </strong>
            </div>
          </div>
          <PracticeLeaderboardTable board={board} />
        </>
      )}
    </div>
  );
}

function TeamLeaderboard() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const leaderboard = useApiData<TeamLeaderboardResponse>('/api/leaderboard/teams');

  if (leaderboard.error) {
    return (
      <>
        <Alert message={leaderboard.error} />
        <button
          type="button"
          className="button button--ghost"
          onClick={() => void leaderboard.reload()}
        >
          {t('leaderboard.retry')}
        </button>
      </>
    );
  }
  if (leaderboard.loading) return <LoadingBlock />;
  if (!leaderboard.data || leaderboard.data.status === 'no_active_period') {
    return <EmptyState title={t('leaderboard.noActivePeriod')} />;
  }

  return (
    <div className="leaderboard-section">
      <section className="leaderboard-period card">
        <div>
          <span>{t('leaderboard.period')}</span>
          <strong>{leaderboard.data.period.name}</strong>
        </div>
        <small>
          {formatDate(leaderboard.data.period.startAt, locale)} —{' '}
          {formatDate(leaderboard.data.period.endAt, locale)}
        </small>
      </section>
      <p className="team-leaderboard-note">{t('leaderboard.legacyResultsNote')}</p>
      <p className="team-leaderboard-note">{t('leaderboard.teamNote')}</p>
      <div className="metric-grid metric-grid--leaderboard">
        <div className="card">
          <span>{t('leaderboard.participantTeamCount')}</span>
          <strong>{formatNumber(leaderboard.data.participantTeamCount, locale)}</strong>
        </div>
        <div className="card">
          <span>{t('leaderboard.myTeamRank')}</span>
          <strong>
            {leaderboard.data.currentUserTeamRank === null
              ? '—'
              : formatNumber(leaderboard.data.currentUserTeamRank, locale)}
          </strong>
        </div>
      </div>
      {leaderboard.data.entries.length === 0 ? (
        <EmptyState title={t('leaderboard.noResults')} />
      ) : (
        <div className="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>{t('leaderboard.rank')}</th>
                <th>{t('leaderboard.teamColumn')}</th>
                <th>{t('leaderboard.teamMemberCount')}</th>
                <th>{t('leaderboard.teamTotalScore')}</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.data.entries.map((entry) => (
                <Fragment key={`${entry.rank}-${entry.teamName}`}>
                  <tr className={entry.isCurrentUserTeam ? 'leaderboard-row--current' : undefined}>
                    <td>
                      <strong>{entry.rank}</strong>
                      {entry.isCurrentUserTeam ? (
                        <span className="current-user-mark">{t('leaderboard.me')}</span>
                      ) : null}
                    </td>
                    <td>
                      <span className="team-logo" aria-hidden="true">
                        {teamLogoGlyph(entry.teamLogo)}
                      </span>
                      <strong>{entry.teamName}</strong>
                    </td>
                    <td>{formatNumber(entry.memberCount, locale)}</td>
                    <td>
                      <strong>{formatNumber(entry.totalScore, locale)}</strong>
                    </td>
                  </tr>
                  {entry.members.map((member) => (
                    <tr
                      key={`${entry.teamName}-${member.studentNumberSuffix}-${member.maskedName}`}
                      className="team-member-row"
                    >
                      <td aria-hidden="true" />
                      <td colSpan={3}>
                        <span className="team-member-row__name">
                          {member.maskedName} · {member.studentNumberSuffix}
                          {member.isCurrentUser ? (
                            <span className="current-user-mark">{t('leaderboard.me')}</span>
                          ) : null}
                        </span>
                        <span>{formatNumber(member.score, locale)}</span>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StudentResultsPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<ResultsView>('personal');
  return (
    <>
      <PageHeader title={t('results.studentTitle')} subtitle={t('results.studentSubtitle')} />
      <ResultsTabs value={view} onChange={setView} />
      {view === 'personal' ? (
        <PersonalResults />
      ) : view === 'leaderboard' ? (
        <CurrentPracticeLeaderboard />
      ) : (
        <>
          <TeamLeaderboard />
          <TeamPracticePeriods />
        </>
      )}
    </>
  );
}
