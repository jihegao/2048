import { useTranslation } from 'react-i18next';
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

export function StudentResultsPage() {
  const { t } = useTranslation();
  const locale = currentLocale();
  const results = useApiData<{ items: PersonalResult[] }>('/api/me/results');
  return (
    <>
      <PageHeader title={t('results.studentTitle')} subtitle={t('results.studentSubtitle')} />
      {results.error ? <Alert message={results.error} /> : null}
      {results.loading ? (
        <LoadingBlock />
      ) : results.data?.items.length ? (
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
      ) : (
        <EmptyState title={t('results.noResults')} />
      )}
    </>
  );
}
