ALTER TABLE practice_results ADD COLUMN mode TEXT NOT NULL DEFAULT 'unlimited'
  CHECK (mode = 'unlimited');

CREATE TABLE timed_practice_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'timed_3m' CHECK (mode = 'timed_3m'),
  duration_seconds INTEGER NOT NULL DEFAULT 180 CHECK (duration_seconds = 180),
  engine_version TEXT NOT NULL,
  seed INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL CHECK (deadline_at = started_at + 180000),
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  moves_json TEXT NOT NULL DEFAULT '[]',
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled')),
  settled_at INTEGER
);
CREATE UNIQUE INDEX timed_practice_one_active_user_idx
  ON timed_practice_sessions(user_id) WHERE status = 'active';
CREATE INDEX timed_practice_expiry_idx
  ON timed_practice_sessions(deadline_at) WHERE status = 'active';

CREATE TABLE timed_practice_results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES timed_practice_sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode = 'timed_3m'),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds = 180),
  engine_version TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  max_tile INTEGER NOT NULL CHECK (max_tile >= 2),
  valid_move_count INTEGER NOT NULL CHECK (valid_move_count >= 0),
  final_board_json TEXT NOT NULL,
  grade_at_completion TEXT
    CHECK (grade_at_completion IS NULL OR grade_at_completion IN
      ('K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12')),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  end_reason TEXT NOT NULL CHECK (end_reason IN ('time_limit', 'game_over')),
  settled_at INTEGER NOT NULL
);
CREATE INDEX timed_practice_top_idx ON timed_practice_results(
  user_id, score DESC, max_tile DESC, valid_move_count ASC, ended_at ASC, id ASC
);
