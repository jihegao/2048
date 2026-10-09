import { downloadOfflineTournament } from '../../lib/offline-export';
import { TeamLogo } from '../../components/TeamLogo';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImportDialog } from '../../components/ImportDialog';
import { Alert, EmptyState, LoadingBlock, PageHeader, Pagination } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { api, queryString } from '../../lib/api';

interface TeamRow {
  id: string;
  name: string;
  code: string;
  logo: string | null;
  creator_id: string | null;
  frozen: number;
  group: string | null;
  members: Array<{ id: string; student_no: string; display_name: string; class_name: string }>;
}

interface TeamPage {
  items: TeamRow[];
  total: number;
  pageSize: number;
}

interface GroupAudit {
  total: number;
  items: Array<{
    id: string;
    name: string;
    problem: 'unresolved' | 'mixed';
    members: Array<{
      studentNumber: string;
      name: string;
      rawGradeLevel: number | null;
      rawGradeCode: string | null;
      teamGroup: string | null;
    }>;
  }>;
}

export function TeacherTeamsPage() {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const path = useMemo(
    () => `/api/teacher/teams${queryString({ page, pageSize: 20, query })}`,
    [page, query],
  );
  const teams = useApiData<TeamPage>(path);
  const audit = useApiData<GroupAudit>('/api/teacher/teams/audit/groups');

  const exportTeams = async () => {
    setExporting(true);
    try {
      await downloadOfflineTournament();
      setNotice({ message: t('teams.offlineExported'), error: false });
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setExporting(false);
    }
  };

  const remove = async (teamId: string, userId?: string) => {
    if (!userId && !window.confirm(t('teams.confirmClear'))) return;
    try {
      const response = await api<{ message: string }>(
        userId
          ? `/api/teacher/teams/${teamId}/members/${userId}`
          : `/api/teacher/teams/${teamId}/members`,
        { method: 'DELETE' },
      );
      setNotice({ message: response.message, error: false });
      await teams.reload();
      await audit.reload();
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    }
  };

  return (
    <>
      <PageHeader
        title={t('teams.title')}
        subtitle={t('teams.subtitle')}
        actions={
          <>
            <button
              type="button"
              className="button button--ghost"
              disabled={exporting}
              onClick={() => void exportTeams()}
            >
              {t(exporting ? 'teams.offlineExporting' : 'teams.offlineExport')}
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => setImportOpen(true)}
            >
              {t('teams.import')}
            </button>
          </>
        }
      />
      {notice ? <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} /> : null}
      {audit.data?.total ? (
        <section className="card">
          <h2>{t('teams.groupAudit', { count: audit.data.total })}</h2>
          <p>{t('teams.groupAuditHint')}</p>
          <ul>
            {audit.data.items.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong> ·{' '}
                {t(item.problem === 'mixed' ? 'teams.groupMixed' : 'teams.groupPending')}:{' '}
                {item.members
                  .map(
                    (member) =>
                      `${member.name} (${member.studentNumber}, ${member.rawGradeCode ?? member.rawGradeLevel ?? '—'} → ${member.teamGroup ?? '?'})`,
                  )
                  .join('；')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="toolbar card">
        <input
          value={query}
          placeholder={t('teams.searchPlaceholder')}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
      </section>
      {teams.error ? <Alert message={teams.error} /> : null}
      {teams.loading ? (
        <LoadingBlock />
      ) : teams.data?.items.length ? (
        <>
          <div className="team-admin-grid">
            {teams.data.items.map((team) => (
              <article key={team.id} className="team-admin-card card">
                <header>
                  <div>
                    <h2>
                      <span className="team-logo" aria-hidden="true">
                        <TeamLogo logo={team.logo} />
                      </span>
                      {team.name}
                    </h2>
                    <small>
                      {team.code} ·{' '}
                      {team.group
                        ? t('teams.groupLabel', { group: team.group })
                        : t('teams.groupPending')}{' '}
                      ·{' '}
                      <span
                        className={`team-origin ${team.creator_id ? 'is-student' : 'is-teacher'}`}
                      >
                        {t(team.creator_id ? 'teams.studentCreated' : 'teams.teacherManaged')}
                      </span>
                    </small>
                  </div>
                  <span
                    className={`member-count ${team.members.length === 3 ? 'is-complete' : ''}`}
                  >
                    {t('teams.memberCount', { count: team.members.length })}
                  </span>
                </header>
                {team.frozen ? <Alert message={t('teams.frozen')} tone="info" /> : null}
                <ul className="member-list">
                  {team.members.map((member) => (
                    <li key={member.id}>
                      <div>
                        <strong>{member.display_name}</strong>
                        <small>
                          {member.student_no} · {member.class_name}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="text-button text-button--danger"
                        disabled={Boolean(team.frozen)}
                        onClick={() => void remove(team.id, member.id)}
                      >
                        {t('teams.removeMember')}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="button button--ghost button--full"
                  disabled={Boolean(team.frozen) || team.members.length === 0}
                  onClick={() => void remove(team.id)}
                >
                  {t('teams.clearMembers')}
                </button>
              </article>
            ))}
          </div>
          <Pagination
            page={page}
            total={teams.data.total}
            pageSize={teams.data.pageSize}
            onPage={setPage}
          />
        </>
      ) : (
        <EmptyState title={t('teams.noTeams')} />
      )}
      {importOpen ? (
        <ImportDialog
          kind="teams"
          onClose={() => setImportOpen(false)}
          onImported={(message) => {
            setNotice({ message, error: false });
            void teams.reload();
            void audit.reload();
          }}
        />
      ) : null}
    </>
  );
}
