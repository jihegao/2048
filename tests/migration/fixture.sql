PRAGMA defer_foreign_keys=ON;
CREATE TABLE active_participations (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('A', 'B'))
);
CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL);
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
CREATE TABLE leaderboard_periods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(trim(name)) > 0),
  CHECK (end_at > start_at)
);
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
, grade_at_completion TEXT
  CHECK (grade_at_completion IS NULL OR grade_at_completion IN
    ('K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12')), grade_source TEXT NOT NULL DEFAULT 'legacy_unranked'
  CHECK (grade_source IN ('legacy_unranked', 'completion')), mode TEXT NOT NULL DEFAULT 'unlimited'
  CHECK (mode = 'unlimited'));
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
, purpose TEXT NOT NULL DEFAULT 'official'
  CHECK (purpose IN ('official', 'friendly')), team_practice_period_id TEXT REFERENCES team_practice_periods(id), team_group TEXT CHECK (team_group IS NULL OR team_group IN ('K', '1-2', '3-5', '6-12')), creator_team_id TEXT REFERENCES teams(id), student_created INTEGER NOT NULL DEFAULT 0 CHECK (student_created IN (0, 1)), self_room_expires_at INTEGER);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
, credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0));
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
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
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
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, creator_id TEXT REFERENCES users(id), logo TEXT, deleted_at INTEGER);
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
  updated_at INTEGER NOT NULL, grade_level INTEGER
  CHECK (grade_level IS NULL OR grade_level BETWEEN 1 AND 12), credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0), grade_code TEXT, confirmed_grade TEXT
  CHECK (confirmed_grade IS NULL OR confirmed_grade IN
    ('K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12')),
  CHECK (
    (role = 'student' AND student_no IS NOT NULL AND class_name IS NOT NULL AND login_id = student_no)
    OR (role = 'teacher' AND student_no IS NULL)
  )
);
INSERT INTO "active_participations" VALUES('student-1','waiting-room','A');
INSERT INTO "active_participations" VALUES('student-2','waiting-room','A');
INSERT INTO "active_participations" VALUES('student-3','waiting-room','A');
INSERT INTO "d1_migrations" VALUES(1,'0001_initial.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(2,'0002_practice_leaderboards.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(3,'0003_credential_versions.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(4,'0004_student_team_self_service.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(5,'0005_room_purpose.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(6,'0006_grade_code.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(7,'0007_grade_groups.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(8,'0008_timed_practice.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(9,'0009_team_practice_periods.sql','2026-10-10T00:00:00Z');
INSERT INTO "d1_migrations" VALUES(10,'0010_grade_default_mapping.sql','2026-10-10T00:00:00Z');
INSERT INTO "import_jobs" VALUES('import-job','users','synthetic-checksum',7,7,0,'teacher',1);
INSERT INTO "leaderboard_periods" VALUES('leaderboard','合成周期',1,1000000,'teacher',1,2);
INSERT INTO "match_players" VALUES('ended-room','student-1','A','A',4,16,2,5,0,'[[2,4],[8,16]]','win',100);
INSERT INTO "match_players" VALUES('ended-room','student-2','A','A',8,16,2,5,0,'[[2,4],[8,16]]','win',100);
INSERT INTO "match_players" VALUES('ended-room','student-3','A','A',12,16,2,5,0,'[[2,4],[8,16]]','win',100);
INSERT INTO "match_players" VALUES('ended-room','student-4','B','B',16,16,2,5,0,'[[2,4],[8,16]]','loss',100);
INSERT INTO "match_players" VALUES('ended-room','student-5','B','B',20,16,2,5,0,'[[2,4],[8,16]]','loss',100);
INSERT INTO "match_players" VALUES('ended-room','student-6','B','B',24,16,2,5,0,'[[2,4],[8,16]]','loss',100);
INSERT INTO "practice_results" VALUES('legacy-practice','legacy-challenge','student-1','synthetic',64,16,9,'[[2,4],[8,16]]',1,2,NULL,'legacy_unranked','unlimited');
INSERT INTO "practice_results" VALUES('new-practice','new-challenge','student-2','synthetic',128,32,18,'[[2,4],[16,32]]',3,4,'6','completion','unlimited');
INSERT INTO "room_entries" VALUES('ended-room','A',NULL,'A','student-1',1);
INSERT INTO "room_entries" VALUES('ended-room','B',NULL,'B','student-4',1);
INSERT INTO "room_entries" VALUES('waiting-room','A',NULL,'A','student-1',1);
INSERT INTO "rooms" VALUES('ended-room','SYNTHETIC-END','合成已结束比赛','team_3v3',5,'ended','teacher',NULL,NULL,1,3,NULL,2,3,3,'time_limit','A',3,'official','closed-period','6-12',NULL,0,NULL);
INSERT INTO "rooms" VALUES('waiting-room','SYNTHETIC-WAIT','合成待开始房间','team_3v3',5,'open','student-1',NULL,NULL,1,2,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'official','open-period','6-12','A',1,999999);
INSERT INTO "sessions" VALUES('synthetic-session-hash','student-1',1,999999,2,2);
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('d1_migrations',10);
INSERT INTO "team_match_results" VALUES('ended-room','closed-period','A','A','win',3,100,'合成队A','["student-1", "student-2", "student-3"]',2,3);
INSERT INTO "team_match_results" VALUES('ended-room','closed-period','B','B','loss',0,100,'合成队B','["student-4", "student-5", "student-6"]',2,3);
INSERT INTO "team_members" VALUES('A','student-1',1);
INSERT INTO "team_members" VALUES('A','student-2',1);
INSERT INTO "team_members" VALUES('A','student-3',1);
INSERT INTO "team_members" VALUES('B','student-4',1);
INSERT INTO "team_members" VALUES('B','student-5',1);
INSERT INTO "team_members" VALUES('B','student-6',1);
INSERT INTO "team_period_standings" VALUES('closed-period','A','合成队A',1,0,0,3,1,3);
INSERT INTO "team_period_standings" VALUES('closed-period','B','合成队B',0,0,1,0,1,3);
INSERT INTO "team_practice_periods" VALUES('closed-period','合成closed-period','frozen','teacher',1,2,3);
INSERT INTO "team_practice_periods" VALUES('open-period','合成open-period','open','teacher',1,NULL,NULL);
INSERT INTO "teams" VALUES('A','SYNTHETIC-A','合成队A',1,2,'student-1','synthetic-logo',NULL);
INSERT INTO "teams" VALUES('B','SYNTHETIC-B','合成队B',1,2,'student-4','synthetic-logo',NULL);
INSERT INTO "timed_practice_results" VALUES('timed-result','timed-session','student-3','timed_3m',180,'synthetic',4,4,1,'[[2,4],[0,0]]','6',1,180001,180001,'time_limit',180001);
INSERT INTO "timed_practice_sessions" VALUES('timed-session','student-3','timed_3m',180,'synthetic',42,1,180001,1,'["left"]','{"score":4}','settled',180001);
INSERT INTO "users" VALUES('teacher','synthetic-teacher','teacher',NULL,'合成教师',NULL,'zh-CN','pfAktb7kMfLtw8wgJZBubS_nHrVo4I6P4QnJxchQ-KA','AAECAwQFBgcICQoLDA0ODw',100000,1,2,NULL,3,NULL,NULL);
INSERT INTO "users" VALUES('student-1','SYNTHETIC-1','student','SYNTHETIC-1','合成学生1','合成班','en','pfAktb7kMfLtw8wgJZBubS_nHrVo4I6P4QnJxchQ-KA','AAECAwQFBgcICQoLDA0ODw',100000,1,2,6,2,NULL,NULL);
INSERT INTO "users" VALUES('student-2','SYNTHETIC-2','student','SYNTHETIC-2','合成学生2','合成班','en','pfAktb7kMfLtw8wgJZBubS_nHrVo4I6P4QnJxchQ-KA','AAECAwQFBgcICQoLDA0ODw',100000,1,2,6,2,NULL,NULL);
INSERT INTO "users" VALUES('student-3','SYNTHETIC-3','student','SYNTHETIC-3','合成学生3','合成班','en','pfAktb7kMfLtw8wgJZBubS_nHrVo4I6P4QnJxchQ-KA','AAECAwQFBgcICQoLDA0ODw',100000,1,2,6,2,NULL,NULL);
INSERT INTO "users" VALUES('student-4','SYNTHETIC-4','student','SYNTHETIC-4','合成学生4','合成班','en','pfAktb7kMfLtw8wgJZBubS_nHrVo4I6P4QnJxchQ-KA','AAECAwQFBgcICQoLDA0ODw',100000,1,2,6,2,NULL,NULL);
INSERT INTO "users" VALUES('student-5','SYNTHETIC-5','student','SYNTHETIC-5','合成学生5','合成班','en','pfAktb7kMfLtw8wgJZBubS_nHrVo4I6P4QnJxchQ-KA','AAECAwQFBgcICQoLDA0ODw',100000,1,2,6,2,NULL,NULL);
INSERT INTO "users" VALUES('student-6','SYNTHETIC-6','student','SYNTHETIC-6','合成学生6','合成班','en','pfAktb7kMfLtw8wgJZBubS_nHrVo4I6P4QnJxchQ-KA','AAECAwQFBgcICQoLDA0ODw',100000,1,2,6,2,NULL,NULL);
INSERT INTO "users" VALUES('student-7','SYNTHETIC-7','student','SYNTHETIC-7','合成学生7','合成班','en','pfAktb7kMfLtw8wgJZBubS_nHrVo4I6P4QnJxchQ-KA','AAECAwQFBgcICQoLDA0ODw',100000,1,2,6,2,NULL,NULL);
CREATE UNIQUE INDEX users_student_no_unique
  ON users(student_no)
  WHERE student_no IS NOT NULL;
CREATE INDEX users_class_student_idx ON users(class_name, student_no);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX team_members_team_idx ON team_members(team_id);
CREATE TRIGGER team_member_limit_before_insert
BEFORE INSERT ON team_members
WHEN (SELECT COUNT(*) FROM team_members WHERE team_id = NEW.team_id) >= 3
BEGIN
  SELECT RAISE(ABORT, '团队成员不能超过三人');
END;
CREATE INDEX rooms_status_created_idx ON rooms(status, created_at DESC);
CREATE INDEX rooms_mode_status_idx ON rooms(mode, status);
CREATE INDEX room_entries_student_idx ON room_entries(student_id);
CREATE INDEX room_entries_team_idx ON room_entries(team_id);
CREATE INDEX active_participations_room_idx ON active_participations(room_id);
CREATE INDEX match_players_user_room_idx ON match_players(user_id, room_id);
CREATE INDEX match_players_team_room_idx ON match_players(team_id, room_id);
CREATE INDEX practice_results_user_ended_idx ON practice_results(user_id, ended_at DESC);
CREATE INDEX import_jobs_type_committed_idx ON import_jobs(type, committed_at DESC);
CREATE INDEX users_grade_student_idx
  ON users(grade_level, student_no)
  WHERE role = 'student';
CREATE INDEX practice_results_period_user_idx
  ON practice_results(ended_at, user_id);
CREATE INDEX leaderboard_periods_time_idx
  ON leaderboard_periods(start_at, end_at);
CREATE TRIGGER leaderboard_period_no_overlap_before_insert
BEFORE INSERT ON leaderboard_periods
WHEN EXISTS (
  SELECT 1
  FROM leaderboard_periods existing
  WHERE NEW.start_at < existing.end_at
    AND NEW.end_at > existing.start_at
)
BEGIN
  SELECT RAISE(ABORT, 'leaderboard period overlaps existing period');
END;
CREATE TRIGGER leaderboard_period_no_overlap_before_update
BEFORE UPDATE OF start_at, end_at ON leaderboard_periods
WHEN EXISTS (
  SELECT 1
  FROM leaderboard_periods existing
  WHERE existing.id <> NEW.id
    AND NEW.start_at < existing.end_at
    AND NEW.end_at > existing.start_at
)
BEGIN
  SELECT RAISE(ABORT, 'leaderboard period overlaps existing period');
END;
CREATE INDEX teams_creator_idx
  ON teams(creator_id)
  WHERE creator_id IS NOT NULL AND deleted_at IS NULL;
CREATE TRIGGER team_member_owned_team_guard_before_insert
BEFORE INSERT ON team_members
WHEN EXISTS (
  SELECT 1 FROM teams t
  WHERE t.creator_id = NEW.user_id
    AND t.deleted_at IS NULL
    AND t.id <> NEW.team_id
)
BEGIN
  SELECT RAISE(ABORT, 'student already owns another team');
END;
CREATE INDEX rooms_purpose_mode_finished_idx
  ON rooms(purpose, mode, finished_at DESC);
CREATE INDEX practice_results_grade_ended_idx
  ON practice_results(grade_at_completion, ended_at, user_id);
CREATE TRIGGER practice_result_grade_snapshot_after_insert
AFTER INSERT ON practice_results
WHEN NEW.grade_source = 'legacy_unranked'
BEGIN
  UPDATE practice_results
  SET grade_at_completion = (
        SELECT ranking_grade FROM student_grade_resolution WHERE user_id = NEW.user_id
      ),
      grade_source = 'completion'
  WHERE id = NEW.id;
END;
CREATE TRIGGER team_member_grade_unresolved_before_insert
BEFORE INSERT ON team_members
WHEN (SELECT team_group FROM student_grade_resolution WHERE user_id = NEW.user_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'student team group unresolved');
END;
CREATE TRIGGER team_member_grade_mismatch_before_insert
BEFORE INSERT ON team_members
WHEN EXISTS (
    SELECT 1 FROM team_members tm
    LEFT JOIN student_grade_resolution g ON g.user_id = tm.user_id
    WHERE tm.team_id = NEW.team_id
      AND (g.team_group IS NULL OR g.team_group <>
        (SELECT team_group FROM student_grade_resolution WHERE user_id = NEW.user_id))
  )
BEGIN
  SELECT RAISE(ABORT, 'team group mismatch');
END;
CREATE TRIGGER team_member_grade_unresolved_before_update
BEFORE UPDATE OF team_id, user_id ON team_members
WHEN (SELECT team_group FROM student_grade_resolution WHERE user_id = NEW.user_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'student team group unresolved');
END;
CREATE TRIGGER team_member_grade_mismatch_before_update
BEFORE UPDATE OF team_id, user_id ON team_members
WHEN EXISTS (
    SELECT 1 FROM team_members tm
    LEFT JOIN student_grade_resolution g ON g.user_id = tm.user_id
    WHERE tm.team_id = NEW.team_id
      AND (tm.team_id <> OLD.team_id OR tm.user_id <> OLD.user_id)
      AND (g.team_group IS NULL OR g.team_group <>
        (SELECT team_group FROM student_grade_resolution WHERE user_id = NEW.user_id))
  )
BEGIN
  SELECT RAISE(ABORT, 'team group mismatch');
END;
CREATE TRIGGER team_member_grade_unresolved_after_update
AFTER UPDATE OF grade_level, grade_code, confirmed_grade ON users
WHEN EXISTS (SELECT 1 FROM team_members WHERE user_id = NEW.id)
  AND (OLD.grade_level IS NOT NEW.grade_level
    OR OLD.grade_code IS NOT NEW.grade_code
    OR OLD.confirmed_grade IS NOT NEW.confirmed_grade)
  AND (SELECT team_group FROM student_grade_resolution WHERE user_id = NEW.id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'student team group unresolved');
END;
CREATE TRIGGER team_member_grade_mismatch_after_update
AFTER UPDATE OF grade_level, grade_code, confirmed_grade ON users
WHEN EXISTS (SELECT 1 FROM team_members WHERE user_id = NEW.id)
  AND (OLD.grade_level IS NOT NEW.grade_level
    OR OLD.grade_code IS NOT NEW.grade_code
    OR OLD.confirmed_grade IS NOT NEW.confirmed_grade)
  AND EXISTS (
    SELECT 1 FROM team_members tm
    LEFT JOIN student_grade_resolution g ON g.user_id = tm.user_id
    WHERE tm.team_id = (SELECT team_id FROM team_members WHERE user_id = NEW.id)
      AND tm.user_id <> NEW.id
      AND (g.team_group IS NULL OR g.team_group <>
        (SELECT team_group FROM student_grade_resolution WHERE user_id = NEW.id))
  )
BEGIN
  SELECT RAISE(ABORT, 'team group mismatch');
END;
CREATE UNIQUE INDEX timed_practice_one_active_user_idx
  ON timed_practice_sessions(user_id) WHERE status = 'active';
CREATE INDEX timed_practice_expiry_idx
  ON timed_practice_sessions(deadline_at) WHERE status = 'active';
CREATE INDEX timed_practice_top_idx ON timed_practice_results(
  user_id, score DESC, max_tile DESC, valid_move_count ASC, ended_at ASC, id ASC
);
CREATE UNIQUE INDEX team_practice_one_open_idx
  ON team_practice_periods(status) WHERE status = 'open';
CREATE UNIQUE INDEX rooms_one_active_self_room_per_team_idx
  ON rooms(creator_team_id)
  WHERE student_created = 1 AND status IN ('open', 'full', 'countdown', 'live');
CREATE INDEX rooms_team_practice_period_idx
  ON rooms(team_practice_period_id, status);
CREATE INDEX rooms_self_expiry_idx
  ON rooms(self_room_expires_at) WHERE student_created = 1 AND status IN ('open', 'full');
CREATE TRIGGER student_room_team_required_before_insert
BEFORE INSERT ON room_entries
WHEN (SELECT student_created FROM rooms WHERE id = NEW.room_id) = 1
  AND NEW.team_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'student room requires team');
END;
CREATE TRIGGER student_room_complete_team_before_insert
BEFORE INSERT ON room_entries
WHEN (SELECT student_created FROM rooms WHERE id = NEW.room_id) = 1
  AND (SELECT COUNT(*) FROM team_members WHERE team_id = NEW.team_id) <> 3
BEGIN
  SELECT RAISE(ABORT, 'student room requires complete team');
END;
CREATE TRIGGER student_room_team_group_mismatch_before_insert
BEFORE INSERT ON room_entries
WHEN (SELECT student_created FROM rooms WHERE id = NEW.room_id) = 1
  AND EXISTS (
    SELECT 1 FROM team_members tm
    LEFT JOIN student_grade_resolution g ON g.user_id = tm.user_id
    WHERE tm.team_id = NEW.team_id AND
      (g.team_group IS NULL OR g.team_group <>
        (SELECT team_group FROM rooms WHERE id = NEW.room_id))
  )
BEGIN
  SELECT RAISE(ABORT, 'student room team group mismatch');
END;
CREATE TRIGGER team_member_active_guard_before_insert
BEFORE INSERT ON team_members
WHEN EXISTS (SELECT 1 FROM active_participations WHERE user_id = NEW.user_id)
   OR EXISTS (
  SELECT 1 FROM team_members tm
  JOIN active_participations ap ON ap.user_id = tm.user_id
  WHERE tm.team_id = NEW.team_id
)
BEGIN
  SELECT RAISE(ABORT, 'team is active in a room');
END;
CREATE TRIGGER team_member_active_guard_before_delete
BEFORE DELETE ON team_members
WHEN EXISTS (
  SELECT 1 FROM team_members tm
  JOIN active_participations ap ON ap.user_id = tm.user_id
  WHERE tm.team_id = OLD.team_id
)
BEGIN
  SELECT RAISE(ABORT, 'team is active in a room');
END;
CREATE TRIGGER team_member_active_guard_before_update
BEFORE UPDATE OF team_id, user_id ON team_members
WHEN EXISTS (SELECT 1 FROM active_participations WHERE user_id = NEW.user_id)
   OR EXISTS (
     SELECT 1 FROM team_members tm
     JOIN active_participations ap ON ap.user_id = tm.user_id
     WHERE tm.team_id = OLD.team_id
   )
   OR EXISTS (
     SELECT 1 FROM team_members tm
     JOIN active_participations ap ON ap.user_id = tm.user_id
     WHERE tm.team_id = NEW.team_id
   )
BEGIN
  SELECT RAISE(ABORT, 'team is active in a room');
END;
CREATE INDEX team_match_results_period_team_idx
  ON team_match_results(team_practice_period_id, team_id, settled_at);
CREATE VIEW student_grade_resolution AS
WITH resolved AS (
  SELECT id AS user_id, grade_level AS raw_grade_level, grade_code AS raw_grade_code,
    CASE
      WHEN grade_level BETWEEN 1 AND 12 THEN CAST(grade_level AS TEXT)
      WHEN confirmed_grade IS NOT NULL THEN confirmed_grade
      WHEN UPPER(LTRIM(grade_code)) LIKE 'K%' THEN 'K'
      ELSE '12'
    END AS ranking_grade
  FROM users WHERE role = 'student'
)
SELECT user_id, raw_grade_level, raw_grade_code, ranking_grade,
  CASE
    WHEN ranking_grade = 'K' THEN 'K'
    WHEN ranking_grade IN ('1', '2') THEN '1-2'
    WHEN ranking_grade IN ('3', '4', '5') THEN '3-5'
    WHEN ranking_grade IN ('6', '7', '8', '9', '10', '11', '12') THEN '6-12'
    ELSE NULL
  END AS team_group
FROM resolved;
