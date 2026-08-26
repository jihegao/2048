PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  student_no TEXT,
  display_name TEXT NOT NULL,
  class_name TEXT,
  locale TEXT CHECK (locale IS NULL OR locale IN ('zh-CN', 'en')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (role = 'student' AND student_no IS NOT NULL AND class_name IS NOT NULL AND login_id = student_no)
    OR (role = 'teacher' AND student_no IS NULL)
  )
);

CREATE UNIQUE INDEX users_student_no_unique
  ON users(student_no)
  WHERE student_no IS NOT NULL;
CREATE INDEX users_class_student_idx ON users(class_name, student_no);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_team_idx ON team_members(team_id);

CREATE TRIGGER team_member_limit_before_insert
BEFORE INSERT ON team_members
WHEN (SELECT COUNT(*) FROM team_members WHERE team_id = NEW.team_id) >= 3
BEGIN
  SELECT RAISE(ABORT, '团队成员不能超过三人');
END;

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('duel', 'team_3v3')),
  duration_minutes INTEGER NOT NULL DEFAULT 5 CHECK (duration_minutes BETWEEN 1 AND 10),
  status TEXT NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'full', 'countdown', 'live', 'ended', 'cancelled')
  ),
  created_by TEXT NOT NULL REFERENCES users(id),
  engine_version TEXT,
  seed TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  locked_at INTEGER,
  starts_at INTEGER,
  ends_at INTEGER,
  finished_at INTEGER,
  finish_reason TEXT CHECK (
    finish_reason IS NULL OR finish_reason IN ('time_limit', 'all_game_over')
  ),
  winner_side TEXT CHECK (winner_side IS NULL OR winner_side IN ('A', 'B', 'draw')),
  settled_at INTEGER
);

CREATE INDEX rooms_status_created_idx ON rooms(status, created_at DESC);
CREATE INDEX rooms_mode_status_idx ON rooms(mode, status);

CREATE TABLE room_entries (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('A', 'B')),
  student_id TEXT REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  joined_by TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, side),
  CHECK ((student_id IS NOT NULL) <> (team_id IS NOT NULL))
);

CREATE INDEX room_entries_student_idx ON room_entries(student_id);
CREATE INDEX room_entries_team_idx ON room_entries(team_id);

CREATE TABLE active_participations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('A', 'B'))
);

CREATE INDEX active_participations_room_idx ON active_participations(room_id);

CREATE TABLE match_players (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id),
  side TEXT NOT NULL CHECK (side IN ('A', 'B')),
  score INTEGER NOT NULL CHECK (score >= 0),
  max_tile INTEGER NOT NULL CHECK (max_tile >= 2),
  max_tile_reached_at INTEGER NOT NULL,
  valid_move_count INTEGER NOT NULL CHECK (valid_move_count >= 0),
  game_over INTEGER NOT NULL CHECK (game_over IN (0, 1)),
  final_board_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'draw')),
  team_total_score INTEGER NOT NULL CHECK (team_total_score >= 0),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX match_players_user_room_idx ON match_players(user_id, room_id);
CREATE INDEX match_players_team_room_idx ON match_players(team_id, room_id);

CREATE TABLE practice_results (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine_version TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  max_tile INTEGER NOT NULL CHECK (max_tile >= 2),
  valid_move_count INTEGER NOT NULL CHECK (valid_move_count >= 0),
  final_board_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL CHECK (ended_at >= started_at)
);

CREATE INDEX practice_results_user_ended_idx ON practice_results(user_id, ended_at DESC);

CREATE TABLE import_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('users', 'teams')),
  checksum TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  inserted_count INTEGER NOT NULL CHECK (inserted_count >= 0),
  updated_count INTEGER NOT NULL CHECK (updated_count >= 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  committed_at INTEGER NOT NULL
);

CREATE INDEX import_jobs_type_committed_idx ON import_jobs(type, committed_at DESC);
