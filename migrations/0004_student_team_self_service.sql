ALTER TABLE teams
  ADD COLUMN creator_id TEXT REFERENCES users(id);

ALTER TABLE teams
  ADD COLUMN logo TEXT;

ALTER TABLE teams
  ADD COLUMN deleted_at INTEGER;

CREATE INDEX teams_creator_idx
  ON teams(creator_id)
  WHERE creator_id IS NOT NULL AND deleted_at IS NULL;

-- A student may own at most one active team. Membership inserts for a user who
-- already owns a different active team must hard-fail so D1 batch transactions
-- roll back the paired team insert atomically.
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
