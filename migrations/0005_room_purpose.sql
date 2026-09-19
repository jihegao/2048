ALTER TABLE rooms
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'official'
  CHECK (purpose IN ('official', 'friendly'));

CREATE INDEX rooms_purpose_mode_finished_idx
  ON rooms(purpose, mode, finished_at DESC);
