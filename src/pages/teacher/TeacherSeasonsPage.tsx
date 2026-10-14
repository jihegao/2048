import { useTranslation } from 'react-i18next';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { IndividualSeasons } from '../../components/IndividualSeasons';
import { TeamPracticePeriods } from '../../components/TeamPracticePeriods';
import { PageHeader } from '../../components/ui';

export function TeacherSeasonsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') === 'individual' ? 'individual' : 'team';
  return (
    <>
      <PageHeader
        title={t('seasons.title')}
        subtitle={t('seasons.note')}
        actions={
          <Link className="button button--ghost" to="/teacher/results">
            {t('nav.teacherResults')}
          </Link>
        }
      />
      <div className="tab-list season-type-tabs" role="tablist" aria-label={t('seasons.type')}>
        {(['team', 'individual'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            className={`tab-button ${type === value ? 'is-active' : ''}`}
            aria-selected={type === value}
            onClick={() => setParams({ type: value })}
          >
            {t(value === 'team' ? 'seasons.team' : 'seasons.individual')}
          </button>
        ))}
      </div>
      {type === 'team' ? <TeamPracticePeriods teacher /> : <IndividualSeasons />}
    </>
  );
}

export function LegacyTeamPracticeRedirect() {
  const [params] = useSearchParams();
  const view = params.get('view');
  const next = new URLSearchParams();
  const results = view === 'standings' || view === 'matches';
  if (results) next.set('view', view === 'standings' ? 'teamStandings' : 'teamMatches');
  else next.set('type', 'team');
  const periodId = params.get('periodId');
  if (periodId) next.set('periodId', periodId);
  return <Navigate to={`${results ? '/teacher/results' : '/teacher/seasons'}?${next}`} replace />;
}
