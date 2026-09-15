# Ledger — digital wallet backend with a double-entry ledger

A wallet API where **balances are derived, never stored**. There is no
`wallets.balance` column to update, drift, or corrupt. A balance is the sum of
that wallet's immutable ledger entries, and every transfer writes a matched
debit and credit inside one database transaction.

The engineering goal is provable correctness under concurrent load: no
overdrafts, no deadlocks, no duplicate transfers, and `SUM(debits) =
SUM(credits)` at all times.

```
Express + TypeScript · PostgreSQL · raw pg (explicit SELECT ... FOR UPDATE)
Jest + Supertest · Zod · Pino · Docker Compose · GitHub Actions
```

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Data model](#data-model)
- [API](#api)
- [Concurrency and idempotency design](#concurrency-and-idempotency-design)
- [Tests](#tests)
- [Project layout](#project-layout)

---

## Quick start

From a clean clone:

```bash
cp .env.example .env
docker compose up -d        # Postgres on :5432
npm install
npm run migrate
npm run seed                # optional demo data
npm test
```

`npm test` runs unit tests and integration tests. The integration suite creates
and migrates a separate `ledger_test` database on every run, so it never touches
your development data.

To run the server:

```bash
npm run dev                 # tsx watch
# or
npm run build && npm start
```

### Without Docker

Any reachable Postgres 14+ works. Create the role and databases, then point
`DATABASE_URL` and `TEST_DATABASE_URL` at them:

```sql
CREATE ROLE ledger LOGIN PASSWORD 'ledger' CREATEDB;
CREATE DATABASE ledger OWNER ledger;
```

The suite creates `ledger_test` itself, which is why the role needs `CREATEDB`.

> **Connection limits.** The stress tests hold dozens of connections in lock
> waits simultaneously. Postgres' default `max_connections = 100` is enough for
> the suite as configured (pool max 60), but if you raise `PG_POOL_MAX`, raise
> `max_connections` to match or you will see connection errors that look like
> concurrency bugs and are not.

### Demo credentials

`npm run seed` creates `admin@demo.ledger` (admin), `alice@demo.ledger`, and
`bob@demo.ledger`, all with password `demo-password-123`.

---

## Architecture

```
                      ┌──────────────────────────────────────────┐
  HTTP                │  Express app (src/app.ts)                │
  ──────────────────► │                                          │
                      │  requestId → pino-http → json(64kb)      │
                      └────────────────┬─────────────────────────┘
                                       │
                 ┌─────────────────────┼─────────────────────┐
                 ▼                     ▼                     ▼
          ┌─────────────┐      ┌──────────────┐      ┌──────────────┐
          │ /v1/auth    │      │ /v1/wallets  │      │ /v1/transfers│
          │ rateLimit   │      │ requireAuth  │      │ requireAuth  │
          │ Zod parse   │      │ Zod parse    │      │ Zod parse    │
          └──────┬──────┘      └──────┬───────┘      └──────┬───────┘
                 │                    │                     │
                 │              requireIdempotencyKey (mutating routes)
                 │                    │                     │
                 └────────────────────┼─────────────────────┘
                                      ▼
                       ┌──────────────────────────────┐
                       │ withTransaction()            │
                       │   BEGIN READ COMMITTED       │
                       │                              │
                       │  ┌────────────────────────┐  │
                       │  │ runIdempotent()        │  │  ① claim key
                       │  │  INSERT ... ON CONFLICT│  │     (unique index
                       │  │    DO NOTHING          │  │      elects one winner)
                       │  └───────────┬────────────┘  │
                       │              ▼               │
                       │  ┌────────────────────────┐  │
                       │  │ executeTransfer()      │  │
                       │  │  ② lock wallets ASC    │  │  ← deadlock-free
                       │  │  ③ derive balance      │  │
                       │  │  ④ overdraft check     │  │
                       │  │  ⑤ INSERT transfer     │  │
                       │  │  ⑥ INSERT both entries │  │
                       │  └───────────┬────────────┘  │
                       │              ▼               │
                       │        store response        │  ⑦
                       │           COMMIT             │
                       └──────────────┬───────────────┘
                                      ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ PostgreSQL                                                   │
   │                                                              │
   │  ledger_entries ── append-only (UPDATE/DELETE triggers raise)│
   │        │                                                     │
   │        └── DEFERRABLE constraint trigger at COMMIT:          │
   │            exactly 2 entries per transfer, debits = credits  │
   │                                                              │
   │  balance(w) := SUM(signed_amount) WHERE wallet_id = w        │
   └──────────────────────────────────────────────────────────────┘
```

Steps ① through ⑦ all happen in **one** transaction. That is the single most
important property of the design: the idempotency claim, the money movement, and
the stored response commit together or not at all.

### Layering

| Layer | Responsibility | Knows about |
|---|---|---|
| `routes` | HTTP shape, Zod parsing, status codes | Express |
| `service` | Business rules, locking, SQL | `pg`, domain |
| `domain` | Pure arithmetic and invariants | nothing |
| `db` | Pool, transactions, migrations | `pg` |

`src/domain` has no imports from anywhere else in the project and no I/O, which
is what lets the ledger rules be unit tested without a database.

---

## Data model

```
users ──┬── wallets ──┬── ledger_entries ──── transfers
        │             │         ▲                 ▲
        │             │         └─────────────────┘
        │             │            2 rows per transfer
        │             │            (one debit, one credit)
        │
        ├── refresh_tokens   (rotation family, hashed)
        └── idempotency_keys (unique per user+key)
```

**`ledger_entries`** is the only place value exists.

```sql
signed_amount bigint GENERATED ALWAYS AS (
  CASE WHEN direction = 'credit' THEN amount ELSE -amount END
) STORED
```

So a balance is `SUM(signed_amount)` for one wallet, and the global invariant is
`SUM(signed_amount) = 0` across the entire table.

**Money is integer minor units (cents) in `bigint`.** There is no floating point
anywhere on the money path. `pg` returns `int8` as a string and we deliberately
keep it that way — coercing to a JS number would silently lose precision above
2⁵³. Amounts are `bigint` in TypeScript and **strings in JSON**, because JSON
numbers cannot hold `int8` safely.

**Funding is not a magic balance insert** — there is no balance to insert into.
A `system` wallet, permitted to go negative, is the counterparty for money
entering the system. So even a deposit writes a matched pair and the global
invariant holds for seeded and production data alike.

### Database-enforced guarantees

These are enforced by the schema, so they survive a bug in the service layer:

| Guarantee | Mechanism |
|---|---|
| Ledger rows never change | `BEFORE UPDATE OR DELETE` trigger raises |
| Every transfer has exactly 2 entries | `DEFERRABLE INITIALLY DEFERRED` constraint trigger at COMMIT |
| Debits equal credits per transfer | same trigger |
| One debit and one credit, never two of a side | unique index on `(transfer_id, direction)` |
| Amounts are positive | `CHECK (amount > 0)` |
| Only system wallets go negative | `CHECK (NOT allow_negative OR kind = 'system')` |
| One idempotency record per user+key | `UNIQUE (user_id, idempotency_key)` |

`tests/integration/schema-invariants.test.ts` proves each of these by going
around the API and talking to Postgres directly.

---

## API

Base path `/v1`. All responses are JSON. Errors look like:

```json
{
  "error": { "code": "insufficient_funds", "message": "...", "details": { } },
  "requestId": "…"
}
```

Branch on `error.code`, not on the message.

### Conventions

- **Auth**: `Authorization: Bearer <accessToken>` on everything except
  register, login, refresh, and health.
- **Idempotency-Key**: **required** on every mutating request
  (`POST`/`PUT`/`PATCH`/`DELETE`), 8–255 chars of `[A-Za-z0-9_.:-]`.
  Use a fresh UUID per logical operation and reuse it when retrying that
  operation.
- **Amounts** are strings of integer minor units: `"2500"` is $25.00.
  Requests also accept a JSON integer.

### Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| `POST` | `/v1/auth/register` | `{email, password}` | password ≥ 12 chars. Returns user + token pair |
| `POST` | `/v1/auth/login` | `{email, password}` | Returns user + token pair |
| `POST` | `/v1/auth/refresh` | `{refreshToken}` | Rotates. Old token becomes invalid |
| `POST` | `/v1/auth/logout` | — | Revokes all refresh tokens for the user |
| `GET` | `/v1/auth/me` | — | Current user id and role |

Access tokens are HS256 JWTs valid for **15 minutes**. Refresh tokens are opaque
random strings valid for **7 days** and rotate on every use.

`POST /v1/auth/refresh` is deliberately **exempt** from `Idempotency-Key`:
rotation is non-idempotent by design, and replaying a cached response would hand
back the same refresh token twice, defeating rotation. The refresh token is
itself the single-use key.

<details>
<summary>Example</summary>

```bash
curl -s localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alice@demo.ledger","password":"demo-password-123"}'
```
```json
{
  "user": { "id": "…", "email": "alice@demo.ledger", "role": "customer" },
  "accessToken": "eyJhbGciOiJIUzI1NiIs…",
  "refreshToken": "kR3f…",
  "expiresIn": 900
}
```
</details>

### Wallets

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/wallets` | `{label}`. Needs `Idempotency-Key` |
| `GET` | `/v1/wallets` | Your wallets, each with a derived balance |
| `GET` | `/v1/wallets/:id` | One wallet + balance |
| `GET` | `/v1/wallets/:id/balance` | **The balance endpoint** — always computed |
| `GET` | `/v1/wallets/:id/ledger` | Entries, `?limit=` (≤200) `&offset=` |

A user may own **one or more** wallets. Accessing a wallet you do not own
returns **404, not 403** — a 403 would confirm the id is real and turn the
endpoint into an id-enumeration oracle. Admins may read any wallet.

<details>
<summary>Example</summary>

```bash
curl -s localhost:3000/v1/wallets/$WALLET/balance -H "authorization: Bearer $TOKEN"
```
```json
{
  "walletId": "…",
  "currency": "USD",
  "balance": "37500",
  "derivedAt": "2026-09-15T12:00:00.000Z"
}
```
</details>

### Transfers

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/transfers` | `{sourceWalletId, destWalletId, amount, reference?}` |
| `GET` | `/v1/transfers/:id` | Visible to either counterparty |

You may only move money **out of** a wallet you own; anyone may be the
destination. A replayed request returns the original response with
`Idempotent-Replay: true`.

<details>
<summary>Example</summary>

```bash
curl -s localhost:3000/v1/transfers \
  -H "authorization: Bearer $TOKEN" \
  -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"sourceWalletId":"…","destWalletId":"…","amount":"2500","reference":"rent"}'
```
```json
{
  "id": "…",
  "sourceWalletId": "…",
  "destWalletId": "…",
  "amount": "2500",
  "reference": "rent",
  "createdAt": "2026-09-15T12:00:00.000Z",
  "sourceBalance": "7500",
  "destBalance": "2500"
}
```
</details>

### Status codes

| Code | Meaning |
|---|---|
| `400` | Validation failed, or `Idempotency-Key` missing/malformed |
| `401` | Missing, invalid, or expired token |
| `403` | Authenticated but wrong role |
| `404` | Not found, **or** exists but is not yours |
| `409` | Email taken, or key reused with a different payload |
| `422` | `insufficient_funds` — well-formed, but the money is not there |
| `429` | Auth rate limit |

`422` rather than `400` for overdrafts is deliberate: the request was
well-formed and the client had no way to know it would fail, since the balance
may have changed between their read and their write.

---

## Concurrency and idempotency design

Four decisions carry the correctness argument. `DESIGN_NOTES.md` covers them in
depth; this is the summary.

### 1. Isolation level: READ COMMITTED, chosen not inherited

The anomaly to prevent is a **lost update on a derived balance**: two transfers
both read balance 100, both approve a withdrawal of 100, both append a debit,
wallet ends at −100.

READ COMMITTED does not prevent this on its own — the balance is an aggregate
over rows that *do not exist yet*, so there is no tuple for the database to
detect a conflict on. REPEATABLE READ does not prevent it either: the two
transactions insert *different* rows and never touch a common tuple, so snapshot
isolation sees no conflict.

We close the hole explicitly with row locks instead (below).

**Why not SERIALIZABLE**, which would also prevent it? Because it prevents it
*optimistically*, by aborting one transaction with `40001` and requiring a
retry. Under the workload this project exists to survive — 200 parallel
transfers against one wallet — every transaction conflicts on the same
predicate, so the abort rate approaches 100% and throughput collapses into a
retry storm. Pessimistic locking gives the same guarantee for this access
pattern with bounded, retry-free latency: contenders queue instead of failing.

The full justification lives in a comment on `TransactionOptions` in
`src/db/tx.ts`.

### 2. Deterministic lock ordering

Every transfer locks **all** wallets it touches with `SELECT … FOR UPDATE`,
in **ascending wallet id order**, before reading any balance.

Locking in request order (source, then destination) deadlocks: simultaneous
A→B and B→A take `(A,B)` and `(B,A)`, each holding what the other wants.
Under a global ordering, whichever id sorts lower is acquired first by *both*,
so no transaction can hold the higher id while waiting for the lower one. The
wait-for graph is acyclic by construction, and the argument extends unchanged to
three or more wallets.

The rule is implemented in `lockWalletsInOrder()` in
`src/modules/transfers/transfers.service.ts`, documented in a comment at that
exact spot, and the ordering function itself is unit tested in
`tests/unit/ledger.test.ts`.

Locks are taken one statement at a time rather than with a combined
`WHERE id = ANY(…) ORDER BY id FOR UPDATE`. The combined form almost certainly
locks in sorted order too, but that rests on `LockRows` staying above `Sort` in
the query plan. The ordering is load-bearing, so it is a property of the code
rather than of the planner.

**The invariant this establishes:** the wallet row is the designated *mutex* for
that wallet's slice of the ledger. Any code path appending entries for a wallet
must first hold that wallet's row lock.

### 3. Idempotency that holds under simultaneous duplicates

Sequential retry protection is easy. Simultaneous duplicates are the hard case,
and the whole mechanism is one unique index:

```sql
UNIQUE (user_id, idempotency_key)
```

1. Claim the key with `INSERT … ON CONFLICT DO NOTHING RETURNING id`.
2. The **loser** gets no error and no row — Postgres makes its INSERT *wait* on
   the winner's uncommitted tuple. By the time it returns zero rows, the winner
   has already committed or aborted. There is no window where both proceed.
3. If the winner committed, the loser's next statement sees the finished row
   (READ COMMITTED takes a fresh snapshot per statement) and replays the stored
   response.
4. If the winner **aborted**, its tuple is dead, so the loser's own INSERT
   succeeds and it becomes the new winner.

Step 4 means a failed attempt *releases* the key rather than poisoning it —
which is what you want: a transfer rejected for insufficient funds should be
retryable with the same key once the wallet is funded.

Step 3 is why `runIdempotent()` asserts READ COMMITTED at runtime. Under
REPEATABLE READ the transaction's snapshot predates the winner's commit, the
follow-up SELECT would find nothing, and the design would break subtly. The
assertion turns that into an immediate, explicit failure.

The request body is fingerprinted with **canonical JSON** (keys sorted
recursively), so a client whose serialiser emits keys in a different order on
retry is not falsely accused of reusing a key with a different payload.

**Lock ordering across resource types**: the idempotency row is always acquired
*before* any wallet row, on every path. Mixing those orderings would reintroduce
exactly the cycle the wallet ordering eliminates.

### 4. Overdrafts are impossible, not merely checked

The overdraft check is sound *because* it runs while holding the source wallet's
row lock. No other transaction can append entries for that wallet between the
balance read and the insert, so the balance being decided on cannot go stale.

Belt and braces: a `system` wallet is the only kind permitted to go negative,
enforced by a `CHECK` constraint rather than application logic.

---

## Tests

```bash
npm test                  # everything
npm run test:unit         # pure, no database
npm run test:integration  # real Postgres
TEST_LOG_LEVEL=debug npm test   # see application logs
```

**107 tests**, all against a real Postgres for anything touching the database.
There is no mocked database in the concurrency tests — mocked, they would assert
nothing.

| Suite | Covers |
|---|---|
| `unit/money` | bigint parsing, precision past 2⁵³, float rejection |
| `unit/ledger` | balance derivation, matched pairs, global invariant, lock ordering |
| `unit/rateLimit` | bucket isolation per credential and route |
| `integration/transfers` | happy path (both ledger rows verified), overdraft with no partial write, validation |
| `integration/idempotency` | sequential replay, **40 concurrent duplicates → exactly one transfer**, payload-mismatch conflict, per-user key scoping |
| `integration/concurrency` | **200 parallel transfers**, exact balance, zero drift, overdraft impossible under contention |
| `integration/deadlock` | bidirectional A↔B, three-wallet cycle, contention under scarce funds |
| `integration/auth` | rotation, reuse rejection, family revocation, `alg:none` rejection |
| `integration/authorization` | cross-user reads and transfers blocked |
| `integration/schema-invariants` | the database refuses single-sided entries and ledger mutation |

### A note on what the stress test actually proves

The obvious stress test — *"fire 200 parallel transfers, assert the balance is
exact"* — **does not discriminate in this architecture**, and it is worth
knowing why before trusting it.

Because balances are derived by `SUM()` over append-only rows, concurrent
appends never overwrite each other. The sum comes out exact and drift stays zero
*even with no locking at all*. A completely unsynchronised implementation passes
that assertion every time. Money is conserved either way.

What concurrency actually breaks in a derived-balance ledger is the
**read-then-write decision**: the overdraft check. So the discriminating test
funds a wallet with *half* of what the burst attempts and asserts that exactly
the affordable number of transfers commit.

That distinction is not theoretical. Against the deliberately unlocked first
implementation (see the commit history), the naive assertions passed and the
underfunded one failed with:

```
● permits exactly as many concurrent transfers as the wallet can afford
  expect(received).toBeGreaterThanOrEqual(expected)
    Expected: >= 0n
    Received:    -2200n
```

Both variants are kept. The exact-balance one guards conservation; the
underfunded one guards serialisation.

Similarly, the deadlock tests assert on a **deadlock counter**, not on HTTP
status. `withTransaction` retries `40P01` up to three times, so a lock-ordering
bug could otherwise hide behind the retry and still return `201`.

### CI

`.github/workflows/ci.yml` runs on every push and PR against a **real Postgres
16 service container**, on Node 20 and 22: typecheck → unit → integration →
migrate from scratch → seed → assert `SUM(signed_amount) = 0` over the whole
ledger.

---

## Project layout

```
migrations/            numbered SQL, checksum-guarded, one transaction each
scripts/
  migrate.ts           npm run migrate
  seed.ts              demo data, funded via real double-entry transfers
src/
  app.ts               express wiring
  index.ts             server + graceful shutdown
  config.ts            Zod-parsed env, fails fast at boot
  db/
    pool.ts            pg pool; int8 stays a string on purpose
    tx.ts              withTransaction + the isolation-level rationale
    migrate.ts         advisory-locked migration runner
  domain/              PURE. no I/O, no imports from the rest of the app
    money.ts           bigint minor units
    ledger.ts          balance derivation, matched pairs, lockOrder()
  middleware/          auth, rbac, idempotency guard, rate limit, errors
  modules/
    auth/              argon2id, JWT, rotating refresh with reuse detection
    wallets/           derived balances, ownership
    transfers/         THE CORE — lock ordering lives here
    idempotency/       runIdempotent()
tests/
  unit/                no database
  integration/         real Postgres
  setup/               test db lifecycle, fixtures, assertion helpers
```

### Environment

See `.env.example`. `.env` is gitignored and no secrets are committed; the
example values are placeholders that fail the ≥32-char check only if you
shorten them, and must be replaced for any real deployment
(`openssl rand -hex 32`).

---

## Scope

**Built:** auth with refresh rotation, RBAC, multiple wallets per user,
transfers, double-entry ledger, derived balances, mandatory idempotency, row
locking with deterministic ordering, full test suite, CI.

**Deliberately not built:** webhooks, HMAC verification, refunds/reversals,
reconciliation cron, admin dashboard, multi-currency, FX, PDF statements, fraud
rules, and rate limiting beyond the auth endpoints.

### Known limitations

- **The rate limiter is in-process**, so behind N replicas the effective limit
  is N× the configured value. Fine for this scope; a real deployment moves it to
  Redis or the edge.
- **Balance derivation is O(entries per wallet).** Correct at any scale, slower
  as history grows. The covering index on `(wallet_id) INCLUDE (signed_amount)`
  keeps it index-only. A wallet with millions of entries would want periodic
  checkpoint rows — a cached *sum*, still derived and still verifiable, rather
  than a mutable balance column.
- **Lock contention is per wallet.** A single wallet is a serialisation point by
  design. That is the correct trade for money, but a very hot wallet will queue.
