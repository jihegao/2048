import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Alert, Card, LoadingBlock, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';

interface Counts {
  activeRooms: number;
  students: number;
  teams: number;
  results: number;
}

export function TeacherHomePage() {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void Promise.all([
      api<{ total: number }>('/api/teacher/rooms?pageSize=1&status=live'),
      api<{ total: number }>('/api/teacher/users?pageSize=1'),
      api<{ total: number }>('/api/teacher/teams?pageSize=1'),
      api<{ total: number }>('/api/teacher/results?pageSize=1'),
    ])
      .then(([rooms, users, teams, results]) =>
        setCounts({
          activeRooms: rooms.total,
          students: users.total,
          teams: teams.total,
          results: results.total,
        }),
      )
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, []);
  return (
    <>
      <PageHeader title={t('home.teacherTitle')} subtitle={t('home.teacherSubtitle')} />
      {error ? <Alert message={error} /> : null}
      {!counts ? (
        <LoadingBlock />
      ) : (
        <div className="metric-grid">
          <Card>
            <span>{t('home.activeRooms')}</span>
            <strong>{counts.activeRooms}</strong>
          </Card>
          <Card>
            <span>{t('home.studentCount')}</span>
            <strong>{counts.students}</strong>
          </Card>
          <Card>
            <span>{t('home.teamCount')}</span>
            <strong>{counts.teams}</strong>
          </Card>
          <Card>
            <span>{t('home.recentMatchCount')}</span>
            <strong>{counts.results}</strong>
          </Card>
        </div>
      )}
      <section className="quick-section">
        <h2>{t('home.quickActions')}</h2>
        <div className="quick-grid">
          <Link className="quick-card" to="/teacher/rooms">
            <span className="quick-card__icon">▦</span>
            <strong>{t('home.manageRooms')}</strong>
          </Link>
          <Link className="quick-card" to="/teacher/users">
            <span className="quick-card__icon">♙</span>
            <strong>{t('home.importStudents')}</strong>
          </Link>
          <Link className="quick-card" to="/teacher/results">
            <span className="quick-card__icon">≡</span>
            <strong>{t('results.title')}</strong>
          </Link>
        </div>
      </section>
    </>
  );
}
