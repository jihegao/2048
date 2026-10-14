import { describe, expect, it } from 'vitest';
import {
  changeBracketName,
  chooseBracketWinner,
  emptyBracket,
  projectBracket,
  type BracketEntry,
  type BracketKind,
} from '../../shared/brackets';
const catalog: BracketEntry[] = Array.from({ length: 18 }, (_, i) => ({
  id: `id-${i}`,
  name: `参赛者${i + 1}`,
  label: `参赛者${i + 1} · 一班 · S${i}`,
  logo: `icon${(i % 9) + 1}`,
}));
function seed(kind: BracketKind) {
  let state = emptyBracket(kind);
  state.names.forEach((_, i) => {
    state = changeBracketName(kind, catalog, state, i, catalog[i].name);
  });
  return state;
}
describe('online bracket integrity', () => {
  it.each(['teams8', 'players16'] as const)(
    'advances %s through both wings into a valid champion',
    (kind) => {
      let state = seed(kind);
      state.winners.forEach((round, r) =>
        round.forEach((_, m) => {
          const entry = projectBracket(kind, catalog, state).rounds[r][m].entries[0]!;
          state = chooseBracketWinner(kind, catalog, state, r, m, entry.id);
        }),
      );
      expect(projectBracket(kind, catalog, state).champion?.id).toBe('id-0');
      expect(projectBracket(kind, catalog, JSON.parse(JSON.stringify(state))).champion?.id).toBe(
        'id-0',
      );
      state = chooseBracketWinner(kind, catalog, state, 0, 0, 'id-1');
      expect(state.winners[1][0]).toBeNull();
      expect(state.winners[1][1]).not.toBeNull();
      expect(projectBracket(kind, catalog, state).champion).toBeNull();
    },
  );
  it('never retains a prior logo or winner after typing an unknown or duplicate name', () => {
    let state = chooseBracketWinner('teams8', catalog, seed('teams8'), 0, 0, 'id-0');
    state = changeBracketName('teams8', catalog, state, 0, '未知队伍');
    expect(projectBracket('teams8', catalog, state).slots[0]).toMatchObject({
      entry: null,
      error: 'unknown',
    });
    expect(state.winners[0][0]).toBeNull();
    state = changeBracketName('teams8', catalog, state, 0, catalog[1].label);
    expect(
      projectBracket('teams8', catalog, state)
        .slots.slice(0, 2)
        .every((slot) => slot.error === 'repeated'),
    ).toBe(true);
  });
  it('disambiguates students with the same name by class and student number', () => {
    const students = [
      { ...catalog[0], name: '同名', label: '同名 · 一班 · S0' },
      { ...catalog[1], name: '同名', label: '同名 · 二班 · S1' },
    ];
    let state = changeBracketName('players16', students, emptyBracket('players16'), 0, '同名');
    expect(projectBracket('players16', students, state).slots[0].error).toBe('ambiguous');
    state = changeBracketName('players16', students, state, 0, students[0].label);
    expect(projectBracket('players16', students, state).slots[0].entry?.id).toBe('id-0');
  });
  it('rejects an injected champion without valid preceding winners and clears removed participants', () => {
    const state = seed('teams8');
    state.winners[2][0] = 'id-0';
    expect(projectBracket('teams8', catalog, state).champion).toBeNull();
    expect(projectBracket('teams8', catalog.slice(1), state).slots[0].entry).toBeNull();
    expect(chooseBracketWinner('teams8', catalog, state, 0, 0, 'id-17')).toEqual(state);
  });
});
