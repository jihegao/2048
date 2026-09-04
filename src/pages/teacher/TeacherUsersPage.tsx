import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GradeLevel } from '../../../shared/types';
import { ImportDialog } from '../../components/ImportDialog';
import { Alert, EmptyState, LoadingBlock, PageHeader, Pagination } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { api, queryString } from '../../lib/api';

interface StudentRow {
  id: string;
  student_no: string;
  display_name: string;
  class_name: string;
  grade_level: GradeLevel | null;
  locale: 'zh-CN' | 'en' | null;
  team_name: string | null;
}

interface UserPage {
  items: StudentRow[];
  total: number;
  pageSize: number;
}

export function TeacherUsersPage() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(new Set<string>());
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const path = useMemo(
    () => `/api/teacher/users${queryString({ page, pageSize: 20, query })}`,
    [page, query],
  );
  const users = useApiData<UserPage>(path);

  const reset = async (ids: string[]) => {
    if (!window.confirm(t('users.confirmReset'))) return;
    try {
      const response =
        ids.length === 1
          ? await api<{ message: string }>(`/api/teacher/users/${ids[0]}/reset-password`, {
              method: 'POST',
            })
          : await api<{ message: string }>('/api/teacher/users/reset-passwords', {
              method: 'POST',
              body: JSON.stringify({ userIds: ids }),
            });
      setNotice({ message: response.message, error: false });
      setSelected(new Set());
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    }
  };

  const allVisibleSelected =
    Boolean(users.data?.items.length) && users.data!.items.every((user) => selected.has(user.id));
  return (
    <>
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <button
            type="button"
            className="button button--primary"
            onClick={() => setImportOpen(true)}
          >
            {t('users.import')}
          </button>
        }
      />
      {notice ? <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} /> : null}
      <section className="toolbar card">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder={t('users.searchPlaceholder')}
        />
        {selected.size ? (
          <button
            type="button"
            className="button button--danger"
            onClick={() => void reset([...selected])}
          >
            {t('users.resetSelected')} · {t('users.selectedCount', { count: selected.size })}
          </button>
        ) : null}
      </section>
      {users.error ? <Alert message={users.error} /> : null}
      {users.loading ? (
        <LoadingBlock />
      ) : users.data?.items.length ? (
        <>
          <div className="table-wrap card">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={t('a11y.selectAll')}
                      checked={allVisibleSelected}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          users.data?.items.forEach((user) => {
                            if (event.target.checked) next.add(user.id);
                            else next.delete(user.id);
                          });
                          return next;
                        })
                      }
                    />
                  </th>
                  <th>{t('users.studentNumber')}</th>
                  <th>{t('users.name')}</th>
                  <th>{t('users.className')}</th>
                  <th>{t('users.grade')}</th>
                  <th>{t('users.team')}</th>
                  <th>{t('users.locale')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t('a11y.selectStudent', { name: user.display_name })}
                        checked={selected.has(user.id)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(user.id);
                            else next.delete(user.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td>{user.student_no}</td>
                    <td>
                      <strong>{user.display_name}</strong>
                    </td>
                    <td>{user.class_name}</td>
                    <td>
                      {user.grade_level === null
                        ? '—'
                        : t('leaderboard.gradeLabel', { grade: user.grade_level })}
                    </td>
                    <td>{user.team_name ?? t('users.noTeam')}</td>
                    <td>
                      {user.locale
                        ? t(user.locale === 'en' ? 'common.english' : 'common.chinese')
                        : '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => void reset([user.id])}
                      >
                        {t('users.resetPassword')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            total={users.data.total}
            pageSize={users.data.pageSize}
            onPage={setPage}
          />
        </>
      ) : (
        <EmptyState title={t('users.noUsers')} />
      )}
      {importOpen ? (
        <ImportDialog
          kind="users"
          onClose={() => setImportOpen(false)}
          onImported={(message) => {
            setNotice({ message, error: false });
            void users.reload();
          }}
        />
      ) : null}
    </>
  );
}
