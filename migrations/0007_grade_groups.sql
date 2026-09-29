-- Keep the imported label. A teacher may explicitly resolve a coded label
-- without replacing that original value.
ALTER TABLE users ADD COLUMN confirmed_grade TEXT
  CHECK (confirmed_grade IS NULL OR confirmed_grade IN
    ('K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'));

-- Historical results keep their original record but never enter a new ranking.
-- Results completed after this migration get an explicit completion snapshot.
ALTER TABLE practice_results ADD COLUMN grade_at_completion TEXT
  CHECK (grade_at_completion IS NULL OR grade_at_completion IN
    ('K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'));
ALTER TABLE practice_results ADD COLUMN grade_source TEXT NOT NULL DEFAULT 'legacy_unranked'
  CHECK (grade_source IN ('legacy_unranked', 'completion'));

CREATE VIEW student_grade_resolution AS
WITH resolved AS (
  SELECT id AS user_id, grade_level AS raw_grade_level, grade_code AS raw_grade_code,
    CASE
      WHEN grade_code IS NULL AND grade_level BETWEEN 1 AND 12
        AND (confirmed_grade IS NULL OR confirmed_grade = CAST(grade_level AS TEXT))
        THEN CAST(grade_level AS TEXT)
      WHEN grade_level IS NULL AND grade_code = 'K'
        AND (confirmed_grade IS NULL OR confirmed_grade = 'K') THEN 'K'
      WHEN grade_level IS NULL AND grade_code IS NOT NULL AND grade_code <> 'K'
        THEN confirmed_grade
      ELSE NULL
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

CREATE INDEX practice_results_grade_ended_idx
  ON practice_results(grade_at_completion, ended_at, user_id);

-- Also protect legacy writers that omit the new columns during a rolling deploy.
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

-- Existing anomalous teams are untouched. Every future membership insertion
-- checks the committed members inside the same D1/SQLite write transaction.
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

-- Updating a student's grade must not silently corrupt an existing team.
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
