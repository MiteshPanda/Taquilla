# 2. Hand-written SQL, no ORM

- **Status:** Accepted
- **Date:** 5 Nov 2026

## Context

Whether Taquilla double-sells depends on a few lines of SQL, so those lines need to be visible and easy to review. That covers which rows are locked and in what order, what a conditional `UPDATE` matches, which isolation level a transaction runs at, and which Postgres error means "try again".

ORMs and query builders make ordinary queries shorter by hiding exactly these details:

- **Locks and isolation:** a `findOne` followed by a `save` doesn't show whether rows are locked, when the transaction starts, or at what isolation level.
- **Batching:** a relation might be loaded with one query or a hundred.
- **Errors:** a Postgres error such as `40001` (serialization failure) or `55P03` (lock timeout) can arrive wrapped in the library's own error type, or not at all.

Reviewing the booking logic would then mean reading the library as well as our code.

## Decision

Booking SQL is written by hand (NFR-13).

- **The driver is `pg`, with every value passed as a parameter (`$1`, `$2`).** No SQL is ever built by joining strings.
- **The lock-sensitive statements read as plain SQL in the strategy files:** the `FOR UPDATE … ORDER BY id` lock, the `cas` conditional `UPDATE … RETURNING`, and the `SERIALIZABLE` transaction.
- **Transactions are explicit:** `withTransaction` sets the isolation level, a 2-second `lock_timeout` and a 5-second `statement_timeout`, and checks that `COMMIT` really committed.
- **Postgres error codes are mapped in one place,** `mapDatabaseError`, as requirements.md §6.4 specifies.
- **The schema is created only by numbered `.sql` migration files** (DR-1), applied by a small runner of our own, not by an ORM's schema sync.

## Consequences

- **A reviewer can see every lock, every condition and every isolation level** by reading the files in `api/src/holds/`.
- **There's more SQL to maintain,** and TypeScript doesn't check SQL. A typo in a column name only fails when the query runs. This is offset by testing every query against a real Postgres, never a mock, including the concurrency suite.
- **Row types are declared by hand** on each query (`query<{ id: number }>`), so a mismatch between a declared type and the real columns is only caught by tests.
- **Changing the schema means writing a new migration** and never editing an applied one, as the README says.

## Alternatives considered

- **Prisma or TypeORM:** rejected. Locking and isolation are hidden or awkward, raw SQL would be needed for the critical paths anyway, and their schema tooling would compete with plain migrations.
- **A query builder such as Knex or Kysely:** closer to SQL and type-safe in Kysely's case, but it adds a layer between the reader and the statement that matters most. It could be reconsidered for non-booking queries if they grow.
