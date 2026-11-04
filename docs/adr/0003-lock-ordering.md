# 3. Lock seats in ascending id order

- **Status:** Accepted
- **Date:** 5 Nov 2026

## Context

A fan can hold up to six seats at once, all or nothing. The default `lock` strategy locks every requested seat with `SELECT … FOR UPDATE`, checks that they're all free, and only then writes the hold.

Locking several rows creates a deadlock risk:

1. Fan A asks for seats 41 and 42, and fan B asks for 42 and 41.
2. If each locks in the order they asked, A holds 41 and waits for 42 while B holds 42 and waits for 41.
3. Neither can finish. Postgres eventually aborts one with `40P01`.

That costs a second of waiting and an error for a seat the fan might have won. In a sell-out, deadlocks would be constant.

## Decision

Every transaction that locks seats locks them in ascending id order (FR-HOLD-6).

- **The lock statement sorts before it locks:** `lock` runs `SELECT … WHERE id = ANY($2) ORDER BY id FOR UPDATE`. Rows are locked in id order, whatever order the fan sent them in. Two holds that share seats then queue behind each other instead of waiting in a circle.
- **Waits are bounded:** every booking transaction sets a 2-second `lock_timeout`. A wait that long ends as `409 SEAT_BUSY`, which is safe to retry, rather than hanging (NFR-5).
- **Future code follows the same rule:** checkout's Reserve and Confirm steps (M5) lock a hold's seats, and the sweeper (M4) uses `FOR UPDATE SKIP LOCKED`. Both will also order by id.
- **The other strategies:** `serializable` takes no row locks, so it can't deadlock this way; its conflicts arrive as `40001` and are retried. `cas`'s single `UPDATE` locks rows in whatever order Postgres scans them, which isn't guaranteed. If it ever deadlocked, `40P01` would map to `409 SEAT_BUSY`, never a `500`.

## Consequences

- **Deadlocks between holds are impossible under `lock`.** The concurrency suite checks it: 60 fans ask for overlapping seats in opposite orders, and `lock` must produce no `SEAT_BUSY`. That held for 20 runs in a row, and the test caught a planted bug that locked seats in request order.
- **Contenders for a hot seat queue on its row lock.** That's correct but limits throughput on one seat; the hot-seat benchmark (WP 3.8) measures the cost.
- **Locks are held only for a few short statements,** never across a network call. Checkout charges the provider between two transactions (FR-PAY-3).

## Alternatives considered

- **Lock in request order and retry on `40P01`:** rejected. It wastes a second per deadlock and turns ordinary overlap into errors.
- **`FOR UPDATE NOWAIT`:** rejected for holds. Contenders would fail at once instead of queueing briefly, and many would get `409` for seats that are free a moment later.
- **One advisory lock per event:** rejected. It would allow only one hold at a time across the whole stadium.
