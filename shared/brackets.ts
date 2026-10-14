export const bracketKinds = ['teams8', 'players16'] as const;
export type BracketKind = (typeof bracketKinds)[number];
export interface BracketEntry {
  id: string;
  name: string;
  label: string;
  logo: string | null;
  memberCount?: number;
}
export interface BracketState {
  title: string;
  names: string[];
  winners: (string | null)[][];
}
export interface BracketSnapshot {
  state: BracketState;
  revision: number;
  updatedAt: string | null;
}
export interface BracketData extends BracketSnapshot {
  catalog: BracketEntry[];
}
export interface BracketSlot {
  text: string;
  entry: BracketEntry | null;
  error: 'unknown' | 'ambiguous' | 'repeated' | null;
}
export interface BracketMatch {
  entries: (BracketEntry | null)[];
  winner: BracketEntry | null;
}
export const bracketSize = (kind: BracketKind) => (kind === 'teams8' ? 8 : 16);
export const normalizeBracketName = (name: string) => name.trim().normalize('NFC');
export function emptyBracket(kind: BracketKind): BracketState {
  const size = bracketSize(kind);
  return {
    title: '',
    names: Array<string>(size).fill(''),
    winners: Array.from({ length: Math.log2(size) }, (_, round) =>
      Array<string | null>(size / 2 ** (round + 1)).fill(null),
    ),
  };
}
export function projectBracket(kind: BracketKind, catalog: BracketEntry[], state: BracketState) {
  const byLabel = new Map<string, BracketEntry[]>();
  const byName = new Map<string, BracketEntry[]>();
  for (const entry of catalog) {
    for (const [map, value] of [
      [byLabel, entry.label],
      [byName, entry.name],
    ] as const) {
      const key = normalizeBracketName(value);
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
  }
  const slots: BracketSlot[] = state.names.map((text) => {
    const key = normalizeBracketName(text);
    if (!key) return { text, entry: null, error: null };
    const matches = byLabel.get(key) ?? byName.get(key) ?? [];
    return matches.length === 1
      ? { text, entry: matches[0], error: null }
      : { text, entry: null, error: matches.length ? 'ambiguous' : 'unknown' };
  });
  const counts = new Map<string, number>();
  slots.forEach((slot) => {
    if (slot.entry) counts.set(slot.entry.id, (counts.get(slot.entry.id) ?? 0) + 1);
  });
  slots.forEach((slot) => {
    if (slot.entry && counts.get(slot.entry.id)! > 1) {
      slot.entry = null;
      slot.error = 'repeated';
    }
  });
  let participants = slots.map((slot) => slot.entry);
  const clean = emptyBracket(kind);
  clean.title = state.title;
  clean.names = [...state.names];
  const rounds: BracketMatch[][] = clean.winners.map((round, r) => {
    const matches = round.map((_, m) => {
      const entries = [participants[m * 2] ?? null, participants[m * 2 + 1] ?? null];
      const winner =
        entries[0] && entries[1]
          ? (entries.find((entry) => entry?.id === state.winners[r]?.[m]) ?? null)
          : null;
      clean.winners[r][m] = winner?.id ?? null;
      return { entries, winner };
    });
    participants = matches.map((match) => match.winner);
    return matches;
  });
  return { slots, rounds, state: clean, champion: rounds.at(-1)![0].winner };
}
function clearPath(state: BracketState, round: number, match: number) {
  for (let r = round; r < state.winners.length; r++, match = Math.floor(match / 2))
    state.winners[r][match] = null;
}
export function changeBracketName(
  kind: BracketKind,
  catalog: BracketEntry[],
  state: BracketState,
  slot: number,
  name: string,
) {
  if (slot < 0 || slot >= bracketSize(kind) || state.names[slot] === name) return state;
  const next = {
    ...state,
    names: [...state.names],
    winners: state.winners.map((round) => [...round]),
  };
  next.names[slot] = name;
  clearPath(next, 0, Math.floor(slot / 2));
  return projectBracket(kind, catalog, next).state;
}
export function chooseBracketWinner(
  kind: BracketKind,
  catalog: BracketEntry[],
  state: BracketState,
  round: number,
  match: number,
  id: string,
) {
  const projected = projectBracket(kind, catalog, state);
  const current = projected.rounds[round]?.[match];
  if (
    !current ||
    !current.entries[0] ||
    !current.entries[1] ||
    !current.entries.some((entry) => entry?.id === id)
  )
    return state;
  if (current.winner?.id === id) return state;
  clearPath(projected.state, round, match);
  projected.state.winners[round][match] = id;
  return projectBracket(kind, catalog, projected.state).state;
}
