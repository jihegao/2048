import { TeamLogo } from '../../components/TeamLogo';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { presetTeamLogos, type TeamLogoId } from '../../../shared/types';
import { Alert, Card, LoadingBlock, PageHeader } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { api, queryString } from '../../lib/api';

interface Team {
  id: string;
  name: string;
  code: string;
  logo: string | null;
  isOwner: boolean;
  frozen: number;
  group: string | null;
  members: Array<{ id: string; student_no: string; display_name: string; class_name: string }>;
}

interface SearchTeam {
  id: string;
  name: string;
  code: string;
  logo: string | null;
  member_count: number;
  team_group: string;
  memberNames: string[];
}

export function StudentTeamPage() {
  const { t } = useTranslation();
  const current = useApiData<{ team: Team | null }>('/api/me/team');
  const [mode, setMode] = useState<'join' | 'create'>('join');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchTeam[]>([]);
  const [searched, setSearched] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [createName, setCreateName] = useState('');
  const [createLogo, setCreateLogo] = useState<TeamLogoId>(presetTeamLogos[0].id);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const resetSearch = () => {
    setMode('join');
    setResults([]);
    setSearched(false);
    setQuery('');
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setSearching(true);
    setNotice(null);
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
    } finally {
      setSearching(false);
    }
  };

  const join = async (teamId: string) => {
    setBusy(true);
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
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!window.confirm(t('teams.confirmLeave'))) return;
    setBusy(true);
    try {
      const response = await api<{ message: string }>('/api/me/team', { method: 'DELETE' });
      setNotice({ message: response.message, error: false });
      resetSearch();
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
      resetSearch();
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
    <div className="team-page">
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
                  <TeamLogo logo={current.data.team.logo} />
                </span>
                {current.data.team.name}
              </h2>
              <small>
                {current.data.team.code} ·{' '}
                {current.data.team.group
                  ? t('teams.groupLabel', { group: current.data.team.group })
                  : t('teams.groupPending')}
              </small>
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
              disabled={Boolean(current.data.team.frozen) || busy}
              onClick={() => void leave()}
            >
              {t('teams.leave')}
            </button>
          )}
        </Card>
      ) : (
        <>
          <div className="team-onboarding-note">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <circle cx="9" cy="7" r="3" />
              <path d="M3 21v-3a6 6 0 0 1 12 0v3H3Zm13-17a3 3 0 0 1 0 6m3 11v-3a6 6 0 0 0-2-4" />
            </svg>
            <span>{t('teams.chooseMethod')}</span>
          </div>
          <div className="team-mode-tabs" role="tablist" aria-label={t('teams.teamActions')}>
            {(['join', 'create'] as const).map((item) => (
              <button
                type="button"
                key={item}
                id={`team-tab-${item}`}
                role="tab"
                aria-selected={mode === item}
                aria-controls="team-action-panel"
                tabIndex={mode === item ? 0 : -1}
                onClick={() => setMode(item)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? 'join'
                      : event.key === 'End'
                        ? 'create'
                        : mode === 'join'
                          ? 'create'
                          : 'join';
                  setMode(next);
                  document.getElementById(`team-tab-${next}`)?.focus();
                }}
              >
                {t(item === 'join' ? 'teams.join' : 'teams.create')}
              </button>
            ))}
          </div>
          <div id="team-action-panel" role="tabpanel" aria-labelledby={`team-tab-${mode}`}>
            {mode === 'create' ? (
              <Card className="team-action-card">
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
                    <div
                      className="logo-picker"
                      role="radiogroup"
                      aria-label={t('teams.logoLabel')}
                    >
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
                          <TeamLogo logo={logo.id} />
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="team-form-hint">{t('teams.createHint')}</p>
                  <div className="form-actions">
                    <button type="submit" className="button button--primary" disabled={busy}>
                      {busy ? t('teams.creating') : t('teams.create')}
                    </button>
                  </div>
                </form>
              </Card>
            ) : (
              <Card className="team-action-card">
                <h2>{t('teams.findTeam')}</h2>
                <p className="team-form-hint">{t('teams.searchHelp')}</p>
                <form className="search-form" onSubmit={search}>
                  <input
                    required
                    maxLength={80}
                    aria-label={t('teams.searchPlaceholder')}
                    value={query}
                    placeholder={t('teams.searchPlaceholder')}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <button type="submit" className="button button--primary" disabled={searching}>
                    {t(searching ? 'teams.searching' : 'teams.search')}
                  </button>
                </form>
                <div aria-live="polite" aria-busy={searching}>
                  {searched ? (
                    <div className="team-results-heading">
                      <h3>{t('teams.searchResults')}</h3>
                      <p>{t('teams.searchResultCount', { count: results.length })}</p>
                    </div>
                  ) : null}
                  {searched && results.length === 0 ? (
                    <p className="team-search-empty">{t('teams.noSearchResults')}</p>
                  ) : (
                    <div className="team-search-results">
                      {results.map((team) => (
                        <article key={team.id}>
                          <span className="team-result-logo" aria-hidden="true">
                            <TeamLogo logo={team.logo} />
                          </span>
                          <div className="team-result-details">
                            <strong>{team.name}</strong>
                            <small>
                              {t('teams.code')}：{team.code}
                            </small>
                            <span className="team-result-members">
                              {t('teams.members')}：
                              {team.memberNames?.join(t('teams.nameSeparator')) || '—'}
                            </span>
                          </div>
                          <div className="team-result-actions">
                            <span className="member-count">
                              {t('teams.memberCount', { count: team.member_count })}
                            </span>
                            <button
                              type="button"
                              className="button button--primary"
                              disabled={busy}
                              onClick={() => void join(team.id)}
                            >
                              {t('teams.join')}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
                <p className="team-form-hint team-search-footnote">{t('teams.joinHint')}</p>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}
