import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { TeamPracticePeriods } from '../../components/TeamPracticePeriods';
import { PageHeader } from '../../components/ui';

export function TeacherTeamPracticePage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader
        title={t('teamPractice.pageTitle')}
        subtitle={t('teamPractice.note')}
        actions={
          <Link className="button button--ghost" to="/teacher/rooms">
            {t('nav.teacherRooms')}
          </Link>
        }
      />
      <TeamPracticePeriods teacher />
    </>
  );
}
