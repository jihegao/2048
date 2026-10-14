import {
  bracketSize,
  projectBracket,
  type BracketData,
  type BracketEntry,
  type BracketKind,
  type BracketState,
} from './brackets';
import type { RoomStatus } from './types';

export interface TournamentSummary {
  id: string;
  kind: BracketKind;
  title: string;
  revision: number;
  updatedAt: string;
  archived: boolean;
  status: 'draft' | 'ready' | 'running' | 'completed' | 'archived';
  roomCount: number;
}
export interface TournamentRoom {
  round: number;
  match: number;
  roomId: string;
  code: string;
  name: string;
  status: RoomStatus;
  durationMinutes: number;
  participants: [string | null, string | null];
  entryCount: number;
}
export interface TournamentData extends BracketData {
  event: TournamentSummary;
  rooms: TournamentRoom[];
  history: Array<{
    roomId: string;
    code: string;
    name: string;
    round: number;
    match: number;
    replacedAt: string;
  }>;
  audit: Array<{ id: string; action: string; actor: string; at: string }>;
}
export interface TournamentImpact {
  round: number;
  match: number;
  room: TournamentRoom | null;
  before: [string | null, string | null];
  after: [string | null, string | null];
  clearedWinner: boolean;
  blocked: boolean;
}
export function roundLabel(round: number, rounds: number, english = false) {
  return round === rounds - 1
    ? english
      ? 'Final'
      : '决赛'
    : english
      ? `Round ${round + 1}`
      : `第${['一', '二', '三', '四'][round]}轮`;
}
export function matchLabel(round: number, match: number, rounds: number, english = false) {
  const label = roundLabel(round, rounds, english);
  return round === rounds - 1
    ? label
    : `${label}${english ? ' Group ' : ''}${String.fromCharCode(65 + match)}${english ? '' : '组'}`;
}
export function tournamentRoomName(title: string, kind: BracketKind, round: number, match: number) {
  return `${title}-${matchLabel(round, match, Math.log2(bracketSize(kind)))}`;
}
export function clearTournamentWinner(
  kind: BracketKind,
  catalog: BracketEntry[],
  state: BracketState,
  round: number,
  match: number,
) {
  const next = { ...state, winners: state.winners.map((row) => [...row]) };
  for (let r = round, m = match; r < next.winners.length; r++, m = Math.floor(m / 2))
    next.winners[r][m] = null;
  return projectBracket(kind, catalog, next).state;
}
export function tournamentImpacts(
  kind: BracketKind,
  catalog: BracketEntry[],
  before: BracketState,
  after: BracketState,
  rooms: TournamentRoom[],
): TournamentImpact[] {
  const old = projectBracket(kind, catalog, before);
  const next = projectBracket(kind, catalog, after);
  return next.rounds.flatMap((matches, round) =>
    matches.flatMap((current, match) => {
      const a = old.rounds[round][match].entries.map((entry) => entry?.id ?? null) as [
        string | null,
        string | null,
      ];
      const b = current.entries.map((entry) => entry?.id ?? null) as [string | null, string | null];
      const room = rooms.find((value) => value.round === round && value.match === match) ?? null;
      // Saved room assignments remain authoritative if the current catalog has changed.
      const previous = room?.participants ?? a;
      const changed = previous.some((id, i) => id !== b[i]);
      const clearedWinner = Boolean(
        before.winners[round][match] &&
        before.winners[round][match] !== after.winners[round][match],
      );
      return changed || clearedWinner
        ? [
            {
              round,
              match,
              room,
              before: previous,
              after: b,
              clearedWinner,
              blocked:
                changed && Boolean(room && ['countdown', 'live', 'ended'].includes(room.status)),
            },
          ]
        : [];
    }),
  );
}
