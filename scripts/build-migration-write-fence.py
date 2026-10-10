#!/usr/bin/env python3
"""Generate a reversible operational D1 fence; this script never accesses a remote DB."""
import argparse
from pathlib import Path

TABLES = [
    'users', 'sessions', 'teams', 'team_members', 'rooms', 'room_entries',
    'active_participations', 'match_players', 'practice_results', 'import_jobs',
    'leaderboard_periods', 'timed_practice_sessions', 'timed_practice_results',
    'team_practice_periods', 'team_match_results', 'team_period_standings', 'd1_migrations',
]
CONTROL = '__2048_write_fence'
PHASE = f"COALESCE((SELECT phase FROM {CONTROL} WHERE id = 1), 'frozen')"


def build():
    lines = [
        f"CREATE TABLE IF NOT EXISTS {CONTROL} (id INTEGER PRIMARY KEY CHECK (id = 1), phase TEXT NOT NULL CHECK (phase IN ('normal','drain','frozen')), epoch INTEGER NOT NULL DEFAULT 0, changed_at INTEGER NOT NULL DEFAULT 0);",
        f"INSERT INTO {CONTROL}(id,phase) VALUES (1,'normal') ON CONFLICT(id) DO NOTHING;",
    ]
    for table in TABLES:
        for event in ['INSERT', 'UPDATE', 'DELETE']:
            lines.append(f"CREATE TRIGGER IF NOT EXISTS __2048_fence_{table}_{event.lower()} BEFORE {event} ON {table} WHEN {PHASE} = 'frozen' BEGIN SELECT RAISE(ABORT, '2048_MIGRATION_FROZEN'); END;")
    for table in ['rooms', 'room_entries', 'active_participations', 'timed_practice_sessions']:
        lines.append(f"CREATE TRIGGER IF NOT EXISTS __2048_drain_{table}_insert BEFORE INSERT ON {table} WHEN {PHASE} != 'normal' BEGIN SELECT RAISE(ABORT, '2048_MIGRATION_DRAINING'); END;")
    lines.append(f"CREATE TRIGGER IF NOT EXISTS __2048_drain_room_start BEFORE UPDATE OF status ON rooms WHEN {PHASE} != 'normal' AND NEW.status = 'countdown' AND OLD.status NOT IN ('countdown','live') BEGIN SELECT RAISE(ABORT, '2048_MIGRATION_DRAINING'); END;")
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(build())
    print(f"Generated {len(TABLES) * 3} freeze and 5 admission triggers; no remote changes")


if __name__ == '__main__':
    main()
