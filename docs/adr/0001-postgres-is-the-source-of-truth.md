# 1. Postgres is the source of truth

- **Status:** Accepted
- **Date:** 5 Nov 2026

## Context

Taquilla's promise is that no seat is ever sold twice, even when thousands of fans click at once. That needs one place where "who has this seat" is decided, and that place must stay right when requests race, crash or arrive at several API instances.

The common shortcut is a lock in Redis or in the API's memory: take the lock, check the seat, write, release. Both go wrong under load:

- **A lock in memory only works for one process.** A second API instance has its own memory, so two fans can both "win".
- **A lock in Redis has to expire,** so a crashed client can't hold it forever. But a request that stalls for longer than the expiry, through a garbage-collection pause or a slow query, carries on writing after the lock has passed to someone else. The two writers collide anyway, and the database never knew there was a lock.

## Decision

Postgres alone decides every booking.

- **All booking state lives in Postgres:** seats, holds, orders, tickets and idempotency keys. The API keeps none in memory (NFR-7).
- **Races are settled inside transactions:** row locks, a conditional `UPDATE` or `SERIALIZABLE`, depending on the strategy ([ADR 3](0003-lock-ordering.md)).
- **Bad states can't be stored:**
  - `one_valid_ticket_per_seat` refuses a second valid ticket for a seat (INV-1);
  - `seats_hold_state` refuses a half-set hold;
  - `orders.hold_id` is unique.

  These are a backstop if code ever gets a race wrong.
- **Postgres's clock decides expiry.** Holds are compared with `now()` in SQL, never the API server's clock, and a lapsed hold counts as free in every query (lazy expiry). Correctness doesn't wait for the sweeper.

## Consequences

- **Any number of API instances stay correct together,** because none of them holds booking state.
- **A bug that skips a lock still can't double-sell;** the database refuses the second ticket. Tests prove each constraint rejects what it should.
- **Throughput on a hot seat is limited by row-lock contention in one Postgres node.** The k6 benchmarks in M6 measure how much. Scaling beyond one node (read replicas for the seat map, partitioning by event) is listed in the README's "What changes at 100× scale".
- **Postgres is a single point of failure.** `/ready` reports when it's unreachable, and the API answers `503` there instead of guessing.
- **One deliberate exception:** the `/auth/*` rate limit counts requests in each API process's memory. It isn't booking state, and an approximate per-instance limit is enough to slow password guessing.

## Alternatives considered

- **Redis locks (single key or Redlock):** rejected for the expiry problem above. They also add a second system that has to agree with Postgres.
- **Locks in the API's memory:** rejected because they're only correct with one instance.
- **Checking in application code without constraints:** rejected, because a future change that skips the check would double-sell silently.
