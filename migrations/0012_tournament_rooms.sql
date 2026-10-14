-- Independent events preserve the former one-per-kind bracket records.
CREATE TABLE tournament_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('teams8', 'players16')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  mutation_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX tournament_events_kind_updated_idx ON tournament_events(kind, updated_at DESC);
INSERT INTO tournament_events (id, kind, state_json, revision, mutation_id, created_by, updated_by, created_at, updated_at)
SELECT 'legacy-' || kind, kind, state_json, revision, 'legacy', updated_by, updated_by, updated_at, updated_at FROM tournament_brackets;

-- Old cached clients may still save the one-per-kind API during rollout.
-- Mirror those saves until the imported event is managed by the new UI.
CREATE TRIGGER tournament_legacy_guard BEFORE UPDATE ON tournament_brackets
WHEN EXISTS (SELECT 1 FROM tournament_events WHERE id = 'legacy-' || OLD.kind AND mutation_id <> 'legacy')
BEGIN
  SELECT RAISE(ABORT, 'TOURNAMENT_SELECTION_REQUIRED');
END;
CREATE TRIGGER tournament_legacy_insert AFTER INSERT ON tournament_brackets
BEGIN
  INSERT INTO tournament_events (id, kind, state_json, revision, mutation_id, created_by, updated_by, created_at, updated_at)
  VALUES ('legacy-' || NEW.kind, NEW.kind, NEW.state_json, NEW.revision, 'legacy', NEW.updated_by, NEW.updated_by, NEW.updated_at, NEW.updated_at);
END;
CREATE TRIGGER tournament_legacy_update AFTER UPDATE ON tournament_brackets
BEGIN
  UPDATE tournament_events SET state_json = NEW.state_json, revision = NEW.revision, updated_by = NEW.updated_by, updated_at = NEW.updated_at WHERE id = 'legacy-' || NEW.kind AND mutation_id = 'legacy';
END;

CREATE TABLE tournament_rooms (
  event_id TEXT NOT NULL REFERENCES tournament_events(id),
  round_index INTEGER NOT NULL,
  match_index INTEGER NOT NULL,
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id),
  participant_a TEXT,
  participant_b TEXT,
  roster_revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, round_index, match_index)
);
CREATE TABLE tournament_room_history (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES tournament_events(id),
  round_index INTEGER NOT NULL,
  match_index INTEGER NOT NULL,
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id),
  replaced_at INTEGER NOT NULL,
  replaced_by TEXT NOT NULL REFERENCES users(id)
);
CREATE INDEX tournament_room_history_event_idx ON tournament_room_history(event_id);
CREATE TABLE tournament_audit (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES tournament_events(id),
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  occurred_at INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT
);
CREATE INDEX tournament_audit_event_idx ON tournament_audit(event_id, occurred_at DESC);

-- These guards execute inside the same D1 transaction as a save/join/start.
CREATE TRIGGER tournament_roster_guard BEFORE UPDATE OF participant_a, participant_b ON tournament_rooms
WHEN (OLD.participant_a IS NOT NEW.participant_a OR OLD.participant_b IS NOT NEW.participant_b)
AND OLD.room_id = NEW.room_id
AND (SELECT status FROM rooms WHERE id = OLD.room_id) IN ('countdown', 'live', 'ended')
BEGIN
  SELECT RAISE(ABORT, 'TOURNAMENT_ROOM_LOCKED');
END;

CREATE TRIGGER tournament_roster_release AFTER UPDATE OF participant_a, participant_b ON tournament_rooms
WHEN OLD.room_id = NEW.room_id AND (OLD.participant_a IS NOT NEW.participant_a OR OLD.participant_b IS NOT NEW.participant_b)
BEGIN
  DELETE FROM active_participations WHERE room_id = NEW.room_id AND side IN (
    SELECT side FROM room_entries WHERE room_id = NEW.room_id
    AND COALESCE(student_id, team_id) IS NOT CASE side WHEN 'A' THEN NEW.participant_a ELSE NEW.participant_b END
  );
  DELETE FROM room_entries WHERE room_id = NEW.room_id
    AND COALESCE(student_id, team_id) IS NOT CASE side WHEN 'A' THEN NEW.participant_a ELSE NEW.participant_b END;
  UPDATE rooms SET
    status = CASE WHEN (SELECT COUNT(*) FROM room_entries WHERE room_id = NEW.room_id) = 2 THEN 'full' ELSE 'open' END,
    locked_at = CASE WHEN EXISTS (SELECT 1 FROM room_entries WHERE room_id = NEW.room_id) THEN locked_at ELSE NULL END
  WHERE id = NEW.room_id AND status IN ('open', 'full');
END;

CREATE TRIGGER tournament_entry_guard BEFORE INSERT ON room_entries
WHEN EXISTS (SELECT 1 FROM tournament_rooms WHERE room_id = NEW.room_id)
AND NOT EXISTS (
  SELECT 1 FROM tournament_rooms tr JOIN tournament_events e ON e.id = tr.event_id
  JOIN rooms r ON r.id = tr.room_id
  WHERE tr.room_id = NEW.room_id AND e.archived_at IS NULL AND r.status IN ('open', 'full')
    AND tr.participant_a IS NOT NULL AND tr.participant_b IS NOT NULL
    AND COALESCE(NEW.student_id, NEW.team_id) = CASE NEW.side WHEN 'A' THEN tr.participant_a ELSE tr.participant_b END
    AND ((e.kind = 'players16' AND NEW.student_id IS NOT NULL) OR (e.kind = 'teams8' AND NEW.team_id IS NOT NULL))
)
BEGIN
  SELECT RAISE(ABORT, 'TOURNAMENT_ENTRY_CHANGED');
END;

CREATE TRIGGER tournament_start_guard BEFORE UPDATE OF status ON rooms
WHEN NEW.status = 'countdown' AND EXISTS (SELECT 1 FROM tournament_rooms WHERE room_id = NEW.id)
AND NOT EXISTS (
  SELECT 1 FROM tournament_rooms tr JOIN tournament_events e ON e.id = tr.event_id
  WHERE tr.room_id = NEW.id AND e.archived_at IS NULL
    AND tr.participant_a IS NOT NULL AND tr.participant_b IS NOT NULL
    AND EXISTS (SELECT 1 FROM room_entries WHERE room_id = NEW.id AND side = 'A' AND COALESCE(student_id, team_id) = tr.participant_a)
    AND EXISTS (SELECT 1 FROM room_entries WHERE room_id = NEW.id AND side = 'B' AND COALESCE(student_id, team_id) = tr.participant_b)
)
BEGIN
  SELECT RAISE(ABORT, 'TOURNAMENT_ENTRY_CHANGED');
END;

CREATE TRIGGER tournament_archive_guard BEFORE UPDATE OF archived_at ON tournament_events
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
AND EXISTS (SELECT 1 FROM tournament_rooms tr JOIN rooms r ON r.id = tr.room_id WHERE tr.event_id = OLD.id AND r.status IN ('countdown', 'live'))
BEGIN
  SELECT RAISE(ABORT, 'TOURNAMENT_ROOM_LOCKED');
END;
CREATE TRIGGER tournament_archive_rooms AFTER UPDATE OF archived_at ON tournament_events
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
  UPDATE rooms SET status = 'cancelled', updated_at = NEW.updated_at WHERE id IN (SELECT room_id FROM tournament_rooms WHERE event_id = NEW.id) AND status IN ('open', 'full');
  DELETE FROM active_participations WHERE room_id IN (SELECT room_id FROM tournament_rooms WHERE event_id = NEW.id);
END;
