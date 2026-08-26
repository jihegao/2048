import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  EmptyState,
  LoadingBlock,
  Modal,
  PageHeader,
  Pagination,
} from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { currentLocale } from '../../i18n';
import { queryString } from '../../lib/api';
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

export function TeacherResultsPage() {
  const { t } = useTranslation();
  const locale = currentLocale();
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
    () => `/api/teacher/results${queryString({ page, pageSize: 20, ...filters })}`,
    [filters, page],
  );
  const exportQuery = queryString(filters);
  const results = useApiData<ResultPage>(path);

  return (
    <>
      <PageHeader
        title={t('results.title')}
        subtitle={t('results.subtitle')}
        actions={
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
        }
      />
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
  );
}
