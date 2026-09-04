import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GradeLevel,
  LeaderboardPeriod,
  TeacherPracticeLeaderboardResponse,
} from '../../../shared/types';
import { gradeLevels } from '../../../shared/types';
import {
  Alert,
  EmptyState,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
  StatusBadge,
} from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { currentLocale } from '../../i18n';
import { api, queryString } from '../../lib/api';
import { formatClock, formatDate, formatNumber } from '../../lib/format';

interface ResultRow {
  room_id: string;
  room_code: string;
  room_name: string;
  mode: 'duel' | 'team_3v3';
  duration_minutes: number;
  finished_at: number;
  student_no: string;
  display_name: string;
  class_name: string;
  team_name: string | null;
  score: number;
  team_total_score: number;
  max_tile: number;
  outcome: 'win' | 'loss' | 'draw';
}

interface ResultPage {
  items: ResultRow[];
  total: number;
  pageSize: number;
}

interface ResultDetail {
  result: {
    id: string;
    code: string;
    name: string;
    mode: 'duel' | 'team_3v3';
    duration_minutes: number;
    starts_at: number;
    finished_at: number;
    finish_reason: 'time_limit' | 'all_game_over';
    winner_side: 'A' | 'B' | 'draw';
    players: Array<{
      user_id: string;
      side: 'A' | 'B';
      student_no: string;
      display_name: string;
      class_name: string;
      team_name: string | null;
      score: number;
      team_total_score: number;
      max_tile: number;
      valid_move_count: number;
      outcome: 'win' | 'loss' | 'draw';
    }>;
  };
}

function ResultDetails({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const details = useApiData<ResultDetail>(`/api/teacher/results/${roomId}`);
  const result = details.data?.result;
  return (
    <Modal title={result?.name ?? t('results.detailTitle')} onClose={onClose} wide>
      {details.loading ? <LoadingBlock /> : null}
      {details.error ? <Alert message={details.error} /> : null}
      {result ? (
        <div className="result-details">
          <div className="metric-grid metric-grid--compact">
            <div>
              <span>{t('results.mode')}</span>
              <strong>{t(`mode.${result.mode}`)}</strong>
            </div>
            <div>
              <span>{t('results.configuredDuration')}</span>
              <strong>
                {result.duration_minutes} {t('common.minutes')}
              </strong>
            </div>
            <div>
              <span>{t('results.actualDuration')}</span>
              <strong>{formatClock(result.finished_at - result.starts_at)}</strong>
            </div>
            <div>
              <span>{t('results.finishReason')}</span>
              <strong>{t(`results.${result.finish_reason}`)}</strong>
            </div>
          </div>
          <p className="result-details__time">
            {t('results.startedAt')}: {formatDate(result.starts_at, locale)} ·{' '}
            {t('results.finishedAt')}: {formatDate(result.finished_at, locale)}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('results.side')}</th>
                  <th>{t('results.student')}</th>
                  <th>{t('results.className')}</th>
                  <th>{t('results.team')}</th>
                  <th>{t('results.personalScore')}</th>
                  <th>{t('results.teamScore')}</th>
                  <th>{t('results.maxTile')}</th>
                  <th>{t('results.validMoves')}</th>
                  <th>{t('results.outcome')}</th>
                </tr>
              </thead>
              <tbody>
                {result.players.map((player) => (
                  <tr key={player.user_id}>
                    <td>{player.side}</td>
                    <td>
                      <strong>{player.display_name}</strong>
                      <small className="table-subtext">{player.student_no}</small>
                    </td>
                    <td>{player.class_name}</td>
                    <td>{player.team_name ?? '—'}</td>
                    <td>{formatNumber(player.score, locale)}</td>
                    <td>{formatNumber(player.team_total_score, locale)}</td>
                    <td>{formatNumber(player.max_tile, locale)}</td>
                    <td>{formatNumber(player.valid_move_count, locale)}</td>
                    <td>
                      <span className={`outcome outcome--${player.outcome}`}>
                        {t(`results.${player.outcome}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

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

function PracticeLeaderboardManager() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const periods = useApiData<{ items: LeaderboardPeriod[] }>('/api/teacher/leaderboard-periods');
  const [selectedPeriodId, setSelectedPeriodId] = useState('');
  const [gradeLevel, setGradeLevel] = useState('');
  const [editorPeriod, setEditorPeriod] = useState<LeaderboardPeriod | null | undefined>(undefined);
  const [notice, setNotice] = useState('');

  const effectivePeriodId = periods.data?.items.some((period) => period.id === selectedPeriodId)
    ? selectedPeriodId
    : (periods.data?.items.find((period) => period.status === 'active')?.id ??
      periods.data?.items[0]?.id ??
      '');

  const rankingPath = effectivePeriodId
    ? `/api/teacher/leaderboards/practice${queryString({
        periodId: effectivePeriodId,
        gradeLevel,
      })}`
    : null;
  const ranking = useApiData<TeacherPracticeLeaderboardResponse>(rankingPath);

  return (
    <>
      {notice ? <Alert message={notice} tone="success" /> : null}
      {periods.error ? <Alert message={periods.error} /> : null}
      <section className="leaderboard-admin-toolbar card">
        <label className="field">
          <span>{t('leaderboard.selectPeriod')}</span>
          <select
            value={effectivePeriodId}
            onChange={(event) => setSelectedPeriodId(event.target.value)}
          >
            {!periods.data?.items.length ? (
              <option value="">{t('leaderboard.noPeriods')}</option>
            ) : null}
            {periods.data?.items.map((period) => (
              <option key={period.id} value={period.id}>
                {period.name} · {t(`status.${period.status}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('leaderboard.gradeFilter')}</span>
          <select value={gradeLevel} onChange={(event) => setGradeLevel(event.target.value)}>
            <option value="">{t('leaderboard.allGrades')}</option>
            {gradeLevels.map((grade) => (
              <option key={grade} value={grade}>
                {t('leaderboard.gradeLabel', { grade })}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button button--primary"
          onClick={() => setEditorPeriod(null)}
        >
          {t('leaderboard.createPeriod')}
        </button>
      </section>

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
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setSelectedPeriodId(period.id)}
                      >
                        {period.name}
                      </button>
                    </td>
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

      {ranking.error ? <Alert message={ranking.error} /> : null}
      {ranking.loading ? <LoadingBlock /> : null}
      {ranking.data ? (
        <section className="leaderboard-ranking">
          <div className="leaderboard-ranking__header">
            <div>
              <h2>{ranking.data.period.name}</h2>
              <p>
                {gradeLevel
                  ? t('leaderboard.gradeLabel', { grade: Number(gradeLevel) as GradeLevel })
                  : t('leaderboard.allGrades')}
              </p>
            </div>
            <strong>
              {t('leaderboard.participantSummary', {
                count: ranking.data.participantCount,
              })}
            </strong>
          </div>
          {ranking.data.entries.length ? (
            <div className="table-wrap card">
              <table>
                <thead>
                  <tr>
                    <th>{t('leaderboard.rank')}</th>
                    <th>{t('users.studentNumber')}</th>
                    <th>{t('users.name')}</th>
                    <th>{t('users.className')}</th>
                    <th>{t('users.grade')}</th>
                    <th>{t('common.score')}</th>
                    <th>{t('common.maxTile')}</th>
                    <th>{t('results.validMoves')}</th>
                    <th>{t('leaderboard.completedAt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.data.entries.map((entry) => (
                    <tr key={entry.studentId}>
                      <td>
                        <strong>{entry.rank}</strong>
                      </td>
                      <td>{entry.studentNumber}</td>
                      <td>{entry.name}</td>
                      <td>{entry.className}</td>
                      <td>
                        {entry.gradeLevel === null
                          ? '—'
                          : t('leaderboard.gradeLabel', { grade: entry.gradeLevel })}
                      </td>
                      <td>{formatNumber(entry.score, locale)}</td>
                      <td>{formatNumber(entry.maxTile, locale)}</td>
                      <td>{formatNumber(entry.validMoveCount, locale)}</td>
                      <td>{formatDate(entry.endedAt, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title={t('leaderboard.noResults')} />
          )}
        </section>
      ) : null}

      {editorPeriod !== undefined ? (
        <PeriodEditor
          period={editorPeriod}
          onClose={() => setEditorPeriod(undefined)}
          onSaved={(saved, message) => {
            setEditorPeriod(undefined);
            setSelectedPeriodId(saved.id);
            setNotice(message);
            void periods.reload();
            void ranking.reload();
          }}
        />
      ) : null}
    </>
  );
}

export function TeacherResultsPage() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [view, setView] = useState<'matches' | 'leaderboard'>('matches');
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState('');
  const [query, setQuery] = useState('');
  const [className, setClassName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const filters = useMemo(
    () => ({ mode, query, className, from, to }),
    [mode, query, className, from, to],
  );
  const path = useMemo(
    () =>
      view === 'matches'
        ? `/api/teacher/results${queryString({ page, pageSize: 20, ...filters })}`
        : null,
    [filters, page, view],
  );
  const exportQuery = queryString(filters);
  const results = useApiData<ResultPage>(path);

  return (
    <>
      <PageHeader
        title={t('results.title')}
        subtitle={t(view === 'matches' ? 'results.subtitle' : 'leaderboard.teacherSubtitle')}
        actions={
          view === 'matches' ? (
            <div className="button-group">
              <a
                className="button button--ghost"
                href={`/api/teacher/results/export.csv${exportQuery}`}
              >
                {t('results.exportCsv')}
              </a>
              <a
                className="button button--primary"
                href={`/api/teacher/results/export.xlsx${exportQuery}`}
              >
                {t('results.exportXlsx')}
              </a>
            </div>
          ) : undefined
        }
      />
      <div className="tab-list" role="tablist" aria-label={t('leaderboard.teacherResultsView')}>
        {(['matches', 'leaderboard'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            className={`tab-button ${view === item ? 'is-active' : ''}`}
            aria-selected={view === item}
            onClick={() => setView(item)}
          >
            {t(item === 'matches' ? 'leaderboard.matchResults' : 'leaderboard.practiceLeaderboard')}
          </button>
        ))}
      </div>
      {view === 'leaderboard' ? (
        <PracticeLeaderboardManager />
      ) : (
        <>
          <section className="toolbar toolbar--wrap card">
            <input
              value={query}
              placeholder={t('common.search')}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
            <select
              value={mode}
              aria-label={t('results.mode')}
              onChange={(event) => {
                setMode(event.target.value);
                setPage(1);
              }}
            >
              <option value="">{t('common.all')}</option>
              <option value="duel">{t('mode.duel')}</option>
              <option value="team_3v3">{t('mode.team_3v3')}</option>
            </select>
            <input
              value={className}
              placeholder={t('results.classFilter')}
              onChange={(event) => {
                setClassName(event.target.value);
                setPage(1);
              }}
            />
            <label className="inline-field">
              <span>{t('results.from')}</span>
              <input
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setPage(1);
                }}
              />
            </label>
            <label className="inline-field">
              <span>{t('results.to')}</span>
              <input
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  setPage(1);
                }}
              />
            </label>
          </section>
          {results.error ? <Alert message={results.error} /> : null}
          {results.loading ? (
            <LoadingBlock />
          ) : results.data?.items.length ? (
            <>
              <div className="table-wrap card">
                <table>
                  <thead>
                    <tr>
                      <th>{t('results.room')}</th>
                      <th>{t('results.mode')}</th>
                      <th>{t('results.configuredDuration')}</th>
                      <th>{t('results.student')}</th>
                      <th>{t('results.className')}</th>
                      <th>{t('results.team')}</th>
                      <th>{t('results.personalScore')}</th>
                      <th>{t('results.teamScore')}</th>
                      <th>{t('results.maxTile')}</th>
                      <th>{t('results.outcome')}</th>
                      <th>{t('results.occurredAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.data.items.map((result, index) => (
                      <tr key={`${result.room_id}-${result.student_no}-${index}`}>
                        <td>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => setDetailId(result.room_id)}
                          >
                            {result.room_name}
                          </button>
                          <small className="table-subtext">{result.room_code}</small>
                        </td>
                        <td>{t(`mode.${result.mode}`)}</td>
                        <td>
                          {result.duration_minutes} {t('common.minutes')}
                        </td>
                        <td>
                          <strong>{result.display_name}</strong>
                          <small className="table-subtext">{result.student_no}</small>
                        </td>
                        <td>{result.class_name}</td>
                        <td>{result.team_name ?? '—'}</td>
                        <td>{formatNumber(result.score, locale)}</td>
                        <td>{formatNumber(result.team_total_score, locale)}</td>
                        <td>{result.max_tile}</td>
                        <td>
                          <span className={`outcome outcome--${result.outcome}`}>
                            {t(`results.${result.outcome}`)}
                          </span>
                        </td>
                        <td>{formatDate(result.finished_at, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={page}
                total={results.data.total}
                pageSize={results.data.pageSize}
                onPage={setPage}
              />
            </>
          ) : (
            <EmptyState title={t('results.noResults')} />
          )}
          {detailId ? <ResultDetails roomId={detailId} onClose={() => setDetailId(null)} /> : null}
        </>
      )}
    </>
  );
}
