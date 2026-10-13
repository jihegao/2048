import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams } from 'react-router-dom';
import {
  bracketKinds,
  bracketSize,
  changeBracketName,
  chooseBracketWinner,
  emptyBracket,
  projectBracket,
  type BracketData,
  type BracketKind,
  type BracketMatch,
  type BracketSnapshot,
} from '../../../shared/brackets';
import { TeamLogo } from '../../components/TeamLogo';
import { Alert, LoadingBlock, PageHeader } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { useFullscreen } from '../../hooks/useFullscreen';
import { api, ApiError } from '../../lib/api';
import '../../brackets.css';

function Connector({ count, mirrored = false }: { count: number; mirrored?: boolean }) {
  return (
    <svg
      className={`tournament-connector ${mirrored ? 'is-mirrored' : ''}`}
      viewBox="0 0 28 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_, index) => {
        const y = (100 * (index + 0.5)) / count;
        const next = count === 1 ? 50 : (100 * (Math.floor(index / 2) + 0.5)) / (count / 2);
        return <path key={index} d={`M 0 ${y} H 14 V ${next} H 28`} />;
      })}
    </svg>
  );
}
function BracketEditor({ kind, initial }: { kind: BracketKind; initial: BracketData }) {
  const { t, i18n } = useTranslation();
  const [catalog, setCatalog] = useState(initial.catalog);
  const [snapshot, setSnapshot] = useState<BracketSnapshot>(initial);
  const [state, setState] = useState(initial.state);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const {
    ref: fullscreenRef,
    isFullscreen,
    isFallback,
    toggle: toggleFullscreen,
  } = useFullscreen();
  const size = bracketSize(kind);
  const projected = useMemo(() => projectBracket(kind, catalog, state), [kind, catalog, state]);
  const dirty = JSON.stringify(state) !== JSON.stringify(snapshot.state);
  const sideRounds = projected.rounds.length - 1;
  const listId = `tournament-catalog-${kind}`;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<BracketSnapshot>(`/api/teacher/brackets/${kind}`, {
        method: 'PUT',
        body: JSON.stringify({ revision: snapshot.revision, state: projected.state }),
      });
      setState(saved.state);
      setSnapshot(saved);
      setNotice({ message: t('brackets.saved'), error: false });
    } catch (reason) {
      const key =
        reason instanceof ApiError && reason.code === 'BRACKET_CONFLICT'
          ? 'brackets.conflict'
          : reason instanceof ApiError && reason.code === 'INVALID_BRACKET_WINNER'
            ? 'brackets.changedCatalog'
            : null;
      setNotice({
        message: key ? t(key) : reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    if (dirty && !window.confirm(t('brackets.discard'))) return;
    setBusy(true);
    setNotice(null);
    try {
      const loaded = await api<BracketData>(`/api/teacher/brackets/${kind}`);
      setCatalog(loaded.catalog);
      setState(loaded.state);
      setSnapshot(loaded);
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };
  const matchCard = (match: BracketMatch, round: number, index: number, right = false) => (
    <article className="tournament-match" key={index} data-round={round} data-match={index}>
      {match.entries.map((entry, side) => {
        const slotIndex = index * 2 + side;
        const slot = round === 0 ? projected.slots[slotIndex] : null;
        const winner = Boolean(entry && match.winner?.id === entry.id);
        return (
          <div
            key={side}
            className={`tournament-entry ${winner ? 'is-winner' : ''} ${slot?.error ? 'has-error' : ''}`}
          >
            <span className="tournament-logo" aria-hidden="true">
              {entry && kind === 'teams8' ? (
                <TeamLogo logo={entry.logo} />
              ) : kind === 'players16' ? (
                '♙'
              ) : (
                '◇'
              )}
            </span>
            <div className="tournament-entry__name">
              {slot ? (
                <input
                  className="tournament-input"
                  aria-label={t('brackets.slot', { number: slotIndex + 1 })}
                  list={listId}
                  maxLength={180}
                  disabled={busy}
                  autoComplete="off"
                  placeholder={t(
                    kind === 'teams8' ? 'brackets.teamPlaceholder' : 'brackets.playerPlaceholder',
                  )}
                  value={state.names[slotIndex]}
                  title={entry?.label}
                  onChange={(event) => {
                    const name = event.target.value;
                    setState((current) =>
                      changeBracketName(kind, catalog, current, slotIndex, name),
                    );
                    setNotice(null);
                  }}
                />
              ) : (
                <strong title={entry?.label}>{entry?.name ?? t('brackets.pending')}</strong>
              )}
              <small className={slot?.error ? 'tournament-error' : ''}>
                {slot?.error
                  ? t(`brackets.${slot.error}`)
                  : winner
                    ? t('brackets.advanced')
                    : slot
                      ? `${t('brackets.slot', { number: slotIndex + 1 })}${entry ? ' ✓' : ''}`
                      : t('brackets.fromPrevious')}
              </small>
            </div>
            <button
              className="tournament-advance"
              type="button"
              disabled={busy || !match.entries[0] || !match.entries[1]}
              aria-label={t('brackets.advance', { name: entry?.name ?? t('brackets.pending') })}
              aria-pressed={winner}
              title={t('brackets.advance', { name: entry?.name ?? t('brackets.pending') })}
              onClick={() => {
                if (entry)
                  setState((current) =>
                    chooseBracketWinner(kind, catalog, current, round, index, entry.id),
                  );
                setNotice(null);
              }}
            >
              {winner ? '✓' : right ? '‹' : '›'}
            </button>
          </div>
        );
      })}
    </article>
  );
  const stage = (round: number, right: boolean) => {
    const matches = projected.rounds[round];
    const half = matches.length / 2;
    return (
      <section
        className={`tournament-stage ${right ? 'is-right' : 'is-left'}`}
        key={`${right}-${round}`}
        data-stage={round}
        data-wing={right ? 'right' : 'left'}
        aria-label={`${t(right ? 'brackets.right' : 'brackets.left')} ${t('brackets.round', { count: size / 2 ** round })}`}
      >
        <h2>{t('brackets.round', { count: size / 2 ** round })}</h2>
        <div className="tournament-stage__track">
          {matches
            .slice(right ? half : 0, right ? matches.length : half)
            .map((match, offset) => matchCard(match, round, offset + (right ? half : 0), right))}
        </div>
      </section>
    );
  };
  const matched = projected.slots.filter((slot) => slot.entry).length;
  return (
    <div ref={fullscreenRef} className={`tournament-page ${isFullscreen ? 'is-fullscreen' : ''}`}>
      <PageHeader
        title={t('brackets.title')}
        subtitle={t('brackets.subtitle')}
        actions={
          <>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void toggleFullscreen()}
              aria-pressed={isFullscreen}
            >
              {t(isFullscreen ? 'common.exitFullscreen' : 'common.fullscreen')}
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={busy || (!dirty && snapshot.revision > 0)}
              onClick={() => void save()}
            >
              {t(busy ? 'brackets.saving' : 'brackets.save')}
            </button>
          </>
        }
      />
      {notice ? <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} /> : null}
      {isFallback ? <Alert tone="info" message={t('rooms.fullscreenFallback')} /> : null}
      <div className="tournament-controls card">
        <nav className="tab-list" aria-label={t('brackets.mode')}>
          {bracketKinds.map((mode) => (
            <Link
              key={mode}
              className={`tab-button ${kind === mode ? 'is-active' : ''}`}
              aria-current={kind === mode ? 'page' : undefined}
              to={`/teacher/brackets/${mode}`}
              onClick={(event) => {
                if (busy || (mode !== kind && dirty && !window.confirm(t('brackets.discard'))))
                  event.preventDefault();
              }}
            >
              {t(`brackets.${mode}`)}
            </Link>
          ))}
        </nav>
        <label className="tournament-title-input">
          {t('brackets.eventTitle')}
          <input
            value={state.title}
            maxLength={100}
            disabled={busy}
            placeholder={t(`brackets.${kind}`)}
            onChange={(event) => {
              const title = event.target.value;
              setState((current) => ({ ...current, title }));
            }}
          />
        </label>
        <div className="tournament-save-status" role="status">
          <strong>{t(dirty ? 'brackets.unsaved' : 'brackets.synced')}</strong>
          <small>
            {snapshot.updatedAt
              ? t('brackets.updatedAt', {
                  time: new Date(snapshot.updatedAt).toLocaleString(
                    i18n.language === 'en' ? 'en-US' : 'zh-CN',
                  ),
                })
              : t('brackets.newBracket')}
          </small>
        </div>
        <div className="tournament-secondary-actions">
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void reload()}
          >
            {t('brackets.reload')}
          </button>
          <button
            type="button"
            className="text-button text-button--danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('brackets.confirmReset'))) {
                setState(emptyBracket(kind));
                setNotice(null);
              }
            }}
          >
            {t('brackets.reset')}
          </button>
        </div>
      </div>
      <div className="tournament-help">
        <span>{t(kind === 'teams8' ? 'brackets.teamHint' : 'brackets.playerHint')}</span>
        <strong>{t('brackets.matched', { count: matched, total: size })}</strong>
      </div>
      {!catalog.length ? (
        <Alert
          tone="info"
          message={t(kind === 'teams8' ? 'brackets.noTeams' : 'brackets.noPlayers')}
        />
      ) : null}
      <datalist id={listId}>
        {catalog.map((entry) => (
          <option key={entry.id} value={entry.label}>
            {entry.name}
          </option>
        ))}
      </datalist>
      <div
        className="tournament-scroll"
        tabIndex={0}
        role="region"
        aria-label={t('brackets.board')}
      >
        <div className={`tournament-board tournament-board--${size}`}>
          <header className="tournament-board__header">
            <span>2048 · {t('brackets.knockout')}</span>
            <h2>{state.title || t(`brackets.${kind}`)}</h2>
            <p>{t('brackets.boardHint')}</p>
          </header>
          <div className="tournament-tree">
            {Array.from({ length: sideRounds }, (_, round) => (
              <Fragment key={`left-${round}`}>
                {stage(round, false)}
                <div className="tournament-connector-track">
                  <Connector count={projected.rounds[round].length / 2} />
                </div>
              </Fragment>
            ))}
            <section className="tournament-final" aria-label={t('brackets.final')}>
              <h2>{t('brackets.final')}</h2>
              <div className="tournament-final__track">
                {matchCard(projected.rounds.at(-1)![0], sideRounds, 0)}
                <div className={`tournament-champion ${projected.champion ? 'is-decided' : ''}`}>
                  <span className="tournament-trophy" aria-hidden="true">
                    🏆
                  </span>
                  <small>{t('brackets.champion')}</small>
                  {projected.champion && kind === 'teams8' ? (
                    <TeamLogo logo={projected.champion.logo} />
                  ) : null}
                  <strong className="tournament-champion__name">
                    {projected.champion?.name ?? t('brackets.championPending')}
                  </strong>
                </div>
              </div>
            </section>
            {Array.from({ length: sideRounds }, (_, index) => {
              const round = sideRounds - index - 1;
              return (
                <Fragment key={`right-${round}`}>
                  <div className="tournament-connector-track">
                    <Connector count={projected.rounds[round].length / 2} mirrored />
                  </div>
                  {stage(round, true)}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <p className="tournament-footnote">{t('brackets.footnote')}</p>
    </div>
  );
}
function BracketLoader({ kind }: { kind: BracketKind }) {
  const { t } = useTranslation();
  const data = useApiData<BracketData>(`/api/teacher/brackets/${kind}`);
  if (data.loading) return <LoadingBlock />;
  if (data.error || !data.data)
    return (
      <>
        <Alert message={data.error || t('brackets.loadError')} />
        <button type="button" className="button button--ghost" onClick={() => void data.reload()}>
          {t('brackets.reload')}
        </button>
      </>
    );
  return <BracketEditor kind={kind} initial={data.data} />;
}
export function TeacherBracketsPage() {
  const { kind } = useParams();
  if (kind !== 'teams8' && kind !== 'players16')
    return <Navigate to="/teacher/brackets/teams8" replace />;
  return <BracketLoader key={kind} kind={kind} />;
}
