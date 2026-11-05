# Taquilla

**A match-ticket booking engine that can't double-sell, and proves it under load.**

[![CI](https://github.com/MiteshPanda/taquilla/actions/workflows/ci.yml/badge.svg)](https://github.com/MiteshPanda/taquilla/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-LTS-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Load tested with k6](https://img.shields.io/badge/load%20tested-k6-7D64FF?logo=k6&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Taquilla (Spanish for *box office*) is a booking API where thousands of simulated fans fight for the same seats at a fictional stadium. Row locks decide every race, a partial unique index makes a second valid ticket for a seat impossible to store, and idempotency keys make sure a double-clicked **Pay** charges exactly once.

> **Status:** in development. Values in `[brackets]` are placeholders until they're measured. The full specification lives in [requirements.md](requirements.md).

<!-- Add after Phase 7:
![Demo: pick seats, watch the hold timer, double-click Pay, see one charge](docs/demo.gif)
-->

## Headline results

| Metric | Result |
| --- | --- |
| Oversold seats in a sellout of [10,000] requests from [1,000] concurrent virtual users | [0] |
| Duplicate charges in the same run | [0] |
| Fans who got the hot seat, out of 10,000 requests for it | [1] |
| p95 hold latency under load | [X] ms |
| Throughput | [Y] requests/s |

Measured on [CPU, RAM, OS] with PostgreSQL 16, with k6 and the API on the same machine. Details in [Benchmarks](#benchmarks).

## Why this exists

Most booking demos are CRUD apps that break the moment two people click at once: both requests read `available`, both write `sold`, and one seat ends up with two tickets. Taquilla is built around that moment. It reproduces the bug on purpose, fixes it three ways, and proves the fix under load with an audit anyone can rerun.

## The four rules

| # | Rule | Enforced by | Checked by |
| --- | --- | --- | --- |
| 1 | A seat has at most one valid ticket | Row locks, with a partial unique index as a backstop | Audit check 1 |
| 2 | An order is charged at most once | Idempotency keys, the order state machine, provider-key reuse | Audit check 2 |
| 3 | Money adds up: total charged equals total of paid orders | Orders turn `paid` only on confirmation; lost seats are refunded | Audit check 3 |
| 4 | Holds end on time | Lazy expiry in every query, plus a sweeper | Audit check 4 |

## Architecture

```mermaid
flowchart LR
    web["React seat map"]
    k6["k6 load tests"]
    api["Express API<br/>Node.js + TypeScript"]
    pg[("PostgreSQL<br/>single source of truth")]
    pay["Mock payment provider"]
    sweeper["Expiry sweeper"]
    audit["Audit script"]

    web --> api
    k6 --> api
    api -->|"locking transactions"| pg
    api -->|"charge / refund"| pay
    pay -->|"payments schema"| pg
    sweeper -->|"frees expired holds"| pg
    audit -->|"checks the four rules"| pg
```

- **API:** a stateless Express service. All booking state lives in Postgres, so a second instance would stay just as correct.
- **PostgreSQL:** decides every race with row locks; constraints are the last line of defence.
- **Mock payment provider:** a separate service that dedupes by idempotency key, like Stripe, and injects latency, declines and lost responses.
- **Sweeper:** frees expired holds every 10 seconds with `SKIP LOCKED`. It's housekeeping only, because every query already treats an expired hold as free.
- **Audit:** checks the four rules in SQL after every load test and fails loudly.

## Seat lifecycle

```mermaid
stateDiagram-v2
    [*] --> AVAILABLE
    AVAILABLE --> HELD: hold wins the row lock
    HELD --> AVAILABLE: expires or released
    HELD --> HELD: expired hold re-taken by another fan
    HELD --> SOLD: paid and confirmed
```

Every arrow is one database transaction. `SOLD` is final in v1.

## How double-selling is prevented

### 1. The bug, kept on purpose

`POST /dev/buy-naive` (dev only) checks the seat, then writes. Fire 100 parallel requests at seat 42 with `RACE_DELAY_MS=50` widening that gap, and it sells the seat **83 to 100 times**.

Without the delay, the result depends on timing. On a laptop it sold seat 42 up to 100 times, but on GitHub's faster Linux runner each buy finished before the next one arrived, and it sold once. That is what makes this bug dangerous: it can pass every test on a fast machine and still oversell under real load.

| Where | `RACE_DELAY_MS=0` | `RACE_DELAY_MS=50` |
| --- | --- | --- |
| Laptop, 20 runs | 60 to 100 times, median 85 | 100 times, every run |
| GitHub Actions, 2 runs | Once, both runs | 83 and 90 times |

Measured with `api/test/race.test.ts`: 100 parallel buyers, one request each, against the API's pool of 20 connections, with PostgreSQL 16. The laptop was an Intel Core i5-1135G7 (8 threads) with 8 GB of RAM, on battery power, running Windows 11 with Postgres in Docker. The CI runs used GitHub's `ubuntu-24.04` runner with a Postgres service container. To see your own numbers, run `npx vitest run api/test/race.test.ts --silent=false`.

```ts
const { rows } = await pool.query('SELECT status FROM seats WHERE id = $1', [seatId]);
if (rows[0].status !== 'available') throw new ConflictError('Seat taken');
// every request reaches this line before any of them writes 'sold'
await pool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [seatId]);
await pool.query('INSERT INTO naive_tickets (seat_id, user_id) VALUES ($1, $2)', [seatId, userId]);
```

### 2. The fix: decide while holding the lock

```sql
SELECT id, price_paise,
       status = 'available' OR (status = 'held' AND held_until < now()) AS is_free
  FROM seats
 WHERE event_id = $1 AND id = ANY($2::int[])
 ORDER BY id     -- one global lock order, so multi-seat holds can't deadlock
   FOR UPDATE;   -- every other contender waits here until COMMIT
```

The API checks `is_free` on every row, then writes the hold in the same transaction. The next contender re-reads the row after the commit, sees `held`, and gets a clean `409`.

### 3. The backstop: make the bad state unstorable

```sql
CREATE UNIQUE INDEX one_valid_ticket_per_seat
    ON tickets (seat_id) WHERE status = 'valid';
```

Even if a future change skips the lock, Postgres refuses a second valid ticket for the same seat.

### Three strategies, one guarantee

Pick one with `BOOKING_STRATEGY`. All three pass the same concurrency tests. The API reads it once at startup and logs the strategy it chose; an unknown value stops it from starting.

| Strategy | How it works | Trade-off |
| --- | --- | --- |
| `lock` (default) | `SELECT … FOR UPDATE` in id order, check, then update | Easy to reason about; contenders queue on the row |
| `cas` | One conditional `UPDATE` that only matches free seats; all-or-nothing | One statement, no read-then-write gap |
| `serializable` | Naive check-then-act inside `SERIALIZABLE`, retried up to 3 times on error `40001`, with exponential backoff and jitter | Correct even with naive code; wastes work under contention |

## Checkout without double charges

```mermaid
sequenceDiagram
    autonumber
    participant F as Fan
    participant A as API
    participant DB as PostgreSQL
    participant P as Payment mock
    F->>A: POST /holds/:id/checkout with Idempotency-Key
    A->>DB: Claim the key (exactly one INSERT wins)
    A->>DB: Reserve - lock seats, extend the hold, order to paying
    A->>P: Charge, reusing one provider key on every retry
    P-->>A: succeeded or declined
    A->>DB: Confirm - seats to sold, tickets created, order to paid
    A-->>F: 200 paid, 402 declined, or 409 seat lost and refunded
```

- No row lock is held while the provider is called. Checkout is three short steps around the network call.
- Same key again: the saved response is replayed. Same key with a different body: `422`. Same key while the first request is still running: `409`.
- If the server crashes mid-payment, a retry with the same key resumes at the charge step and gets the original result back.
- If the seats were lost before confirmation, the charge is refunded and the fan gets `409`.

## Tech stack

| Layer | Choice |
| --- | --- |
| API | Node.js (LTS), TypeScript, Express, Zod |
| Database | PostgreSQL 16 via `pg`, with hand-written SQL |
| Payments | Mock provider service with fault injection |
| Tests | Vitest |
| Load testing | k6 |
| Frontend | React + Vite |
| Infra | Docker Compose, GitHub Actions |

## Getting started

### Prerequisites

- Docker with Compose v2
- Node.js (current LTS) and npm
- k6, for load tests
- 8 GB of RAM or more to run 1,000 virtual users beside the stack (use 500 on smaller machines)

### Run it

```bash
git clone https://github.com/MiteshPanda/taquilla.git
cd taquilla
cp .env.example .env            # then set JWT_SECRET
npm install
docker compose up -d --build    # Postgres, API, payment mock, sweeper, web
npm run reset                   # 1 match, 2,000 seats, 1,000 test fans
```

Open the seat map at http://localhost:5173. The API listens on http://localhost:3000.

To run the expiry sweeper alongside it, use `docker compose up -d sweeper`, or `npm run sweeper` on the host. It needs a migrated database (`npm run reset`). In Docker, the first start installs its dependencies, which takes about a minute.

To run the payment mock, use `docker compose up -d payments-mock`, which creates its `payments` schema and then listens on `127.0.0.1:4000`. On the host, run `npm run migrate` once, then `npm run payments`.

To run only the database, use `docker compose up -d postgres`. It creates `taquilla` and `taquilla_test`, and listens on `127.0.0.1:5432`. The init script runs only on an empty volume, so `docker compose down -v` is how you start again from nothing; it deletes all local data.

### Reproduce the headline result

```bash
docker compose up -d --build
npm run reset && npm run tokens              # clean stadium + tokens for 1,000 fans
k6 run loadtest/sellout.js && npm run audit  # load test, then prove the four rules
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the API in watch mode |
| `npm test` | Run the concurrency, race, expiry and checkout test suites |
| `npm run test:coverage` | Run the tests and enforce 80% line coverage on `holds`, `checkout`, `idempotency` and the payment mock's charge logic |
| `npm run lint` | Run ESLint with type-checked rules; any warning fails |
| `npm run format` | Format the code with Prettier (`npm run format:check` only checks it) |
| `npm run typecheck` | Type-check every package with TypeScript in `strict` mode |
| `npm run migrate` | Apply any migrations not yet applied, the API's and then the payment mock's; safe to run again |
| `npm run reset` | Drop, migrate and seed a clean stadium, and empty the payment mock's charges |
| `npm run tokens` | Write JWTs for the 1,000 test fans to `loadtest/tokens.json` |
| `npm run sweeper` | Start the expiry sweeper |
| `npm run payments` | Start the payment mock in watch mode on `PAYMENTS_PORT` |
| `npm run audit` | Check the four rules; exit code 1 on any violation |

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://taquilla:taquilla@localhost:5432/taquilla` | Postgres connection |
| `PORT` | `3000` | API port |
| `JWT_SECRET` | none, required | Signs login tokens; at least 32 characters |
| `JWT_EXPIRES_IN` | `1h` | How long a login token lasts: a number and `s`, `m`, `h` or `d` |
| `BOOKING_STRATEGY` | `lock` | `lock`, `cas` or `serializable` |
| `HOLD_SECONDS` | `300` | Hold length (tests use `2`) |
| `SWEEP_INTERVAL_SECONDS` | `10` | How often the sweeper runs |
| `PAYMENTS_URL` | `http://localhost:4000` | Mock provider address |
| `PAYMENTS_PORT` | `4000` | Mock: its port (`PORT` is the API's) |
| `DECLINE_RATE` | `0.05` | Mock: share of charges declined |
| `LOST_RESPONSE_RATE` | `0.02` | Mock: share of first attempts whose response is lost |
| `LATENCY_MIN_MS` | `100` | Mock: shortest delay added to a first attempt |
| `LATENCY_MAX_MS` | `800` | Mock: longest delay added to a first attempt |
| `SEED_PASSWORD` | `taquilla-dev` | Password for seeded test fans (local only) |
| `RACE_DELAY_MS` | `0` | Dev only: widens the naive race window |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated browser origins allowed to call the API |

### Migrations

`npm run migrate` applies the files in `api/migrations/` in number order, then the files in `api/migrations/dev/` unless `NODE_ENV=production`. It uses `DATABASE_URL` and `NODE_ENV`, and doesn't need `JWT_SECRET`. Each file runs once, in its own transaction, and is recorded in `schema_migrations`. If a file fails, it rolls back, the run stops there, and the command exits with code 1.

**Never edit a migration that has been applied; add a new one.** The runner only checks a file's name, so an edit never reaches a database that already ran the file, and that database quietly drifts from everyone else's.

To add a migration:

- Name it with the next three-digit number, then lowercase words: `002_add_refunds.sql`.
- Put tables that only exist for local demos in `dev/`, which has its own numbering. Main migrations must not depend on them, because production never has them.
- Leave out `BEGIN` and `COMMIT`, because the runner already wraps the file in a transaction. For the same reason, statements that can't run in a transaction, such as `CREATE INDEX CONCURRENTLY`, will fail.

The payment mock keeps its own migrations in `payments-mock/migrations/`, with their own numbering. They run in the `payments` schema, which the runner creates if it's missing, and are recorded in `payments.schema_migrations`. The API's migrations never touch that schema, the same way a real provider's tables live outside your database.

### Resetting the database

`npm run reset` deletes everything in the database at `DATABASE_URL`, including the payment mock's charges, applies both sets of migrations, and seeds one match, 2,000 seats and 1,000 fans (`fan1@taquilla.test` to `fan1000@taquilla.test`, password from `SEED_PASSWORD`). Seats get the same ids every time, so seat 42 is always Lateral Este, row B, seat 17.

It refuses to run when `NODE_ENV=production` or when the database host isn't `localhost`, `127.0.0.1` or `::1`. It can't see through an SSH tunnel, so never point a local address at a real database.

### Load-test tokens

`npm run tokens` signs a JWT for every seeded fan and writes them to `loadtest/tokens.json`, as `[{ "userId": 1, "token": "…" }, …]`, so each k6 virtual user can act as a different fan without logging in. It uses `JWT_SECRET`, so the API must run with the same secret, and the tokens expire after `JWT_EXPIRES_IN`, so write them again before a long run.

The file is a login for every test fan, so it's gitignored. The command refuses to run in production or against a database that isn't local, for the same reasons as `npm run reset`.

### Payment mock

`payments-mock/` is a stand-in for a real payment provider, run as its own service on port 4000 (FR-MOCK-1). Only the API calls it.

| Method | Path | What it does | Success | Errors |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | The process is up | `200` | None |
| `POST` | `/charges` | Charges `{ orderId, amountPaise }` under the `Idempotency-Key` header | `201` with a new charge, `200` with the original one for a repeated key | `400`, `422` for a repeated key with a different order or amount |
| `POST` | `/charges/:key/refund` | Refunds a succeeded charge; calling it again returns the same refund | `200` | `404`, `409` for a declined charge |

A charge's `status` is `succeeded`, `declined` or `refunded`; a decline still answers `201`, because it's a new charge that was declined.

- **One charge per key (FR-MOCK-2).** A repeated key gets the original charge back, even when 20 first attempts arrive at once.
- **No deduplication by order (FR-MOCK-3).** Two keys for one order make two charges, so only Taquilla's own logic can prevent a double charge.
- **Faults on first attempts only (FR-MOCK-5).** A key's first attempt waits 100 to 800 ms, is declined at `DECLINE_RATE`, and at `LOST_RESPONSE_RATE` records the charge and then drops the connection without answering. A retry with the same key skips all three, so it always gets the charge back.

```bash
curl -X POST localhost:4000/charges   -H 'Content-Type: application/json'   -H 'Idempotency-Key: pay:11111111-2222-4333-8444-555555555555:attempt-1'   -d '{"orderId":"11111111-2222-4333-8444-555555555555","amountPaise":450000}'
```

## API

| Method | Path | Auth | What it does | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/health` | None | The process is up | `200` | None |
| `GET` | `/ready` | None | The database answers too | `200` | `503` |
| `POST` | `/auth/signup` | None | Create an account | `201` | `400`, `409`, `429` |
| `POST` | `/auth/login` | None | Get a JWT | `200` | `400`, `401`, `429` |
| `GET` | `/events/:id/seats` | None | Seat map with live state | `200` | `404` |
| `POST` | `/events/:id/holds` | JWT | Hold 1–6 seats, all or nothing; `Idempotency-Key` optional | `201` | `400`, `401`, `404`, `409`, `422` |
| `DELETE` | `/holds/:id` | JWT | Release a hold early | `204` | `401`, `404` |
| `POST` | `/holds/:id/checkout` | JWT | Reserve, charge, confirm; `Idempotency-Key` required | `200` | `400`, `401`, `402`, `404`, `409`, `422`, `503` |
| `GET` | `/orders/:id` | JWT | Order with its tickets | `200` | `401`, `404` |
| `POST` | `/dev/buy-naive` | JWT | Dev only: the deliberately unsafe buy, `{ "seatId": 42 }` | `201` | `400`, `401`, `404`, `409` |

`DELETE /holds/:id` frees the seats the hold still has and marks it `released`. A seat another fan took after the hold lapsed stays theirs, and a paid hold stays as it is. Repeating it is harmless, and anyone else's hold gets the same `404` as one that doesn't exist.

`/dev/buy-naive` exists only when `NODE_ENV` isn't `production`; a production server answers `404` because the route isn't mounted at all, and its table, `naive_tickets`, comes from a dev-only migration. The server logs a warning at startup whenever the route is mounted.

Send the token as `Authorization: Bearer <token>`. A password must be at least 8 characters and at most 72 bytes, and emails are stored lowercase. Each IP address can make 10 requests a minute to `/auth/*`; after that it gets `429`.

Example session (needs `jq` and `uuidgen`):

```bash
# Log in as a seeded test fan
TOKEN=$(curl -s localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"fan1@taquilla.test","password":"taquilla-dev"}' | jq -r .token)

# Hold two seats
curl -s localhost:3000/events/1/holds \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"seatIds":[41,42]}'

# Pay for the hold
curl -s -X POST localhost:3000/holds/$HOLD_ID/checkout \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)"
```

The seat map lists every seat in section, row and seat order, and is sent with `Cache-Control: no-store`. A seat whose hold has lapsed already reads `available`:

```json
{
  "event": { "id": 1, "name": "Chamartín FC vs Castellana United", "startsAt": "…" },
  "seats": [
    { "id": 1001, "section": "Fondo Norte", "row": "A", "number": 1, "pricePaise": 250000, "state": "available" },
    …
  ]
}
```

A successful hold returns `201`:

```json
{
  "holdId": "8a6e0f9b-…",
  "seatIds": [41, 42],
  "amountPaise": 900000,
  "expiresAt": "…"
}
```

Every error has the same shape:

```json
{
  "error": {
    "code": "SEAT_TAKEN",
    "message": "Seat 42 was just taken. Pick another seat.",
    "seatIds": [42]
  }
}
```

The full list of error codes is in [requirements.md](requirements.md#63-error-codes).

## Testing

### Test suite

```bash
docker compose up -d postgres   # the tests run against the taquilla_test database
npm test
```

- **Naive buy:** it sells a free seat and refuses a sold one when requests come one at a time, honours `RACE_DELAY_MS`, and answers `404` under `NODE_ENV=production`.
- **Seat map:** 2,000 seats in order, a lapsed hold reads `available`, a locked seat doesn't make the map wait, and unknown or malformed event ids get `404`.
- **Tokens:** `npm run tokens` writes a token for each of the 1,000 seeded fans, and every one of them gets past `requireAuth`.
- **Auth:** sign-up, duplicate emails, wrong passwords, and expired, tampered and missing tokens are covered. So are the rate limit and equal timing for unknown emails.
- **Schema:** Postgres itself rejects a half-set hold on a seat, a second valid ticket for a seat and a second order for a hold.
- **Holds:** each strategy holds free seats until a database-clock expiry, refuses taken and sold seats with `409` and holds nothing, gives a lapsed hold's seat to the next fan, and rejects seats outside the event with `400`.
- **Holds route:** `POST /events/:id/holds` answers `201`, `400`, `401`, `404` and `409` under each strategy, and Postgres contention errors become `409 SEAT_BUSY` as requirements.md §6.4 maps them.
- **Sweeper:** one run frees every lapsed seat in batches of 1,000 and nothing else, steps past seats a booking has locked, never overlaps the previous run, keeps going after a failed run, and stops cleanly on `SIGTERM`.
- **Payment mock:** a repeated key returns the original charge, also when 20 first attempts race; one order can be charged twice under two keys; refunds are safe to repeat, also 10 at once; and each fault hits first attempts only, so the retry after a lost response gets back the one charge it made. Its migrations, settings and process are covered too.
- **Release:** `DELETE /holds/:id` frees only the seats the hold still has, answers `404` for anyone else's hold, and is harmless to repeat, even twice at once.
- **Concurrency:** through a real HTTP server, for every strategy: 100 parallel holds on one seat produce exactly one winner and 99 `409`s; overlapping multi-seat holds asked in opposite orders never get a `5xx`, and under `lock` never even wait long enough to get `SEAT_BUSY`; and a four-seat hold racing for its last seat is held whole or not at all. The suite passed 20 runs in a row.
- **Race:** 100 parallel naive buys of seat 42, at `RACE_DELAY_MS=0` and `50`. At 50, the check that only one buyer wins is marked `it.fails`, so it documents the bug without breaking CI, and turns CI red if the naive buy ever stops overselling. At 0 the count is only recorded, because whether the requests overlap depends on the machine. A separate check makes sure each race ran cleanly, with no `5xx`.
- **Expiry:** end to end with `HOLD_SECONDS=2`, a hold lasts 2 seconds, then its seats show as free and another fan can take them before any sweep, and the sweeper frees the rest. Under every strategy, a lapsed seat goes to the next fan, and a sweep running at the same moment never undoes their new hold. One sweep frees the whole stadium's lapsed seats, and four sweepers at once free each seat exactly once.
- **Checkout and idempotency:**
  - Same key sent twice in parallel: one charge, identical responses
  - Provider loses the response and the client retries: still one charge
  - Same key, different body: `422`
  - Two tabs, two keys, one hold: one `200`, one `409`, one charge
  - A decline returns `402`; a retry with a new key can succeed
  - The hold expires and another fan takes the seat: `409`, no charge

### Continuous integration

Every push and pull request runs [the CI workflow](.github/workflows/ci.yml) against a Postgres 16 service container: `npm ci`, format check, lint, typecheck, migrate and test. A separate job runs `npm audit --audit-level=high`. Dependabot proposes npm and GitHub Actions updates every week.

Changes reach `main` only through a pull request, and both jobs must pass on a branch that is up to date with `main`. Branch protection enforces this for everyone, including admins.

### Load tests

| Scenario | What it does | Passes when |
| --- | --- | --- |
| `hot-seat` | 1,000 virtual users send 10,000 holds for seat 42 | Exactly one hold succeeds |
| `sellout` | 10,000 hold-then-checkout journeys across 2,000 seats, 70% aimed at the Lateral stands | The audit passes |
| `double-click` | Every fan sends the same checkout twice in parallel with one key | One successful charge per order |
| `churn` | Fans hold and abandon; others retry after expiry | Expired seats are resold; the audit passes |

```bash
npm run reset && npm run tokens
k6 run loadtest/hot-seat.js
npm run audit
```

`npm run audit` checks the four rules directly in SQL and exits with code 1 on any violation, so CI and load-test runs fail loudly.

For `hot-seat`, start the API with the strategy you want (`BOOKING_STRATEGY`) and the same `JWT_SECRET` the tokens were signed with, and reset before every run, because seat 42 is gone after the first. `k6 run -e TARGET=naive loadtest/hot-seat.js` aims it at the unsafe dev route instead, where it fails on purpose. Its thresholds are exactly one winner, under 0.1% failures, and p95 under 2,500 ms, the laptop baseline in NFR-3. Each virtual user's first request is spread over the first second, because Windows client editions refuse most connections opened in the same instant.

## Benchmarks

<!-- Fill in from your own runs. Reset the database before each one. -->

| Strategy | Hot-seat winners | p95 hold latency (ms) | Requests/s | Retries or aborts |
| --- | --- | --- | --- | --- |
| naive (dev route) | TBD | TBD | TBD | TBD |
| `lock` | TBD | TBD | TBD | TBD |
| `cas` | TBD | TBD | TBD | TBD |
| `serializable` | TBD | TBD | TBD | TBD |

**Setup:** [CPU] · [RAM] · [OS] · PostgreSQL 16 in Docker · API pool of 20 connections · [1,000] virtual users · [10,000] requests · k6 and the API on one machine.

These numbers compare strategies on one laptop. They are not a production capacity claim.

## Design decisions

- **Postgres is the only source of truth.** No Redis locks: a lock outside the database can expire mid-request and let two writers collide anyway. ([ADR 1](docs/adr/0001-postgres-is-the-source-of-truth.md))
- **Hand-written SQL, no ORM.** Every lock is visible in the code and easy to review. ([ADR 2](docs/adr/0002-hand-written-sql.md))
- **One lock order.** Seats are always locked in ascending id order, so overlapping holds queue instead of deadlocking. ([ADR 3](docs/adr/0003-lock-ordering.md))
- **Lazy expiry.** Queries treat `held_until < now()` as free, so correctness never waits for the sweeper.
- **No locks across network calls.** Checkout is three short steps around the payment call, so a slow provider can't freeze a queue of fans.
- **The database clock decides expiry.** Always `now()` in Postgres, never the API server's clock.
- **Money is integer paise.** No floating point anywhere near a price.

The longer reasoning, with the alternatives that were rejected, is in the [architecture decision records](docs/adr/):

1. [Postgres is the source of truth](docs/adr/0001-postgres-is-the-source-of-truth.md)
2. [Hand-written SQL, no ORM](docs/adr/0002-hand-written-sql.md)
3. [Lock seats in ascending id order](docs/adr/0003-lock-ordering.md)

## Known limitations

- One Postgres node; no replicas or sharding.
- `SOLD` is final in v1; cancellations and resale are on the roadmap.
- Payments are simulated.
- Benchmarks come from one laptop with k6 and the API sharing the CPU. Read them as a comparison between strategies, not a capacity claim.

## What changes at 100× scale

- A virtual waiting room admits fans at a steady rate during on-sale spikes.
- The seat map is served from a cache or a read replica.
- Inventory is partitioned by event.
- Fans and IP addresses are rate-limited.

The locking core stays the same.

## Project structure

```text
taquilla/
├── api/
│   ├── migrations/          # numbered .sql files, applied in order
│   │   └── dev/             # applied only outside production
│   ├── src/
│   │   ├── db.ts            # pool + withTransaction helper
│   │   ├── migrate.ts       # migration runner
│   │   ├── migrate-cli.ts   # npm run migrate
│   │   ├── server.ts
│   │   ├── auth/            # signup, login, JWT middleware
│   │   ├── seats/           # seat map with lazy expiry
│   │   ├── holds/           # lock, cas and serializable strategies
│   │   ├── checkout/        # reserve → charge → confirm
│   │   ├── idempotency/     # Idempotency-Key middleware
│   │   ├── jobs/            # sweeper.ts frees expired holds; sweeper-cli.ts runs it as its own process
│   │   └── dev/             # naive buy, dev only
│   └── test/                # concurrency, race, expiry, checkout
├── payments-mock/           # fake provider with fault injection
│   ├── migrations/          # its own numbered .sql files, applied in the payments schema
│   ├── src/
│   │   ├── routes.ts        # POST /charges and POST /charges/:key/refund
│   │   ├── charges.ts       # the SQL: one charge per key
│   │   ├── faults.ts        # latency, declines and lost responses
│   │   └── server.ts        # npm run payments
│   └── test/
├── web/                     # React + Vite seat map
├── loadtest/                # k6 scenarios
├── scripts/                 # reset, seed, tokens, audit
├── docs/adr/                # architecture decision records
├── .github/                 # CI workflow, Dependabot, pull request template
├── docker-compose.yml
├── .env.example
└── requirements.md
```

## Roadmap

- [ ] Best-available seats with `FOR UPDATE SKIP LOCKED`
- [ ] Live seat map over Server-Sent Events, fed by Postgres `LISTEN/NOTIFY`
- [ ] Virtual waiting room for on-sale spikes
- [ ] Razorpay test mode with an idempotent webhook handler
- [ ] Reconciler for orders stuck in `paying`
- [ ] One active hold per fan per match
- [ ] Ticket cancellation and resale
- [ ] Metrics endpoint and a lock-wait dashboard

## Further reading

- [PostgreSQL documentation: Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)
- Martin Kleppmann, [*Designing Data-Intensive Applications*](https://dataintensive.net/), the chapter on transactions
- Brandur Leach, [Implementing Stripe-like Idempotency Keys in Postgres](https://brandur.org/idempotency-keys)
- [Grafana k6 documentation](https://grafana.com/docs/k6/latest/)

## Author

**Mitesh Panda** · [GitHub](https://github.com/MiteshPanda) · [LinkedIn](https://www.linkedin.com/in/miteshpanda) · [Portfolio](https://mitesh-panda.framer.website/)

## License

[MIT](LICENSE). The stadium, clubs and match are fictional.
