import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { presetTeamLogos, teamLogoGlyph, type TeamLogoId } from '../../../shared/types';
import { Alert, Card, EmptyState, LoadingBlock, PageHeader } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { api, queryString } from '../../lib/api';

interface Team {
  id: string;
  name: string;
  code: string;
  logo: string | null;
  isOwner: boolean;
  frozen: number;
  members: Array<{ id: string; student_no: string; display_name: string; class_name: string }>;
}

interface SearchTeam {
  id: string;
  name: string;
  code: string;
  logo: string | null;
  member_count: number;
}

export function StudentTeamPage() {
  const { t } = useTranslation();
  const current = useApiData<{ team: Team | null }>('/api/me/team');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchTeam[]>([]);
  const [searched, setSearched] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [createName, setCreateName] = useState('');
  const [createLogo, setCreateLogo] = useState<TeamLogoId>(presetTeamLogos[0].id);
  const [busy, setBusy] = useState(false);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const response = await api<{ items: SearchTeam[] }>(
        `/api/teams/search${queryString({ query })}`,
      );
      setResults(response.items);
      setSearched(true);
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    }
  };

  const join = async (teamId: string) => {
    try {
      const response = await api<{ message: string }>(`/api/teams/${teamId}/join`, {
        method: 'POST',
      });
      setNotice({ message: response.message, error: false });
      setResults([]);
      await current.reload();
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    }
  };

  const leave = async () => {
    if (!window.confirm(t('teams.confirmLeave'))) return;
    try {
      const response = await api<{ message: string }>('/api/me/team', { method: 'DELETE' });
      setNotice({ message: response.message, error: false });
      await current.reload();
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await api<{ message: string }>('/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: createName.trim(), logo: createLogo }),
      });
      setNotice({ message: response.message, error: false });
      setCreateName('');
      await current.reload();
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!current.data?.team || !window.confirm(t('teams.confirmDelete'))) return;
    setBusy(true);
    try {
      const response = await api<{ message: string }>(`/api/teams/${current.data.team.id}`, {
        method: 'DELETE',
      });
      setNotice({ message: response.message, error: false });
      await current.reload();
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('teams.studentTitle')} subtitle={t('teams.studentSubtitle')} />
      {notice ? <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} /> : null}
      {current.loading ? (
        <LoadingBlock />
      ) : current.error ? (
        <Alert message={current.error} />
      ) : current.data?.team ? (
        <Card className="my-team-card">
          <header>
            <div>
              <h2>
                <span className="team-logo" aria-hidden="true">
                  {teamLogoGlyph(current.data.team.logo)}
                </span>
                {current.data.team.name}
              </h2>
              <small>{current.data.team.code}</small>
            </div>
            <span className="member-count is-complete">
              {t('teams.memberCount', { count: current.data.team.members.length })}
            </span>
          </header>
          {current.data.team.frozen ? <Alert message={t('teams.frozen')} tone="info" /> : null}
          <ul className="member-list">
            {current.data.team.members.map((member) => (
              <li key={member.id}>
                <div>
                  <strong>{member.display_name}</strong>
                  <small>
                    {member.student_no} · {member.class_name}
                  </small>
                </div>
              </li>
            ))}
          </ul>
          <p className="team-hint">{t('teams.fullTeamHint')}</p>
          {current.data.team.isOwner ? (
            <button
              type="button"
              className="button button--danger"
              disabled={Boolean(current.data.team.frozen) || busy}
              onClick={() => void remove()}
            >
              {busy ? t('teams.deleting') : t('teams.deleteTeam')}
            </button>
          ) : (
            <button
              type="button"
              className="button button--danger"
              disabled={Boolean(current.data.team.frozen)}
              onClick={() => void leave()}
            >
              {t('teams.leave')}
            </button>
          )}
        </Card>
      ) : (
        <>
          <EmptyState title={t('teams.noTeam')} />
          <Card>
            <h2 className="team-create-title">{t('teams.createTitle')}</h2>
            <form className="stack-form" onSubmit={(event) => void create(event)}>
              <label className="field">
                <span>{t('teams.name')}</span>
                <input
                  required
                  value={createName}
                  maxLength={80}
                  placeholder={t('teams.namePlaceholder')}
                  onChange={(event) => setCreateName(event.target.value)}
                />
              </label>
              <div className="field">
                <span>{t('teams.logoLabel')}</span>
                <div className="logo-picker" role="radiogroup" aria-label={t('teams.logoLabel')}>
                  {presetTeamLogos.map((logo) => (
                    <button
                      key={logo.id}
                      type="button"
                      role="radio"
                      aria-checked={createLogo === logo.id}
                      aria-label={logo.id}
                      className={`logo-option ${createLogo === logo.id ? 'is-selected' : ''}`}
                      onClick={() => setCreateLogo(logo.id)}
                    >
                      <span aria-hidden="true">{logo.glyph}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" className="button button--primary" disabled={busy}>
                  {busy ? t('teams.creating') : t('teams.create')}
                </button>
              </div>
            </form>
          </Card>
          <Card>
            <form className="search-form" onSubmit={search}>
              <input
                required
                value={query}
                placeholder={t('teams.searchPlaceholder')}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button type="submit" className="button button--primary">
                {t('teams.findTeam')}
              </button>
            </form>
            {searched && results.length === 0 ? (
              <p>{t('teams.noSearchResults')}</p>
            ) : (
              <div className="team-search-results">
                {results.map((team) => (
                  <article key={team.id}>
                    <div>
                      <strong>
                        <span className="team-logo" aria-hidden="true">
                          {teamLogoGlyph(team.logo)}
                        </span>
                        {team.name}
                      </strong>
                      <small>
                        {team.code} · {t('teams.memberCount', { count: team.member_count })}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => void join(team.id)}
                    >
                      {t('teams.join')}
                    </button>
                  </article>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
