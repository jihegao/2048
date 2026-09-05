ALTER TABLE users
ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0);

ALTER TABLE sessions
ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0);
