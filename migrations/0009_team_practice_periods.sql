CREATE TABLE team_practice_periods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closing', 'frozen')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  frozen_at INTEGER,
  CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX team_practice_one_open_idx
  ON team_practice_periods(status) WHERE status = 'open';

ALTER TABLE rooms ADD COLUMN team_practice_period_id TEXT REFERENCES team_practice_periods(id);
ALTER TABLE rooms ADD COLUMN team_group TEXT CHECK (team_group IS NULL OR team_group IN ('K', '1-2', '3-5', '6-12'));
ALTER TABLE rooms ADD COLUMN creator_team_id TEXT REFERENCES teams(id);
ALTER TABLE rooms ADD COLUMN student_created INTEGER NOT NULL DEFAULT 0 CHECK (student_created IN (0, 1));
ALTER TABLE rooms ADD COLUMN self_room_expires_at INTEGER;

CREATE UNIQUE INDEX rooms_one_active_self_room_per_team_idx
  ON rooms(creator_team_id)
  WHERE student_created = 1 AND status IN ('open', 'full', 'countdown', 'live');
CREATE INDEX rooms_team_practice_period_idx
  ON rooms(team_practice_period_id, status);
CREATE INDEX rooms_self_expiry_idx
  ON rooms(self_room_expires_at) WHERE student_created = 1 AND status IN ('open', 'full');

-- The app checks groups for readable errors; this trigger protects the write
-- against a concurrent membership/grade change between its read and insert.
CREATE TRIGGER student_room_team_group_guard_before_insert
BEFORE INSERT ON room_entries
WHEN (SELECT student_created FROM rooms WHERE id = NEW.room_id) = 1
BEGIN
  SELECT CASE WHEN NEW.team_id IS NULL
    THEN RAISE(ABORT, 'student room requires team') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM team_members WHERE team_id = NEW.team_id) <> 3
    THEN RAISE(ABORT, 'student room requires complete team') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM team_members tm
    LEFT JOIN student_grade_resolution g ON g.user_id = tm.user_id
    WHERE tm.team_id = NEW.team_id AND
      (g.team_group IS NULL OR g.team_group <>
        (SELECT team_group FROM rooms WHERE id = NEW.room_id))
  ) THEN RAISE(ABORT, 'student room team group mismatch') END;
END;

CREATE TABLE team_match_results (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  team_practice_period_id TEXT NOT NULL REFERENCES team_practice_periods(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  side TEXT NOT NULL CHECK (side IN ('A', 'B')),
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'draw', 'loss')),
  points INTEGER NOT NULL CHECK (points IN (0, 1, 3)),
  team_score INTEGER NOT NULL CHECK (team_score >= 0),
  team_name_snapshot TEXT NOT NULL,
  roster_snapshot_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  settled_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, team_id),
  UNIQUE (room_id, side)
);
CREATE INDEX team_match_results_period_team_idx
  ON team_match_results(team_practice_period_id, team_id, settled_at);

CREATE TABLE team_period_standings (
  team_practice_period_id TEXT NOT NULL REFERENCES team_practice_periods(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  team_name_snapshot TEXT NOT NULL,
  wins INTEGER NOT NULL,
  draws INTEGER NOT NULL,
  losses INTEGER NOT NULL,
  points INTEGER NOT NULL,
  matches INTEGER NOT NULL,
  frozen_at INTEGER NOT NULL,
  PRIMARY KEY (team_practice_period_id, team_id)
);
