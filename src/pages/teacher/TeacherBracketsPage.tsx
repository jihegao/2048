import { useEffect, useMemo, useState } from 'react';
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
  type BracketEntry,
  type BracketSnapshot,
} from '../../../shared/brackets';
import { TeamLogo } from '../../components/TeamLogo';
import { Alert, LoadingBlock, PageHeader } from '../../components/ui';
import { useApiData } from '../../hooks/useApiData';
import { useFullscreen } from '../../hooks/useFullscreen';
import { api, ApiError } from '../../lib/api';
import '../../brackets.css';

function WingLines({
  count,
  rounds,
  mirrored,
}: {
  count: number;
  rounds: number;
  mirrored: boolean;
}) {
  return (
    <svg
      className={`tournament-lines ${mirrored ? 'is-mirrored' : ''}`}
      viewBox={`0 0 ${rounds * 100} 1000`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {Array.from({ length: rounds - 1 }, (_, round) => {
        const nodes = count / 2 ** round;
        return Array.from({ length: nodes }, (_, index) => {
          const y = (1000 * (index + 0.5)) / nodes;
          const next = (1000 * (Math.floor(index / 2) + 0.5)) / (nodes / 2);
          return (
            <path
              key={`${round}-${index}`}
              d={`M ${round * 100 + 50} ${y} H ${round * 100 + 150} V ${next}`}
            />
          );
        });
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
  const sideRounds = projected.rounds.length;
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
  const node = (
    entry: BracketEntry | null,
    round: number,
    index: number,
    position: number,
    count: number,
  ) => {
    const matchIndex = Math.floor(index / 2);
    const match = projected.rounds[round][matchIndex];
    const slot = round === 0 ? projected.slots[index] : null;
    const winner = Boolean(entry && match.winner?.id === entry.id);
    const label = entry?.name ?? t('brackets.pending');
    return (
      <article
        key={index}
        className={`tournament-entry ${winner ? 'is-winner' : ''} ${slot?.error ? 'has-error' : ''}`}
        data-round={round}
        data-match={matchIndex}
        data-node={index}
        style={{ top: `${(100 * (position + 0.5)) / count}%` }}
      >
        <img
          className="tournament-node-shell"
          src={`/bracket-art/${entry ? 'known' : 'unknown'}.svg`}
          alt=""
          aria-hidden="true"
        />
        <button
          type="button"
          className="tournament-advance"
          disabled={busy || !match.entries[0] || !match.entries[1]}
          aria-label={t('brackets.advance', { name: label })}
          aria-pressed={winner}
          title={entry?.label ?? t('brackets.pending')}
          onClick={() => {
            if (entry)
              setState((current) =>
                chooseBracketWinner(kind, catalog, current, round, matchIndex, entry.id),
              );
            setNotice(null);
          }}
        >
          <span className="tournament-logo" aria-hidden="true">
            {entry ? (
              kind === 'teams8' ? (
                <TeamLogo logo={entry.logo} />
              ) : (
                <span className="tournament-initial">{Array.from(entry.name)[0]}</span>
              )
            ) : null}
          </span>
          {winner ? (
            <span className="tournament-winner-mark" aria-hidden="true">
              ✓
            </span>
          ) : null}
        </button>
        <div className="tournament-entry__name">
          {slot && !isFullscreen ? (
            <input
              className="tournament-input"
              aria-label={t('brackets.slot', { number: index + 1 })}
              list={listId}
              maxLength={180}
              disabled={busy}
              autoComplete="off"
              placeholder={t(
                kind === 'teams8' ? 'brackets.teamPlaceholder' : 'brackets.playerPlaceholder',
              )}
              value={state.names[index]}
              title={entry?.label ?? state.names[index]}
              onChange={(event) => {
                const name = event.target.value;
                setState((current) => changeBracketName(kind, catalog, current, index, name));
                setNotice(null);
              }}
            />
          ) : entry ? (
            <strong title={entry.label}>{entry.name}</strong>
          ) : slot?.text ? (
            <strong>{slot.text}</strong>
          ) : null}
        </div>
        {slot?.error ? (
          <small className="tournament-error" role="status">
            {t(`brackets.${slot.error}`)}
          </small>
        ) : null}
      </article>
    );
  };
  const wing = (right: boolean) => (
    <div className={`tournament-wing ${right ? 'is-right' : 'is-left'}`}>
      <WingLines count={size / 2} rounds={sideRounds} mirrored={right} />
      {Array.from({ length: sideRounds }, (_, offset) => {
        const round = right ? sideRounds - offset - 1 : offset;
        const entries =
          round === 0
            ? projected.slots.map((slot) => slot.entry)
            : projected.rounds[round - 1].map((match) => match.winner);
        const half = entries.length / 2;
        const first = right ? half : 0;
        return (
          <section
            className="tournament-stage"
            key={round}
            data-stage={round}
            data-wing={right ? 'right' : 'left'}
            aria-label={`${t(right ? 'brackets.right' : 'brackets.left')} ${t(round === sideRounds - 1 ? 'brackets.final' : 'brackets.round', { count: size / 2 ** round })}`}
          >
            <div className="tournament-stage__track">
              {entries
                .slice(first, first + half)
                .map((entry, index) => node(entry, round, first + index, index, half))}
            </div>
          </section>
        );
      })}
    </div>
  );
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
          <div className="tournament-tree">
            {wing(false)}
            <section className="tournament-final" aria-label={t('brackets.final')}>
              <img
                className="tournament-flag"
                src="/bracket-art/flag.svg"
                alt=""
                aria-hidden="true"
              />
              <div className="tournament-banner-title">
                <h2>{t('brackets.showdown')}</h2>
                <p>{t(kind === 'teams8' ? 'brackets.teamLive' : 'brackets.playerLive')}</p>
                {state.title ? <span>{state.title}</span> : null}
              </div>
              <img
                className="tournament-mascot"
                src="/bracket-art/mascot.png"
                alt=""
                aria-hidden="true"
              />
              <div className={`tournament-champion ${projected.champion ? 'is-decided' : ''}`}>
                <small>{t('brackets.champion')}</small>
                <strong className="tournament-champion__name">
                  {projected.champion?.name ?? t('brackets.championPending')}
                </strong>
              </div>
            </section>
            {wing(true)}
          </div>
        </div>
      </div>
      <p className="tournament-footnote">{t('brackets.footnote')}</p>
      {isFullscreen ? (
        <div className="tournament-display-toolbar">
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void toggleFullscreen()}
          >
            {t('common.exitFullscreen')}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {t(busy ? 'brackets.saving' : 'brackets.save')}
          </button>
        </div>
      ) : null}
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
