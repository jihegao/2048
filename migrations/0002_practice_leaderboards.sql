ALTER TABLE users
  ADD COLUMN grade_level INTEGER
  CHECK (grade_level IS NULL OR grade_level BETWEEN 1 AND 12);

CREATE INDEX users_grade_student_idx
  ON users(grade_level, student_no)
  WHERE role = 'student';

CREATE INDEX practice_results_period_user_idx
  ON practice_results(ended_at, user_id);

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
