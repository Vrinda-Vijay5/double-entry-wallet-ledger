# Ledger — double-entry wallet backend

[![CI](https://github.com/Vrinda-Vijay5/double-entry-wallet-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/Vrinda-Vijay5/double-entry-wallet-ledger/actions/workflows/ci.yml)

A digital wallet API where **balances are derived, never stored**. There is no
`balance` column to update, drift, or corrupt — a balance is the sum of that
wallet's immutable ledger entries, and every transfer writes a matched debit and
credit inside a single database transaction.

The project's goal is **provable correctness under concurrent load**: no
overdrafts, no deadlocks, no duplicate transfers, and `SUM(debits) =
SUM(credits)` at all times — verified by a test suite that fires hundreds of
parallel requests at a real PostgreSQL instance.

**118 tests · 10 suites · CI on Node 20 & 22 against PostgreSQL 16**

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20+, TypeScript (strict) | — |
| Framework | Express | Explicitly not NestJS — no DI framework needed at this size |
| Database | PostgreSQL 16 | Deferred constraint triggers and row-level locking |
| Data access | Raw `pg` | Explicit `SELECT … FOR UPDATE`; no ORM hiding the locking |
| Validation | Zod | Parse-at-the-boundary, inferred types |
| Auth | Argon2id, JWT, rotating refresh tokens | OWASP-profile hashing, revocable refresh |
| Logging | Pino | Structured JSON with credential redaction |
| Testing | Jest + Supertest | Real Postgres, never a mock, for concurrency |
| CI | GitHub Actions | Postgres service container, Node 20 + 22 matrix |

---

## Key engineering highlights

**Money is never stored as a mutable number.** Balances are derived via
`SUM(signed_amount)` over an append-only ledger. `UPDATE` and `DELETE` on ledger
rows raise a database exception, so the ledger is immutable even from `psql`.

**Core invariants are enforced by PostgreSQL, not application code.** A
`DEFERRABLE INITIALLY DEFERRED` constraint trigger validates at `COMMIT` that
every transfer has exactly two entries whose debits equal its credits. A
transaction that writes a debit without its credit *cannot commit* — not
"should not", cannot. That guarantee survives any future bug in the service layer.

**Deadlock-free by construction.** Transfers lock every wallet they touch in
ascending ID order. Since whichever ID sorts lower is always acquired first by
both parties, the wait-for graph cannot contain a cycle — simultaneous A→B and
B→A transfers queue instead of deadlocking.

**Idempotency that holds under simultaneous duplicates**, not just sequential
retries. The mechanism is a single unique index plus PostgreSQL's
`INSERT … ON CONFLICT DO NOTHING` blocking behaviour. 40 identical concurrent
requests produce exactly one transfer.

**Exact integer arithmetic end to end.** Amounts are `bigint` minor units in
both PostgreSQL and TypeScript, serialised as JSON strings. `int8` is
deliberately left as a string at the driver boundary — coercing it to a JS
number would silently lose precision above 2⁵³.

**The concurrency tests were written to fail first.** See
[the test-design note](#what-the-stress-test-actually-proves) — the obvious
version of a stress test cannot fail in this architecture, and the commit
history shows the real `-2200n` overdraft that the discriminating version caught.

---

## Architecture

```
  HTTP  ─►  requestId ─► pino-http ─► json(64kb)
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   /v1/auth             /v1/wallets           /v1/transfers
   rateLimit            requireAuth           requireAuth
   Zod parse            Zod parse             Zod parse
        └──────── requireIdempotencyKey (mutating routes) ────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │ withTransaction()   BEGIN READ COMMITTED    │
        │                                             │
        │   ① claim Idempotency-Key                   │
        │      INSERT … ON CONFLICT DO NOTHING        │
        │   ② lock wallets in ASCENDING id order      │  ← deadlock-free
        │   ③ derive balance (inside the lock)        │
        │   ④ overdraft check                         │
        │   ⑤ INSERT transfer                         │
        │   ⑥ INSERT both ledger entries (1 stmt)     │
        │   ⑦ store response                          │
        │                     COMMIT                  │
        └─────────────────────┬───────────────────────┘
                              ▼
  ┌──────────────────────────────────────────────────────────┐
  │ PostgreSQL                                               │
  │   ledger_entries — append-only (UPDATE/DELETE triggers)  │
  │   DEFERRABLE trigger @ COMMIT: 2 entries, debits=credits │
  │   balance(w) := SUM(signed_amount) WHERE wallet_id = w    │
  └──────────────────────────────────────────────────────────┘
```

Steps ① – ⑦ share **one** transaction. That is the design's load-bearing
property: the idempotency claim, the money movement, and the stored response
commit together or not at all.

### Layering

| Layer | Responsibility | Depends on |
|---|---|---|
| `routes` | HTTP shape, Zod parsing, status codes | Express |
| `services` | Business rules, locking, SQL | `pg`, domain |
| `domain` | Pure arithmetic and invariants | **nothing** |
| `db` | Pool, transactions, migrations | `pg` |

`src/domain` has no I/O and no imports from the rest of the app, which is what
lets the ledger rules be unit tested without a database.

---

## Setup

```bash
cp .env.example .env
docker compose up -d --wait     # PostgreSQL on :5432
npm install
npm run migrate
npm run seed                    # optional demo data
npm test
```

Run the server with `npm run dev`, or `npm run build && npm start`.

<details>
<summary>Without Docker</summary>

Any PostgreSQL 14+ works. Create the role and database, then point
`DATABASE_URL` / `TEST_DATABASE_URL` at them:

```sql
CREATE ROLE ledger LOGIN PASSWORD 'ledger' CREATEDB;
CREATE DATABASE ledger OWNER ledger;
```

`CREATEDB` is required because the integration suite creates and drops its own
`ledger_test` database on every run.
</details>

<details>
<summary>Demo credentials</summary>

`npm run seed` creates `admin@demo.ledger` (admin), `alice@demo.ledger`, and
`bob@demo.ledger` — password `demo-password-123` for all three.

Funding is not a balance insert. A `system` wallet permitted to go negative acts
as the counterparty, so even seeded money arrives via a real double-entry
transfer and the global invariant holds from the first row.
</details>

---

## API

Base path `/v1`. Errors return `{ error: { code, message, details? }, requestId }` —
branch on `error.code`, not the message.

**Conventions.** Bearer token on everything except register/login/refresh/health.
`Idempotency-Key` is **required on every mutating request**. Amounts are strings
of integer minor units (`"2500"` = $25.00).

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/auth/register` | Create account, returns token pair |
| `POST` | `/v1/auth/login` | Authenticate, returns token pair |
| `POST` | `/v1/auth/refresh` | Rotate refresh token |
| `POST` | `/v1/auth/logout` | Revoke all refresh tokens |
| `GET` | `/v1/auth/me` | Current user and role |
| `POST` | `/v1/wallets` | Create a wallet |
| `GET` | `/v1/wallets` | List own wallets with balances |
| `GET` | `/v1/wallets/:id` | Wallet detail |
| `GET` | `/v1/wallets/:id/balance` | **Derived balance** — always computed |
| `GET` | `/v1/wallets/:id/ledger` | Paginated ledger entries |
| `POST` | `/v1/transfers` | Transfer between wallets |
| `GET` | `/v1/transfers/:id` | Transfer with both ledger entries |

```bash
curl -s localhost:3000/v1/transfers \
  -H "authorization: Bearer $TOKEN" \
  -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"sourceWalletId":"…","destWalletId":"…","amount":"2500","reference":"rent"}'
```

| Status | Meaning |
|---|---|
| `400` | Validation failed, or `Idempotency-Key` missing/malformed |
| `401` / `403` | Bad token / wrong role |
| `404` | Not found — **or exists but isn't yours** (prevents ID enumeration) |
| `409` | Email taken, or key reused with a different payload |
| `422` | `insufficient_funds` — well-formed request, money isn't there |
| `429` | Auth rate limit |

Access tokens are HS256 JWTs valid 15 minutes. Refresh tokens are opaque random
strings valid 7 days, rotate on every use, and are stored only as HMACs.
Presenting an already-rotated token revokes the entire token family.

---

## Concurrency and idempotency design

Full reasoning in **[DESIGN_NOTES.md](DESIGN_NOTES.md)**. Summary:

**Isolation level — READ COMMITTED, chosen deliberately.** The anomaly to prevent
is a lost update on a derived balance: two transfers both read 100, both approve
a withdrawal of 100, both append a debit. Neither READ COMMITTED nor REPEATABLE
READ prevents this, because the balance aggregates rows that *don't exist yet* —
the two transactions never touch a common tuple, so snapshot isolation sees no
conflict. SERIALIZABLE *would* prevent it, but optimistically: under 200 parallel
transfers on one wallet nearly every transaction conflicts on the same predicate,
so the abort rate approaches 100% and throughput collapses into a retry storm.
Pessimistic row locking gives the same guarantee with bounded, retry-free latency.

**Lock ordering.** Every transfer locks all wallets it touches with
`SELECT … FOR UPDATE` in ascending ID order before reading any balance. A
deadlock needs T1 holding X wanting Y while T2 holds Y wanting X; under a global
ordering the lower ID is always acquired first by both, so that state is
unreachable. The argument extends unchanged to three or more wallets.

**The wallet row is a mutex.** It holds no money — it exists so there is a
pre-existing row to serialise on, since you cannot lock rows that don't exist
yet. The rule: *any path appending entries for a wallet must first hold that
wallet's row lock*, which turns read-balance → decide → append into one critical
section.

**Concurrent idempotency.** A unique index on `(user_id, idempotency_key)` elects
one winner. The loser's `INSERT … ON CONFLICT DO NOTHING` *blocks* on the
winner's uncommitted tuple, so by the time it returns zero rows the winner has
already committed or aborted — there is no window where both proceed. If the
winner committed, the loser replays the stored response; if it aborted, the loser
becomes the new winner. Because the claim shares a transaction with the effect,
there is no `in_progress` state for any other session to observe.

---

## Testing

```bash
npm test                  # all 118
npm run test:unit         # pure, no database
npm run test:integration  # real PostgreSQL
```

| Suite | Covers |
|---|---|
| `unit/money` | bigint parsing, precision past 2⁵³, float rejection |
| `unit/ledger` | balance derivation, matched pairs, invariant, lock ordering |
| `unit/rateLimit` | per-credential bucket isolation |
| `integration/transfers` | happy path (both ledger rows verified), overdraft with no partial write |
| `integration/idempotency` | sequential replay, **40 concurrent duplicates → one transfer** |
| `integration/concurrency` | **200 parallel transfers**, exact balance, zero drift |
| `integration/deadlock` | bidirectional A↔B, three-wallet cycle, contention under scarce funds |
| `integration/auth` | rotation, reuse rejection, family revocation, `alg:none` rejection |
| `integration/authorization` | cross-user reads and transfers blocked |
| `integration/schema-invariants` | the database itself refuses single-sided entries |

There is no mocked database anywhere in the concurrency tests — mocked, they
would assert nothing.

### What the stress test actually proves

The obvious stress test — *"fire 200 parallel transfers, assert the balance is
exact"* — **cannot fail in this architecture**, and that is worth understanding
before trusting it.

Because balances are derived by `SUM()` over append-only rows, concurrent appends
never overwrite each other. The sum is exact and drift stays zero *with no
locking at all*. An unsynchronised implementation passes every time. Money is
conserved; the wallet is also overdrawn.

What concurrency actually breaks here is the read-then-write **decision** — the
overdraft check. So the discriminating test funds a wallet with *half* of what
the burst attempts and asserts exactly the affordable number commit. Against the
deliberately unlocked first implementation (see commit `ae50bfb` → `d49b418`):

```
● permits exactly as many concurrent transfers as the wallet can afford
  expect(received).toBeGreaterThanOrEqual(expected)
    Expected: >= 0n
    Received:    -2200n
```

Both variants are kept: one guards conservation, the other serialisation.

Likewise the deadlock tests assert on a **deadlock counter**, not HTTP status.
`withTransaction` retries `40P01`, so a lock-ordering bug could otherwise hide
behind the retry and still return `201`.

---

## Project layout

```
migrations/     numbered SQL, checksum-guarded, one transaction each
scripts/        migrate.ts, seed.ts
src/
  domain/       PURE — no I/O, no app imports (money.ts, ledger.ts)
  db/           pool, withTransaction + isolation rationale, migration runner
  middleware/   auth, RBAC, idempotency guard, rate limit, errors
  modules/
    auth/       Argon2id, JWT, rotating refresh with reuse detection
    wallets/    derived balances, ownership
    transfers/  core — lock ordering lives here
    idempotency/
tests/
  unit/         no database
  integration/  real PostgreSQL
```

---

## Scope and known limitations

**Built:** auth with refresh rotation, RBAC, multiple wallets per user,
transfers, double-entry ledger, derived balances, mandatory idempotency, row
locking with deterministic ordering, full test suite, CI.

**Intentionally out of scope:** webhooks, refunds/reversals, reconciliation cron,
admin dashboard, multi-currency, FX, PDF statements, fraud rules, and rate
limiting beyond auth endpoints.

**Limitations**, stated rather than glossed over:

- **The rate limiter is in-process**, so behind N replicas the effective limit is
  N× the configured value. A production deployment moves it to Redis or the edge.
- **Balance derivation is O(entries per wallet).** Correct at any scale, slower as
  history grows. A covering index keeps it index-only; a wallet with millions of
  entries would want periodic checkpoint rows — a cached *sum*, still derived and
  still verifiable, rather than a mutable balance column.
- **Lock contention is per wallet.** A single wallet is a serialisation point by
  design. Correct for money, but a very hot wallet will queue.

## License

MIT
