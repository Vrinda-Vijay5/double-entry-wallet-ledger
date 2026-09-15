-- 0003_idempotency.sql
-- Idempotency-Key storage.
--
-- The whole concurrency-safety argument rests on ONE thing: the unique index
-- below. Claiming a key is an INSERT that must win or lose that index. Two
-- simultaneous requests carrying the same key cannot both insert; the loser
-- blocks inside the index until the winner's transaction resolves.
--
-- Because the claim, the effect (transfer + ledger entries), and the stored
-- response all live in the SAME transaction, a committed row here always has a
-- committed transfer behind it, and a rolled-back attempt leaves no row at all.
-- There is deliberately no 'in_progress' state: that state exists only inside
-- the owning transaction, where no other session can observe it.

CREATE TABLE idempotency_keys (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    idempotency_key     text NOT NULL,
    endpoint            text NOT NULL,
    -- SHA-256 of the canonicalised request body. Replaying a key with a
    -- different payload is a client bug and must be refused (409), not silently
    -- answered with the first request's result.
    request_fingerprint text NOT NULL,
    -- Populated before COMMIT, in the same transaction that created the effect.
    response_status     int,
    response_body       jsonb,
    transfer_id         uuid REFERENCES transfers (id) ON DELETE RESTRICT,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT idempotency_keys_user_key_unique UNIQUE (user_id, idempotency_key)
);

CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);
