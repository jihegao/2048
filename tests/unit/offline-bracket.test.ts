import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface Team {
  id: string;
  name: string;
  logo?: string;
  glyph?: string;
}
interface Match {
  teams: Array<Team | null>;
  winner: Team | null;
}
interface Model {
  slots(): Array<{ name: string; team: Team | null; error: string | null }>;
  rounds(): Match[][];
  setName(index: number, name: string): void;
  choose(round: number, index: number, side: number): boolean;
  serialize(): {
    version: number;
    size: number;
    names: string[];
    winners: Array<Array<string | null>>;
  };
}
const scope = {
  window: {} as {
    KnockoutBracket: { create(size: number, catalog: Team[], saved?: unknown): Model };
  },
};
runInNewContext(readFileSync('public/offline/bracket-model.js', 'utf8'), scope);
const create = scope.window.KnockoutBracket.create;
const teams: Team[] = Array.from({ length: 8 }, (_, index) => ({
  id: `team-${index}`,
  name: `队伍${index + 1}`,
  logo: `teams/logos/icon${index + 1}.svg`,
}));

function seed(size: number) {
  const model = create(size, teams);
  teams.slice(0, size).forEach((team, index) => model.setName(index, team.name));
  return model;
}

describe('offline knockout progression', () => {
  it.each([4, 8])('advances %s teams to a champion and restores a backup', (size) => {
    const model = seed(size);
    model
      .rounds()
      .forEach((round, index) =>
        round.forEach((_, match) => expect(model.choose(index, match, 0)).toBe(true)),
      );
    expect(model.rounds().at(-1)![0].winner?.id).toBe('team-0');
    const restored = create(size, teams, JSON.parse(JSON.stringify(model.serialize())));
    expect(restored.rounds().at(-1)![0].winner?.id).toBe('team-0');
  });

  it('clears downstream results when a winner changes, preserving the other branch', () => {
    const model = seed(8);
    for (let round = 0; round < 3; round++)
      for (let match = 0; match < 8 / 2 ** (round + 1); match++) model.choose(round, match, 0);
    model.choose(0, 0, 1);
    const rounds = model.rounds();
    expect(rounds[0][0].winner?.id).toBe('team-1');
    expect(rounds[1][0].winner).toBeNull();
    expect(rounds[1][1].winner?.id).toBe('team-4');
    expect(rounds[2][0].winner).toBeNull();
  });

  it('does not retain a stale logo or winner for unknown, repeated, or ambiguous names', () => {
    const model = seed(4);
    model.choose(0, 0, 0);
    model.setName(0, '不存在的队伍');
    expect(model.slots()[0]).toMatchObject({ team: null, error: 'unknown' });
    expect(model.rounds()[0][0].winner).toBeNull();
    expect(model.choose(0, 0, 0)).toBe(false);
    model.setName(0, teams[1].name);
    expect(model.slots()[0].error).toBe('repeated');
    expect(model.slots()[1].team).toBeNull();
    const duplicate = create(4, [...teams, { ...teams[0], id: 'duplicate' }]);
    duplicate.setName(0, teams[0].name);
    expect(duplicate.slots()[0]).toMatchObject({ team: null, error: 'ambiguous' });
  });

  it('restores only winners belonging to the current valid matchup', () => {
    const model = seed(4);
    const saved = model.serialize();
    saved.winners = [['team-7', 'team-2'], ['team-2']];
    const restored = create(4, teams, saved);
    expect(restored.rounds()[0][0].winner).toBeNull();
    expect(restored.rounds()[1][0].winner).toBeNull();
    expect(
      create(8, teams, saved)
        .slots()
        .every((slot) => !slot.name),
    ).toBe(true);
  });
});
