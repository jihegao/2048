import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
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
import {
  clearTournamentWinner,
  matchLabel,
  tournamentImpacts,
  type TournamentData,
  type TournamentRoom,
  type TournamentImpact,
  type TournamentSummary,
} from '../../../shared/tournaments';
import { TeamLogo } from '../../components/TeamLogo';
import { Alert, LoadingBlock, Modal, PageHeader, StatusBadge } from '../../components/ui';
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
function BracketEditor({
  kind,
  initial,
  onUpdated,
  onDirty,
}: {
  kind: BracketKind;
  initial: BracketData | TournamentData;
  onUpdated: (data: TournamentData) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [catalog, setCatalog] = useState(initial.catalog);
  const [snapshot, setSnapshot] = useState<BracketSnapshot>(initial);
  const [state, setState] = useState(initial.state);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ message: string; error: boolean; room?: boolean } | null>(
    null,
  );
  const [eventData, setEventData] = useState<TournamentData | null>(
    'event' in initial ? initial : null,
  );
  const [duration, setDuration] = useState(5);
  const [confirmRooms, setConfirmRooms] = useState(false);
  const archived = eventData?.event.archived ?? false;
  const readonly = busy || archived;
  const {
    ref: fullscreenRef,
    isFullscreen,
    isFallback,
    toggle: toggleFullscreen,
  } = useFullscreen();
  const size = bracketSize(kind);
  const projected = useMemo(() => projectBracket(kind, catalog, state), [kind, catalog, state]);
  const dirty = JSON.stringify(state) !== JSON.stringify(snapshot.state);
  const impacts = useMemo(
    () => tournamentImpacts(kind, catalog, snapshot.state, projected.state, eventData?.rooms ?? []),
    [kind, catalog, snapshot.state, projected.state, eventData],
  );
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const accept = useCallback(
    (saved: TournamentData) => {
      setState(saved.state);
      setSnapshot(saved);
      setCatalog(saved.catalog);
      setEventData(saved);
      onUpdated(saved);
    },
    [onUpdated],
  );
  useEffect(() => {
    if (!eventData?.rooms.length || busy || dirty) return;
    const eventId = eventData.event.id;
    let cancelled = false;
    let refreshing = false;
    const timer = window.setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const saved = await api<TournamentData>(`/api/teacher/tournaments/${eventId}`);
        if (!cancelled) accept(saved);
      } catch {
        // Manual refresh reports errors; keep current rooms during transient polling failures.
      } finally {
        refreshing = false;
      }
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [eventData?.event.id, eventData?.rooms.length, busy, dirty, accept]);
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
      const confirmedImpacts = eventData
        ? (
            await api<{ impacts: TournamentImpact[] }>(
              `/api/teacher/tournaments/${eventData.event.id}/preview`,
              {
                method: 'POST',
                body: JSON.stringify({ revision: snapshot.revision, state: projected.state }),
              },
            )
          ).impacts
        : impacts;
      if (eventData && confirmedImpacts.some((impact) => impact.blocked))
        throw new Error(t('tournaments.blocked'));
      if (
        eventData &&
        confirmedImpacts.some((impact) => impact.room || impact.clearedWinner) &&
        !window.confirm(t('tournaments.confirmImpact', { count: confirmedImpacts.length }))
      )
        return;
      const saved = await api<TournamentData>(
        eventData ? `/api/teacher/tournaments/${eventData.event.id}` : '/api/teacher/tournaments',
        {
          method: eventData ? 'PUT' : 'POST',
          body: JSON.stringify(
            eventData
              ? { revision: snapshot.revision, state: projected.state }
              : { kind, state: projected.state },
          ),
        },
      );
      accept(saved);
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
      if (eventData)
        accept(await api<TournamentData>(`/api/teacher/tournaments/${eventData.event.id}`));
      else {
        const loaded = await api<BracketData>(`/api/teacher/brackets/${kind}`);
        setCatalog(loaded.catalog);
        setState(emptyBracket(kind));
        setSnapshot({ ...loaded, state: emptyBracket(kind), revision: 0, updatedAt: null });
      }
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };
  const roomAction = async (
    room: TournamentRoom | null,
    action: 'start' | 'cancel' | 'refresh',
  ) => {
    if (!eventData) return;
    if (dirty) {
      setNotice({ message: t('tournaments.saveFirst'), error: true, room: true });
      return;
    }
    if (action === 'cancel' && !window.confirm(t('rooms.confirmCancel'))) return;
    setBusy(true);
    setNotice(null);
    try {
      if (room && action !== 'refresh')
        await api(`/api/teacher/rooms/${room.roomId}/${action}`, { method: 'POST' });
      accept(await api<TournamentData>(`/api/teacher/tournaments/${eventData.event.id}`));
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
        room: true,
      });
    } finally {
      setBusy(false);
    }
  };
  const eventAction = async (
    action: 'rooms' | 'archive' | 'copy' | 'rematch',
    round?: number,
    match?: number,
  ) => {
    if (!eventData) return;
    if (dirty) {
      setNotice({ message: t('tournaments.saveFirst'), error: true, room: action === 'rooms' });
      return;
    }
    const confirmation =
      action === 'archive'
        ? t(archived ? 'tournaments.confirmRestore' : 'tournaments.confirmArchive')
        : action === 'rematch'
          ? t('tournaments.confirmRematch')
          : null;
    if (confirmation && !window.confirm(confirmation)) return;
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api<TournamentData>(
        action === 'copy'
          ? '/api/teacher/tournaments'
          : `/api/teacher/tournaments/${eventData.event.id}${action === 'archive' ? '' : `/${action}`}`,
        {
          method: action === 'archive' ? 'PATCH' : 'POST',
          body: JSON.stringify(
            action === 'copy'
              ? { kind, copyId: eventData.event.id }
              : action === 'archive'
                ? { revision: snapshot.revision, archived: !archived }
                : action === 'rooms'
                  ? { revision: snapshot.revision, durationMinutes: duration }
                  : { revision: snapshot.revision, round, match },
          ),
        },
      );
      accept(saved);
      setNotice({
        message: t(
          `tournaments.${action === 'rooms' ? 'roomsCreated' : action === 'rematch' ? 'rematchCreated' : 'updated'}`,
        ),
        error: false,
        room: action === 'rooms' || action === 'rematch',
      });
    } catch (reason) {
      setNotice({
        message: reason instanceof Error ? reason.message : String(reason),
        error: true,
        room: action === 'rooms' || action === 'rematch',
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
          disabled={readonly || !match.entries[0] || !match.entries[1]}
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
              disabled={readonly}
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
  const incompleteTeams =
    kind === 'teams8'
      ? projected.slots.flatMap(({ entry }) =>
          entry?.memberCount !== undefined && entry.memberCount !== 3 ? [entry] : [],
        )
      : [];
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
              disabled={readonly || (!dirty && snapshot.revision > 0)}
              onClick={() => void save()}
            >
              {t(busy ? 'brackets.saving' : 'brackets.save')}
            </button>
          </>
        }
      />
      {notice && !notice.room ? (
        <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} />
      ) : null}
      {confirmRooms ? (
        <Modal
          title={t('tournaments.createRooms', { count: size - 1 })}
          onClose={() => setConfirmRooms(false)}
        >
          <p>{t('tournaments.confirmRooms', { count: size - 1, duration })}</p>
          <div className="form-actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setConfirmRooms(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={readonly || dirty || incompleteTeams.length > 0}
              onClick={() => {
                setConfirmRooms(false);
                void eventAction('rooms');
              }}
            >
              {t('common.confirm')}
            </button>
          </div>
        </Modal>
      ) : null}
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
            disabled={readonly}
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
            disabled={readonly}
            onClick={() => {
              if (window.confirm(t('brackets.confirmReset'))) {
                setState({ ...emptyBracket(kind), title: state.title });
                setNotice(null);
              }
            }}
          >
            {t('brackets.reset')}
          </button>
        </div>
      </div>
      {eventData ? (
        <div className="tournament-event-actions">
          <button
            className="button button--ghost"
            disabled={busy || dirty}
            onClick={() => void eventAction('copy')}
          >
            {t('tournaments.copy')}
          </button>
          <button
            className="button button--ghost"
            disabled={busy || dirty}
            onClick={() => void eventAction('archive')}
          >
            {t(archived ? 'tournaments.restore' : 'tournaments.archive')}
          </button>
          <span>{t(`tournaments.status.${eventData.event.status}`)}</span>
        </div>
      ) : null}
      {dirty && impacts.length ? (
        <div className="card tournament-impact" role="status">
          <strong>{t('tournaments.impactTitle')}</strong>
          <ul>
            {impacts.map((impact) => (
              <li key={`${impact.round}-${impact.match}`}>
                {matchLabel(impact.round, impact.match, sideRounds, i18n.language === 'en')}:{' '}
                {impact.before
                  .map(
                    (id) => catalog.find((entry) => entry.id === id)?.name ?? t('brackets.pending'),
                  )
                  .join(' / ')}{' '}
                →{' '}
                {impact.after
                  .map(
                    (id) => catalog.find((entry) => entry.id === id)?.name ?? t('brackets.pending'),
                  )
                  .join(' / ')}
                {impact.clearedWinner ? ` · ${t('tournaments.resultCleared')}` : ''}
                {impact.room?.entryCount ? ` · ${t('tournaments.releaseWaiting')}` : ''}
                {impact.blocked ? ` · ${t('tournaments.blocked')}` : ''}
              </li>
            ))}
          </ul>
          <small>{t('tournaments.impactHint')}</small>
        </div>
      ) : null}
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
      <section className="card tournament-room-panel">
        <div className="tournament-room-panel__header">
          <h2>{t('tournaments.rooms')}</h2>
          <label>
            {t('rooms.duration')}
            <select
              value={eventData?.rooms[0]?.durationMinutes ?? duration}
              disabled={readonly || Boolean(eventData?.rooms.length)}
              onChange={(event) => setDuration(Number(event.target.value))}
            >
              {Array.from({ length: 10 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1} {t('common.minutes')}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button button--primary"
            disabled={
              readonly ||
              dirty ||
              !eventData ||
              matched !== size ||
              incompleteTeams.length > 0 ||
              eventData.rooms.length === size - 1
            }
            onClick={() => setConfirmRooms(true)}
          >
            {t('tournaments.createRooms', { count: size - 1 })}
          </button>
          {eventData?.rooms.length ? (
            <button
              className="button button--ghost"
              disabled={busy || dirty}
              onClick={() => void roomAction(null, 'refresh')}
            >
              {t('tournaments.refreshRooms')}
            </button>
          ) : null}
        </div>
        <p>{t('tournaments.roomHint')}</p>
        <small>{t('tournaments.autoRefresh')}</small>
        {notice?.room ? (
          <Alert message={notice.message} tone={notice.error ? 'error' : 'success'} />
        ) : null}
        {incompleteTeams.length ? (
          <Alert
            message={t('tournaments.incompleteTeams', {
              teams: incompleteTeams
                .map((entry) => `${entry.name} (${entry.memberCount}/3)`)
                .join('、'),
            })}
          />
        ) : null}
        {!eventData ? <p>{t('tournaments.saveFirst')}</p> : null}
        {projected.rounds.map((matches, round) => (
          <section className="tournament-room-round" key={round}>
            <h3>
              {t(round === sideRounds - 1 ? 'brackets.final' : 'brackets.round', {
                count: size / 2 ** round,
              })}
            </h3>
            <div className="tournament-room-grid">
              {matches.map((match, index) => {
                const room = eventData?.rooms.find(
                  (value) => value.round === round && value.match === index,
                );
                const names = room
                  ? room.participants.map((id) => catalog.find((entry) => entry.id === id)?.name)
                  : match.entries.map((entry) => entry?.name);
                return (
                  <article
                    className="tournament-room-card"
                    key={`${round}-${index}`}
                    data-room-round={round}
                    data-room-match={index}
                  >
                    <strong>{matchLabel(round, index, sideRounds, i18n.language === 'en')}</strong>
                    <p>
                      {names
                        .map(
                          (name, side) =>
                            name ??
                            (round === 0
                              ? t('brackets.pending')
                              : t('tournaments.sourceWinner', {
                                  match: matchLabel(
                                    round - 1,
                                    index * 2 + side,
                                    sideRounds,
                                    i18n.language === 'en',
                                  ),
                                })),
                        )
                        .join(' vs ')}
                    </p>
                    {room ? (
                      <>
                        <small>{room.name}</small>
                        <span>
                          {t('rooms.code')}: <b>{room.code}</b> ·{' '}
                          <StatusBadge status={room.status} />
                        </span>
                        <small>
                          {t(
                            kind === 'teams8'
                              ? 'tournaments.teamsJoined'
                              : 'tournaments.playersJoined',
                            { count: room.entryCount },
                          )}
                        </small>
                        {room.status === 'open' ? (
                          <small>
                            {t(
                              room.participants.every(Boolean)
                                ? 'tournaments.waitingForEntry'
                                : 'tournaments.waitingForWinners',
                            )}
                          </small>
                        ) : null}
                        <div className="tournament-room-actions">
                          {['open', 'full'].includes(room.status) ? (
                            <button
                              className="button button--primary"
                              disabled={readonly || dirty || room.status !== 'full'}
                              onClick={() => void roomAction(room, 'start')}
                            >
                              {t('rooms.start')}
                            </button>
                          ) : null}
                          {['open', 'full'].includes(room.status) ? (
                            <button
                              className="text-button text-button--danger"
                              disabled={readonly || dirty}
                              onClick={() => void roomAction(room, 'cancel')}
                            >
                              {t('rooms.cancelRoom')}
                            </button>
                          ) : null}
                          <Link className="text-button" to={`/teacher/rooms/${room.roomId}/live`}>
                            {t('tournaments.openRoom')}
                          </Link>
                          <button
                            className="text-button"
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(room.code)
                                .then(() =>
                                  setNotice({ message: t('tournaments.codeCopied'), error: false }),
                                )
                                .catch(() =>
                                  setNotice({
                                    message: `${t('rooms.code')}: ${room.code}`,
                                    error: false,
                                  }),
                                )
                            }
                          >
                            {t('tournaments.copyCode')}
                          </button>
                          {['ended', 'cancelled'].includes(room.status) ? (
                            <button
                              className="text-button"
                              disabled={readonly || dirty}
                              onClick={() => void eventAction('rematch', round, index)}
                            >
                              {t('tournaments.rematch')}
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <small>{t('tournaments.notCreated')}</small>
                    )}
                    {match.winner ? (
                      <button
                        className="text-button text-button--danger"
                        disabled={readonly}
                        onClick={() =>
                          setState((current) =>
                            clearTournamentWinner(kind, catalog, current, round, index),
                          )
                        }
                      >
                        {t('tournaments.clearWinner')}
                      </button>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
        {eventData?.history.length ? (
          <details>
            <summary>{t('tournaments.history')}</summary>
            {eventData.history.map((room) => (
              <p key={room.roomId}>
                <Link to={`/teacher/rooms/${room.roomId}/live`}>
                  {room.name} · {room.code}
                </Link>
              </p>
            ))}
          </details>
        ) : null}
        {eventData?.audit.length ? (
          <details>
            <summary>{t('tournaments.audit')}</summary>
            {eventData.audit.map((entry) => (
              <p key={entry.id}>
                {new Date(entry.at).toLocaleString(i18n.language)} · {entry.actor} ·{' '}
                {t(`tournaments.actions.${entry.action}`)}
              </p>
            ))}
          </details>
        ) : null}
      </section>
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
            disabled={readonly || !dirty}
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
  const [search, setSearch] = useSearchParams();
  const selected = search.get('event');
  const archived = search.get('archived') === 'true';
  const [dirty, setDirty] = useState(false);
  const [draftKey, setDraftKey] = useState(0);
  const list = useApiData<{ items: TournamentSummary[] }>(
    `/api/teacher/tournaments?kind=${kind}&archived=${archived}`,
  );
  const data = useApiData<BracketData | TournamentData>(
    selected && selected !== 'new'
      ? `/api/teacher/tournaments/${selected}`
      : selected === 'new'
        ? `/api/teacher/brackets/${kind}`
        : null,
  );
  useEffect(() => {
    if (!selected && list.data)
      setSearch(
        { event: list.data.items[0]?.id ?? 'new', ...(archived ? { archived: 'true' } : {}) },
        { replace: true },
      );
  }, [selected, list.data, setSearch, archived]);
  const choose = (id: string, showArchived = archived) => {
    if (dirty && !window.confirm(t('brackets.discard'))) return;
    setDirty(false);
    if (id === 'new') setDraftKey((key) => key + 1);
    setSearch({ event: id, ...(showArchived ? { archived: 'true' } : {}) });
  };
  const onUpdated = (saved: TournamentData) => {
    void list.reload();
    if (saved.event.id !== selected || saved.event.archived !== archived)
      setSearch({ event: saved.event.id, ...(saved.event.archived ? { archived: 'true' } : {}) });
  };
  if (!selected || data.loading) return <LoadingBlock />;
  if (data.error || !data.data)
    return (
      <>
        <Alert message={data.error || t('brackets.loadError')} />
        <button type="button" className="button button--ghost" onClick={() => void data.reload()}>
          {t('brackets.reload')}
        </button>
      </>
    );
  if ('event' in data.data && data.data.event.kind !== kind)
    return (
      <Navigate
        to={`/teacher/brackets/${data.data.event.kind}?event=${data.data.event.id}`}
        replace
      />
    );
  const initial =
    selected === 'new'
      ? { ...data.data, state: emptyBracket(kind), revision: 0, updatedAt: null }
      : data.data;
  return (
    <>
      <div className="card tournament-event-list">
        <label>
          {t('tournaments.list')}
          <select
            aria-label={t('tournaments.list')}
            value={selected}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="new">{t('tournaments.newDraft')}</option>
            {list.data?.items.map((event) => (
              <option key={event.id} value={event.id}>
                {event.title} · {t(`tournaments.status.${event.status}`)} · {event.roomCount}{' '}
                {t('tournaments.rooms')}
              </option>
            ))}
            {selected !== 'new' &&
            !list.data?.items.some((event) => event.id === selected) &&
            'event' in data.data ? (
              <option value={selected}>{data.data.event.title}</option>
            ) : null}
          </select>
        </label>
        <button className="button button--primary" onClick={() => choose('new', false)}>
          {t('tournaments.new')}
        </button>
        <label className="tournament-archive-filter">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => choose('new', event.target.checked)}
          />
          {t('tournaments.showArchived')}
        </label>
        <small>{t('tournaments.independent')}</small>
      </div>
      {list.error ? <Alert message={list.error} /> : null}
      <BracketEditor
        key={`${selected}-${draftKey}`}
        kind={kind}
        initial={initial}
        onUpdated={onUpdated}
        onDirty={setDirty}
      />
    </>
  );
}
export function TeacherBracketsPage() {
  const { kind } = useParams();
  if (kind !== 'teams8' && kind !== 'players16')
    return <Navigate to="/teacher/brackets/teams8" replace />;
  return <BracketLoader key={kind} kind={kind} />;
}
