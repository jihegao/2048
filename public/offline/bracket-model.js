/* Classic script intentionally supports file://. No network or module loader is required. */
(function (root) {
  'use strict';
  const normalize = (name) => name.trim().normalize('NFC');

  function create(size, catalog, saved) {
    if (size !== 4 && size !== 8) throw new RangeError('Expected 4 or 8 teams');
    const byName = new Map();
    for (const team of catalog) {
      if (
        !team ||
        typeof team.id !== 'string' ||
        !team.id ||
        typeof team.name !== 'string' ||
        !team.name.trim()
      )
        continue;
      const key = normalize(team.name);
      byName.set(key, [...(byName.get(key) || []), team]);
    }
    const names = Array.from({ length: size }, (_, index) =>
      saved?.version === 1 && saved.size === size && typeof saved.names?.[index] === 'string'
        ? saved.names[index].slice(0, 80)
        : '',
    );
    const winners = Array.from({ length: Math.log2(size) }, (_, round) =>
      Array.from({ length: size / 2 ** (round + 1) }, (_, index) =>
        saved?.version === 1 &&
        saved.size === size &&
        typeof saved.winners?.[round]?.[index] === 'string'
          ? saved.winners[round][index]
          : null,
      ),
    );

    function slots() {
      const counts = new Map();
      names.forEach((name) => counts.set(normalize(name), (counts.get(normalize(name)) || 0) + 1));
      return names.map((name) => {
        const key = normalize(name);
        if (!key) return { name, team: null, error: null };
        const matches = byName.get(key) || [];
        if (matches.length === 0) return { name, team: null, error: 'unknown' };
        if (matches.length > 1) return { name, team: null, error: 'ambiguous' };
        if (counts.get(key) > 1) return { name, team: null, error: 'repeated' };
        const team = matches[0];
        return { name, team, error: team.logo || team.glyph ? null : 'missingLogo' };
      });
    }

    function rounds() {
      let participants = slots().map((slot) => slot.team);
      return winners.map((roundWinners, round) => {
        const matches = roundWinners.map((selected, index) => {
          const teams = [participants[index * 2], participants[index * 2 + 1]];
          // A saved winner is valid only when both current opponents are resolved.
          const winner =
            teams[0] && teams[1] ? teams.find((team) => team.id === selected) || null : null;
          winners[round][index] = winner?.id || null;
          return { teams, winner };
        });
        participants = matches.map((match) => match.winner);
        return matches;
      });
    }

    function invalidate(round, index) {
      for (let current = round; current < winners.length; current += 1) {
        winners[current][index] = null;
        index = Math.floor(index / 2);
      }
    }

    function setName(index, name) {
      if (!Number.isInteger(index) || index < 0 || index >= size || typeof name !== 'string')
        return;
      if (names[index] === name) return;
      names[index] = name.slice(0, 80);
      invalidate(0, Math.floor(index / 2));
      rounds();
    }

    function choose(round, index, side) {
      const match = rounds()[round]?.[index];
      if (!match || (side !== 0 && side !== 1) || !match.teams[0] || !match.teams[1]) return false;
      const id = match.teams[side].id;
      if (winners[round][index] !== id) {
        invalidate(round, index);
        winners[round][index] = id;
      }
      return true;
    }

    function serialize() {
      rounds();
      return { version: 1, size, names: [...names], winners: winners.map((round) => [...round]) };
    }

    return { size, slots, rounds, setName, choose, serialize };
  }

  root.KnockoutBracket = { create };
})(window);
