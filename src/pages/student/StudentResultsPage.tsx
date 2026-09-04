import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  StudentPracticeLeaderboardBoard,
  StudentPracticeLeaderboardResponse,
  StudentPracticeLeaderboardUnavailableResponse,
} from '../../../shared/types';
import { Alert, EmptyState, LoadingBlock, PageHeader } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { currentLocale } from '../../i18n';
import { formatDate, formatNumber } from '../../lib/format';

interface PersonalResult {
  id: string;
  type: 'match' | 'practice';
  occurred_at: number;
  room_name?: string;
  mode?: 'duel' | 'team_3v3';
  score: number;
  max_tile: number;
  outcome?: 'win' | 'loss' | 'draw';
  team_total_score?: number;
  valid_move_count?: number;
}

type ResultsView = 'personal' | 'leaderboard';
type LeaderboardView = 'overall' | 'grade';
type LeaderboardResponse =
  StudentPracticeLeaderboardResponse | StudentPracticeLeaderboardUnavailableResponse;

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
      {(['personal', 'leaderboard'] as const).map((view) => (
        <button
          key={view}
          type="button"
          role="tab"
          className={`tab-button ${value === view ? 'is-active' : ''}`}
          aria-selected={value === view}
          onClick={() => onChange(view)}
        >
          {t(view === 'personal' ? 'leaderboard.myRecords' : 'leaderboard.currentPractice')}
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

function PersonalResults() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const results = useApiData<{ items: PersonalResult[] }>('/api/me/results');
  if (results.error) return <Alert message={results.error} />;
  if (results.loading) return <LoadingBlock />;
  if (!results.data?.items.length) return <EmptyState title={t('results.noResults')} />;
  return (
    <div className="result-card-grid">
      {results.data.items.map((result) => (
        <article className="result-card card" key={`${result.type}-${result.id}`}>
          <header>
            <span className={`result-type result-type--${result.type}`}>
              {t(`results.${result.type}`)}
            </span>
            <time>{formatDate(result.occurred_at, locale)}</time>
          </header>
          <h2>{result.type === 'match' ? result.room_name : t('practice.title')}</h2>
          <div className="score-strip">
            <div>
              <span>{t('common.score')}</span>
              <strong>{formatNumber(result.score, locale)}</strong>
            </div>
            <div>
              <span>{t('common.maxTile')}</span>
              <strong>{result.max_tile}</strong>
            </div>
          </div>
          <footer>
            {result.type === 'match' ? (
              <>
                <span>{result.mode ? t(`mode.${result.mode}`) : ''}</span>
                <span className={`outcome outcome--${result.outcome}`}>
                  {result.outcome ? t(`results.${result.outcome}`) : ''}
                </span>
              </>
            ) : (
              <span>
                {t('results.moveCount')}: {result.valid_move_count}
              </span>
            )}
          </footer>
        </article>
      ))}
    </div>
  );
}

function CurrentPracticeLeaderboard() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [boardView, setBoardView] = useState<LeaderboardView>('overall');
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

export function StudentResultsPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<ResultsView>('personal');
  return (
    <>
      <PageHeader title={t('results.studentTitle')} subtitle={t('results.studentSubtitle')} />
      <ResultsTabs value={view} onChange={setView} />
      {view === 'personal' ? <PersonalResults /> : <CurrentPracticeLeaderboard />}
    </>
  );
}
