-- 0001_users_and_auth.sql
-- Users, roles, and rotating refresh-token storage.

CREATE TYPE user_role AS ENUM ('customer', 'admin');

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL,
    password_hash text NOT NULL,
    role          user_role NOT NULL DEFAULT 'customer',
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness without depending on the citext extension.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- Refresh tokens are stored only as SHA-256 hashes: a database leak must not
-- yield usable tokens. Rotation is modelled as a linked list within a "family";
-- presenting an already-rotated token revokes the entire family (breach signal).
CREATE TABLE refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    family_id   uuid NOT NULL,
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    replaced_by uuid REFERENCES refresh_tokens (id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_id_idx ON refresh_tokens (family_id);
