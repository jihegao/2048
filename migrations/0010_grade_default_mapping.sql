-- Update grade resolution without changing any imported source value,
-- explicit teacher confirmation, team membership, or historical result.
-- A known numeric grade wins. Otherwise, an explicit confirmation wins.
-- Remaining K-prefixed labels map to K; all other unresolved labels,
-- including NULL grade_level plus NULL grade_code, map to grade 12.
DROP VIEW student_grade_resolution;

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
