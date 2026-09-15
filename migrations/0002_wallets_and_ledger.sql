-- 0002_wallets_and_ledger.sql
-- Wallets, transfers, and the immutable double-entry ledger.
--
-- DESIGN: a wallet has no balance column. The balance is DERIVED by summing
-- this wallet's ledger entries. Nothing in this schema can be UPDATEd to change
-- money -- the only way to move value is to append a matched debit/credit pair.

CREATE TYPE wallet_kind AS ENUM ('user', 'system');
CREATE TYPE entry_direction AS ENUM ('debit', 'credit');

CREATE TABLE wallets (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    kind       wallet_kind NOT NULL DEFAULT 'user',
    label      text NOT NULL,
    -- Single-currency by scope decision; the column exists so the CHECK below
    -- documents the constraint rather than leaving it implicit.
    currency   char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    -- Only system wallets may go negative. A system wallet is the counterparty
    -- for funding: money entering the system is a debit against it, which is
    -- what keeps SUM(debits) = SUM(credits) true globally even for deposits.
    allow_negative boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wallets_only_system_may_go_negative
        CHECK (NOT allow_negative OR kind = 'system')
);

CREATE INDEX wallets_user_id_idx ON wallets (user_id);

-- A transfer row exists if and only if the transfer committed. There is no
-- 'pending' or 'failed' state to model: the ledger entries, the transfer row,
-- and the idempotency record are all written in ONE database transaction, so a
-- failure rolls back every trace of the attempt.
CREATE TABLE transfers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
    dest_wallet_id   uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
    amount           bigint NOT NULL CHECK (amount > 0),
    reference        text,
    initiated_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT transfers_distinct_wallets CHECK (source_wallet_id <> dest_wallet_id)
);

CREATE INDEX transfers_source_wallet_idx ON transfers (source_wallet_id);
CREATE INDEX transfers_dest_wallet_idx ON transfers (dest_wallet_id);

CREATE TABLE ledger_entries (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id uuid NOT NULL REFERENCES transfers (id) ON DELETE RESTRICT,
    wallet_id   uuid NOT NULL REFERENCES wallets (id) ON DELETE RESTRICT,
    direction   entry_direction NOT NULL,
    amount      bigint NOT NULL CHECK (amount > 0),
    -- Stored generated column: credits add, debits subtract. Deriving a balance
    -- is then SUM(signed_amount), and the global invariant is simply
    -- SUM(signed_amount) = 0 across every row in the table.
    signed_amount bigint GENERATED ALWAYS AS (
        CASE WHEN direction = 'credit' THEN amount ELSE -amount END
    ) STORED,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Covering index for balance derivation: the aggregate never touches the heap.
CREATE INDEX ledger_entries_wallet_balance_idx
    ON ledger_entries (wallet_id) INCLUDE (signed_amount);

CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);

-- Exactly one debit and one credit per transfer, never more than one entry per
-- (transfer, wallet, direction).
CREATE UNIQUE INDEX ledger_entries_one_per_side_idx
    ON ledger_entries (transfer_id, direction);


-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
-- The project's central claim is that balances are never UPDATEd. Enforce that
-- in the database rather than trusting application discipline: any UPDATE or
-- DELETE against the ledger raises, including from psql or a future migration.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% on % is forbidden: ledger records are append-only',
        TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER transfers_immutable
    BEFORE UPDATE OR DELETE ON transfers
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();


-- ---------------------------------------------------------------------------
-- Double-entry balance enforcement
-- ---------------------------------------------------------------------------
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger runs at COMMIT, not at
-- statement time. That is what makes it usable here: mid-transaction the
-- transfer legitimately has one entry, and only the final state must balance.
--
-- This is the database-level proof of correctness requirements 1 and 7. A
-- transaction that writes a debit without its matching credit CANNOT commit --
-- not "should not", cannot. Even a bug in the service layer that inserts a
-- single entry aborts at COMMIT rather than corrupting the ledger.

CREATE OR REPLACE FUNCTION assert_transfer_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    debit_total  bigint;
    credit_total bigint;
    entry_count  int;
BEGIN
    SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0),
        COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0),
        COUNT(*)
    INTO debit_total, credit_total, entry_count
    FROM ledger_entries
    WHERE transfer_id = NEW.transfer_id;

    IF entry_count <> 2 THEN
        RAISE EXCEPTION
            'transfer % has % ledger entries, expected exactly 2',
            NEW.transfer_id, entry_count
            USING ERRCODE = 'check_violation';
    END IF;

    IF debit_total <> credit_total THEN
        RAISE EXCEPTION
            'transfer % is unbalanced: debits=% credits=%',
            NEW.transfer_id, debit_total, credit_total
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_transfer_balanced();
