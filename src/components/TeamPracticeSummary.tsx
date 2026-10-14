import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useApiData } from '../hooks/useApiData';
import { queryString } from '../lib/api';
import type { TeamPracticePeriod } from './TeamPracticePeriods';

export function TeamPracticeSummary() {
  const { t } = useTranslation();
  const periods = useApiData<{ items: TeamPracticePeriod[] }>('/api/teacher/team-practice-periods');
  const current = periods.data?.items.find((period) => period.status === 'open');
  return (
    <section className="team-practice-summary card" aria-label={t('teamPractice.pageTitle')}>
      <span>
        {periods.error
          ? t('teamPractice.summaryError')
          : periods.loading
            ? t('common.loading')
            : current
              ? `${t('teamPractice.currentPeriod', { name: current.name })} · ${t('teamPractice.status.open')}`
              : t('teamPractice.noOpenPeriod')}
      </span>
      <Link
        className="text-button"
        to={`/teacher/team-practice${queryString({ periodId: current?.id })}`}
      >
        {t('teamPractice.manage')}
      </Link>
    </section>
  );
}
