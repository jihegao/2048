-- Independent display brackets; these do not modify room or match results.
CREATE TABLE tournament_brackets (
  kind TEXT PRIMARY KEY CHECK (kind IN ('teams8', 'players16')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at INTEGER NOT NULL
);
