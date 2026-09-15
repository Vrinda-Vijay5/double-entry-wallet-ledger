# Design notes

Written for someone who did not write this code and needs to review, extend, or
debug it. It assumes you know SQL and roughly what a transaction is, and explains
everything specific to this system.

The four sections: the lock ordering rationale, the isolation level choice, how
concurrent idempotency works, and the three most subtle bugs this design avoids.

---

## 0. The one idea everything else follows from

**A wallet has no balance column.**

```sql
balance(w) := SELECT SUM(signed_amount) FROM ledger_entries WHERE wallet_id = w
```

Ledger entries are append-only — enforced by a trigger that raises on any
`UPDATE` or `DELETE`, so it holds even against `psql`. Every transfer writes
exactly two rows: a debit on the source and a credit on the destination, in one
transaction.

This choice removes a whole category of bug and creates exactly one new problem,
and it is important to be precise about which is which.

**What it removes:** lost updates on the balance itself. There is no
`UPDATE wallets SET balance = balance - 100` to interleave badly. Two concurrent
transfers append different rows; neither overwrites the other; the sum is exact.
You cannot corrupt a balance through concurrency, because nothing mutates.

**What it creates:** the balance is now an aggregate over rows *that do not exist
yet at read time*. That is invisible to the database's conflict detection. When a
transfer reads a balance to decide whether it may proceed, nothing links that
read to the rows another transaction is about to insert.

So the vulnerable operation is not the arithmetic. It is the **decision**:

```
   read balance  ──►  decide it's affordable  ──►  append debit
                 ▲                            ▲
                 └──── another transaction ───┘
                       appends here, unseen
```

Everything below exists to make that read-decide-write sequence atomic.

---

## 1. Lock ordering

### What we lock, and why a wallet row

Before reading any balance, a transfer takes `SELECT … FOR UPDATE` on **every
wallet row it touches**.

The wallet row itself holds no money. It is used purely as a **mutex for that
wallet's slice of the ledger**. The rule that makes it work:

> Any code path that appends ledger entries for a wallet must first hold that
> wallet's row lock.

Given that rule, the balance read and the subsequent insert become one critical
section: no one else can append entries for the wallet in between, so the balance
we decided on cannot go stale.

We lock a wallet row rather than the ledger rows because **you cannot lock rows
that do not exist yet**. `SELECT … FOR UPDATE` over `ledger_entries` would lock
the existing entries, which is useless — the conflict comes from *new* ones.
Locking a single pre-existing row per wallet gives us something concrete to
serialise on.

### Why the order matters

A transfer locks two rows. If it locked them in request order — source, then
destination — two simultaneous transfers in opposite directions deadlock:

```
   T1: A → B                          T2: B → A
   ───────────                        ───────────
   lock A          ✓                  lock B          ✓
   lock B          ✗ waits for T2     lock A          ✗ waits for T1
                    └──────────── cycle ────────────┘
```

Neither can proceed. Postgres detects the cycle after `deadlock_timeout` and
kills one with SQLSTATE `40P01`. The user sees a failed transfer for no reason
they could have predicted.

### The rule

**Sort the wallet ids and acquire locks in ascending order, regardless of
direction.**

```
   T1: A → B                          T2: B → A
   ───────────                        ───────────
   lock A          ✓                  lock A          ✗ waits for T1
   lock B          ✓                                  (holding nothing)
   commit, release                    lock A          ✓
                                      lock B          ✓
```

T2 waits while holding **nothing**. There is no cycle, so there is no deadlock —
only a queue.

### Why this is airtight, not just "usually fine"

A deadlock requires a cycle in the wait-for graph: T1 holds X and wants Y, while
T2 holds Y and wants X.

Under a global ordering, suppose X < Y. Then **both** transactions acquire X
before Y. For T2 to hold Y it must already hold X — but T1 holds X, so T2 could
never have acquired Y in the first place. The premise is contradictory, so no
such cycle exists.

Nothing in that argument depends on there being exactly two wallets. It
generalises to any number: a cycle would require some transaction to hold a
higher id while waiting for a lower one, which the ordering forbids.

This is the standard resource-ordering result (Havender / Dijkstra), applied to
wallet ids.

**Where it lives:** `lockWalletsInOrder()` in
`src/modules/transfers/transfers.service.ts`, with the rationale in a comment at
that exact spot. The ordering function itself is pure and unit tested in
`tests/unit/ledger.test.ts` — including the key property that `lockOrder([A,B])`
and `lockOrder([B,A])` are identical.

### Two implementation details that are easy to get wrong

**Locks are acquired one statement at a time**, not with a combined
`WHERE id = ANY(…) ORDER BY id FOR UPDATE`.

The combined form almost certainly locks in sorted order, because the `LockRows`
node normally sits above `Sort` in the plan. But "almost certainly" depends on a
planner detail that is not a documented guarantee, and this ordering is
load-bearing. An explicit loop makes acquisition order a property of *the code*,
verifiable by reading it. The extra round trip is irrelevant next to the lock
wait it is protecting.

**The ordering must be total and consistent.** `lockOrder()` lowercases ids
before sorting, so a caller passing a mixed-case UUID cannot produce a different
sequence for the same pair. It also deduplicates, so a self-transfer could not
try to lock the same row twice.

### Ordering across different resource types

Wallets are not the only lockable resource. The idempotency key row is locked
too, and mixing orderings between resource *types* reintroduces exactly the cycle
we eliminated.

The global rule:

> **Idempotency key first, then wallets in ascending id order.**

Every mutating path obeys this. If you add a new lockable resource, slot it into
this global order and document where.

---

## 2. Isolation level

**READ COMMITTED**, chosen deliberately. The reasoning is in a comment on
`TransactionOptions` in `src/db/tx.ts`; this is the longer version.

### The anomaly

A **lost update on a derived balance**, which is a write skew over a phantom set:

| | T1 | T2 |
|---|---|---|
| 1 | read balance = 100 | |
| 2 | | read balance = 100 |
| 3 | 100 ≤ 100, proceed | |
| 4 | | 100 ≤ 100, proceed |
| 5 | insert debit 100 | |
| 6 | | insert debit 100 |
| 7 | **commit** | **commit** |

Final balance: **−100**. An overdraft from a wallet that only ever had 100.

### Why raising the isolation level does not fix it

**READ COMMITTED** does not prevent it. Each statement sees a fresh snapshot of
committed data, but T1's insert is uncommitted when T2 reads, and T2's read is an
aggregate — there is no row for the database to flag a conflict on.

**REPEATABLE READ** does not prevent it either, and this trips people up.
Postgres implements it as snapshot isolation, which detects write-write conflicts
on *the same tuple*. T1 and T2 insert **different** rows and never touch a common
tuple, so there is no conflict to detect. Both commit happily. Raising the level
here buys nothing while costing you serialization errors elsewhere.

**SERIALIZABLE** *would* prevent it, via predicate locks (SSI). It is genuinely
correct. We still do not use it — see below.

### Why not SERIALIZABLE

SERIALIZABLE prevents the anomaly **optimistically**: it lets transactions run,
detects the dangerous structure, and aborts one with `40001
(could_not_serialize_access)`. The caller must retry.

That is a fine trade when conflicts are rare. Here they are the workload. This
project exists to survive 200 parallel transfers against a *single wallet*. Every
one of those transactions reads the same predicate (`wallet_id = X`) and writes
into it, so essentially all of them conflict. The abort rate approaches 100%,
each retry re-contends, and throughput collapses into a retry storm. Worse, the
failure is *unbounded* — there is no guarantee a given transfer ever completes.

Pessimistic row locking gives the **identical correctness guarantee for this
access pattern** with different performance characteristics:

| | SERIALIZABLE | READ COMMITTED + `FOR UPDATE` |
|---|---|---|
| Prevents the anomaly | yes | yes |
| Under heavy contention | mass aborts, retry storm | contenders queue |
| Latency | unbounded (retries) | bounded (one lock wait) |
| Progress guarantee | none per-transaction | FIFO-ish, everyone proceeds |
| Requires retry loop | yes, mandatory | no |
| Requires correct lock ordering | no | **yes** — the cost |

The cost of the pessimistic route is that lock ordering becomes *your*
responsibility, which is exactly why section 1 exists and why there is a
dedicated deadlock test suite.

### Retries still exist, but they are a safety net

`withTransaction` retries `40001` and `40P01` up to three times with jittered
backoff, for genuine contention we did not anticipate.

That creates a testing hazard: a retry could silently paper over a lock-ordering
bug, and the test would still see `201`. So `txStats` counts deadlocks and
retries, and the deadlock tests assert those counters are **zero** — not merely
that requests succeeded. The safety net cannot disguise a broken design.

### Read-only paths

Balance and ledger reads use `BEGIN READ COMMITTED READ ONLY`. They take no row
locks and never block a transfer. A balance read is a point-in-time answer, which
is the honest semantics for a value that is always changing.

---

## 3. Concurrent idempotency

Sequential retry protection is easy: look up the key, return the stored response.
The hard case is **two identical requests arriving at the same instant on
different connections**, where the lookup finds nothing for either.

The entire mechanism is one unique index:

```sql
UNIQUE (user_id, idempotency_key)
```

### The flow

`runIdempotent()` (in `src/modules/idempotency/idempotency.ts`) runs **inside the
caller's transaction** — the same one that will do the work. That is not a style
preference; it is the mechanism.

```
   ┌─────────────────────────────────────────────────────────┐
   │ BEGIN  (READ COMMITTED)                                 │
   │                                                         │
   │  INSERT INTO idempotency_keys (user_id, key, …)         │
   │  ON CONFLICT (user_id, idempotency_key) DO NOTHING      │
   │  RETURNING id                                           │
   │                                                         │
   │        ┌──────────────┴──────────────┐                  │
   │   got a row                    got NO row               │
   │   (WINNER)                     (LOSER)                  │
   │        │                             │                  │
   │   do the work                   winner has ALREADY      │
   │   (transfer +                   committed or aborted    │
   │    ledger entries)              — see below             │
   │        │                             │                  │
   │   store response            ┌────────┴────────┐         │
   │        │                committed          aborted      │
   │        │                    │                  │        │
   │        │              replay stored      our INSERT     │
   │        │               response          succeeded;     │
   │        │                    │            we are now     │
   │        │                    │            the winner     │
   │ COMMIT ◄────────────────────┴──────────────────┘        │
   └─────────────────────────────────────────────────────────┘
```

### Why the loser cannot race ahead

This is the part that makes it work, and it is not obvious.

When the loser's `INSERT … ON CONFLICT DO NOTHING` hits a conflicting tuple that
is **uncommitted**, Postgres does not immediately give up and return zero rows.
It **blocks**, waiting on the winner's transaction to resolve.

So by the time the loser's INSERT returns zero rows, the winner has already
committed or aborted. There is no window in which both proceed concurrently. The
mutual exclusion is provided by the unique index itself, not by any advisory
locking we wrote.

Then:

- **Winner committed** → the loser's *next* statement sees the finished row,
  because READ COMMITTED takes a fresh snapshot per statement. It replays the
  stored response.
- **Winner aborted** → its tuple is dead, so the loser's own INSERT succeeds and
  the loser becomes the new winner, doing the work itself.

### Why there is no 'in_progress' state

A natural design marks the row `in_progress`, does the work, then marks it
`completed`. This one does not, and the absence is deliberate.

Because the claim and the effect share **one transaction**, `in_progress` only
ever exists inside the owning transaction, where no other session can observe it.
From every other connection's point of view the row is either **absent** (never
started, or rolled back) or **complete with its response**. There is no
intermediate state to handle, no crash-recovery sweeper to write, and no way to
observe a half-finished operation.

### Failed operations release the key

If the work throws — an overdraft, say — the whole transaction rolls back,
*including the idempotency row*. The key becomes reusable.

That is the semantics you want for a wallet: a transfer rejected for insufficient
funds should be retryable with the same key once the wallet is funded. And it
still satisfies the hard requirement, because a failed attempt creates **zero**
transfers.

If you ever need failures cached instead, that is a real change: the claim would
have to commit independently of the effect, which reintroduces the `in_progress`
state and everything that comes with it.

### Canonical fingerprinting

The request body is hashed to detect a key reused with a *different* payload,
which is a client bug and returns `409`.

The hash is over **canonical JSON** — object keys sorted recursively. Without
that, a client whose serialiser emits `{a,b}` on the first attempt and `{b,a}` on
the retry would be falsely accused of changing the payload, producing an
intermittent failure that is miserable to diagnose.

### This design requires READ COMMITTED

The replay path depends on the loser's follow-up SELECT seeing the winner's
freshly committed row — a per-statement snapshot.

Under REPEATABLE READ the transaction's snapshot predates the winner's commit, so
the SELECT would find nothing, and `ON CONFLICT` would raise `40001` instead.
`runIdempotent()` therefore **asserts the isolation level at runtime** and fails
loudly rather than subtly. A future change to the transaction's isolation level
would otherwise break idempotency in a way that only appears under concurrency.

---

## 4. The three most subtle bugs this design avoids

Not the obvious ones. These are the bugs that pass code review, pass sequential
tests, and surface in production at 3am.

### Bug 1 — the stress test that proves nothing

**The bug:** you write "fire 200 parallel transfers, assert the final balance is
exact and `SUM(debits) = SUM(credits)`", watch it pass, and conclude the system
is concurrency-safe. It is not. That test cannot fail.

**Why it cannot fail:** in a derived-balance ledger there is no mutable balance
to lose an update on. Concurrent transactions append *different* rows; nothing
overwrites anything; `SUM()` is exact regardless of interleaving. And every
transfer writes a matched pair, so debits equal credits by construction. **A
completely unsynchronised implementation passes both assertions every time.**
Money is conserved. The books balance. The wallet is also overdrawn by 44 units.

**Why it is subtle:** the assertions are not wrong — they are true and worth
keeping. They just verify *conservation*, and the property at risk is
*serialisation*. It is very easy to mistake one for the other, because in a
mutable-balance system the same test would catch the bug.

**What actually breaks:** the read-then-write **decision** — the overdraft check.
N transactions all read the same pre-spend balance, all conclude they can afford
it, all append.

**How this design avoids it:** the discriminating test funds a wallet with *half*
of what the burst attempts and asserts exactly the affordable number commit and
the balance never goes negative. Verified against the deliberately unlocked first
implementation — commit `cd3a851` (RED, the failing stress test) followed by
`d9f6948` (GREEN, the lock-ordering fix):

```
● permits exactly as many concurrent transfers as the wallet can afford
  expect(received).toBeGreaterThanOrEqual(expected)
    Expected: >= 0n
    Received:    -2200n
```

The naive assertions passed in that same run. Both variants are kept: one guards
conservation, the other guards serialisation.

**Generalise:** a test that cannot fail is worse than no test, because it
manufactures confidence. When you write a concurrency test, first make it fail on
purpose.

---

### Bug 2 — the security response that rolls itself back

**The bug:** refresh-token reuse detection revoked the entire token family, then
threw an error to reject the request. The caller wrapped it in a transaction. The
throw rolled the revocation back. **The breach containment undid itself.**

```ts
// BROKEN — this is what the code did
await client.query(`UPDATE refresh_tokens SET revoked_at = now()
                     WHERE family_id = $1 …`);          // ← in the caller's tx
throw new UnauthorizedError('refresh token has already been used');
//    └── withTransaction catches → ROLLBACK → revocation vanishes
```

**Why it is subtle:** every individual piece is correct. Detection works. The
`UPDATE` is right. Throwing is right. Rolling back on error is right — it is
exactly what you want for the *rejection*. The bug only exists in the
interaction, and it is invisible in the function you are reading, because the
rollback happens in a *different file* in the caller.

And the symptom is silent. The attacker still gets a 401, so a manual test looks
correct. What actually happens is that the legitimate user's token chain stays
live, so the thief who stole it keeps working access indefinitely. You would
never notice until a breach postmortem.

**How this design avoids it:** the revocation commits **out of band** on its own
connection, before the rejection propagates.

```ts
await revokeTokenFamilyOutOfBand(row.family_id);  // own connection, autocommit
throw new UnauthorizedError('refresh token has already been used');
```

Rolling back the *rejection* is fine. Rolling back the *containment* is not.

**How it was caught:** by a test asserting that after reuse is detected, the
*current* (generation-3) token also stops working. Testing only that the replayed
token is rejected would have passed. `tests/integration/auth.test.ts`, "revokes
the ENTIRE family when reuse is detected".

**Generalise:** when a failure path has a side effect that must survive the
failure, transaction scope is a correctness concern, not plumbing. Ask of every
`throw` after a write: *does this write need to outlive the exception?*

---

### Bug 3 — locking the wrong thing, or the right thing in the wrong order

Two failure modes of the same misconception, both of which look like working code.

**3a — locking rows that do not exist yet.**

The instinct is to lock what you are protecting. The balance comes from
`ledger_entries`, so you lock `ledger_entries`:

```sql
SELECT … FROM ledger_entries WHERE wallet_id = $1 FOR UPDATE;  -- useless
```

This locks the entries that are **already there**. The conflict comes from the
entries another transaction is **about to insert**, which no row lock can cover —
`FOR UPDATE` cannot lock a phantom. It looks like defensive locking, adds real
overhead, and protects nothing.

The fix is indirection: lock a **pre-existing** row that every writer must pass
through — the wallet row — and treat it as the mutex for that wallet's slice of
the ledger. The wallet row holds no money; its job is to exist so there is
something to serialise on.

The corollary is a rule you must keep true as the code grows: **every path that
appends entries for a wallet must first hold that wallet's row lock.** Add a
bulk-payout endpoint that skips it and the guarantee is gone, silently, for every
other path too.

**3b — locking in request order.**

With the right rows identified, the remaining trap is ordering. `lock(source);
lock(destination)` reads naturally and works perfectly in every sequential test.
It deadlocks the first time two users pay each other simultaneously — and only
then, which is why it reaches production.

Worse, it often *appears* to work afterwards, because a retry loop catches
`40P01` and the transfer succeeds on attempt two. You get mysterious latency
spikes and deadlock noise in the Postgres log, and the code review said "we
retry deadlocks, it's fine."

The fix is the global ordering in section 1. The reason the deadlock tests assert
on `txStats.deadlocks === 0` rather than on HTTP status is precisely this: a
retry can hide the bug while the test stays green.

**Generalise:** "we retry on deadlock" is a statement about resilience, not
correctness. If your design can deadlock, retries convert a correctness bug into
a performance bug — they do not remove it. Test the counter, not the outcome.

---

## Appendix: extending this safely

If you add a mutating endpoint or a new lockable resource:

1. **Take the idempotency claim first**, then wallets ascending. Do not invent a
   second ordering.
2. **Do the work on the same client** the claim used. A different connection is a
   different transaction and the atomicity argument collapses.
3. **Hold the wallet row lock** before appending any ledger entry for that wallet.
4. **Keep the transaction READ COMMITTED**, or `runIdempotent()` will refuse to
   run — by design.
5. **Write both entries in one statement.** A single `INSERT … VALUES (…), (…)`
   cannot partially succeed.
6. **Make your concurrency test fail first.** If you cannot make it fail, it is
   not testing what you think (see Bug 1).

The deferred constraint trigger is the backstop for all of this: a transaction
that leaves a transfer unbalanced **cannot commit**, regardless of what the
application code believes it did.
