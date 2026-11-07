# Taquilla

**A match-ticket booking engine that can't double-sell, and proves it under load.**

[![CI](https://github.com/MiteshPanda/taquilla/actions/workflows/ci.yml/badge.svg)](https://github.com/MiteshPanda/taquilla/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-LTS-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Load tested with k6](https://img.shields.io/badge/load%20tested-k6-7D64FF?logo=k6&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

Taquilla (Spanish for *box office*) is a booking API where thousands of simulated fans fight for the same seats at a fictional stadium. Row locks decide every race, a partial unique index makes a second valid ticket for a seat impossible to store, and idempotency keys make sure a double-clicked **Pay** charges exactly once.

> **Status:** in development. Every number below was measured; see [Benchmarks](#benchmarks). The full specification lives in [requirements.md](requirements.md).

![Demo: pick seats, watch the hold timer, double-click Pay, see one charge](docs/demo.gif)

*Sixty seconds of the real web page, API and Postgres, with the mock payment provider slowed to 2.5–3.5 s so the paying step shows. The last frame is the provider's `payments.charges` table and `npm run audit`, run right after the double-click.*

## Headline results

| Metric | Result |
| --- | --- |
| Oversold seats in a sellout of 10,000 journeys (about 29,550 requests) from 1,000 concurrent virtual users | **0**, under every strategy |
| Duplicate charges in the same runs | **0**; the audit passed after every run |
| Fans who got the hot seat, out of 10,000 requests for it | **1**, under every strategy (the naive route sold it to 114 fans) |
| p95 hold latency in the hot seat, 1,000 virtual users | 1,190 to 1,481 ms, by strategy |
| Throughput in the hot seat | 684 to 866 requests/s, by strategy |

Measured on an Intel Core i5-1135G7 (4 cores, 8 threads) with 8 GB of RAM and Windows 11, using PostgreSQL 16.15 in Docker, with k6 and the whole stack on the same machine. Details in [Benchmarks](#benchmarks).

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
- **Sweeper:** frees expired holds every 10 seconds with `SKIP LOCKED`, and deletes idempotency keys older than 24 hours. It's housekeeping only, because every query already treats an expired hold as free.
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
- Reserve locks the hold's seats in id order and checks that every one is still the fan's. If any lapsed or was taken, it answers `409 HOLD_EXPIRED` naming them, and nothing is charged. Otherwise it creates the hold's one order, sets it `paying` under the provider key `pay:{orderId}:{key}`, and extends the seats to at least 10 minutes from now, so they can't lapse mid-payment. A second tab paying with another key gets `409 PAYMENT_IN_PROGRESS`, and an order that is already paid is returned as it is.
- Each provider call gets 3 seconds and up to 3 retries, all with the same provider key, so a retry can never charge twice. Waits between attempts grow from up to 100 ms to up to 400 ms, at random, so retries don't all arrive together. A timeout, a dropped connection or a `5xx` is retried; a `4xx` means a bug, so it isn't.
- Same key again: the saved response is replayed. Same key with a different body: `422`. Same key while the first request is still running: `409`. An answer that says "try again" (`5xx` or `SEAT_BUSY`) isn't saved, so the retry runs again.
- If the provider times out or is down, the fan gets `503` and the order stays `paying`. A retry with the same key resumes at the charge step, and the provider hands back whatever the first attempt made, so the order completes with one charge. A decline the fan never heard about comes back as `402`, and seats lost in the meantime are refunded.
- If the server crashes mid-payment, its idempotency key is taken over after 60 seconds, and the retry resumes the same way. A crash after Confirm returns the paid order without charging again.
- Confirm, in one transaction, sells every seat, issues one ticket per seat, and marks the order `paid` and the hold `converted`, or does none of it.
- A decline answers `402`, sets the order back to `pending` and keeps the seats held, so the fan can pay again with a new key.
- If the seats were lost before confirmation, the charge is refunded, the order is marked `refunded`, any seats the hold still has are freed, and the fan gets `409 SEAT_LOST_REFUNDED` naming the lost seats. If the refund itself can't get through, the fan gets `503` and the order stays `paying`, so a retry with the same key finishes the refund.

## Tech stack

| Layer | Choice |
| --- | --- |
| API | Node.js (LTS), TypeScript, Express, Zod |
| Database | PostgreSQL 16 via `pg`, with hand-written SQL |
| Payments | Mock provider service with fault injection |
| Tests | Vitest; jsdom and Testing Library for the web page |
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

To run the web page, use `npm run web` on the host. It serves the page at http://localhost:5173, where you can sign up, log in, or press **Log in as demo fan** to log in as a random seeded fan (after `npm run reset`). Everyone sees the ground from above at night, every seat drawn in its state, so the bowl fills with a crowd as the match sells, beside one stand's seats at a time, all kept fresh every 2 to 3 seconds. Point at a seat, on the plan or in the stand, to see the view from it: the pitch, the other stands with tonight's crowd, and the rows in front of you. Pick up to 6 seats, in the stand or with a click on the plan, and they rise out of it in gold and, once logged in, hold them: the hold counts down to its expiry and can be released, or paid for, which shows your tickets. Payments go to the mock provider, so run it beside the API (`npm run payments`). If someone takes a seat first, the page says which one and refreshes the map. Open two tabs to be two fans, since each tab has its own login. It also shows whether the API at `VITE_API_URL` answers `/health`. Until WP 8.1 adds its container, `docker compose up` doesn't start it.

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
| `npm run web` | Start the web page's dev server on port 5173 |
| `npm run build` | Type-check the web page and build it into `web/dist`; any warning fails the build |
| `npm test` | Run the concurrency, race, expiry, checkout and web client test suites |
| `npm run test:coverage` | Run the tests and enforce 80% line coverage on `holds`, `checkout`, `idempotency`, the payment mock's charge logic, and the web's API client and login |
| `npm run lint` | Run ESLint with type-checked rules; any warning fails |
| `npm run format` | Format the code with Prettier (`npm run format:check` only checks it) |
| `npm run typecheck` | Type-check every package with TypeScript in `strict` mode |
| `npm run migrate` | Apply any migrations not yet applied, the API's and then the payment mock's; safe to run again |
| `npm run reset` | Drop, migrate and seed a clean stadium, and empty the payment mock's charges |
| `npm run tokens` | Write JWTs for the 1,000 test fans to `loadtest/tokens.json` |
| `npm run sweeper` | Start the expiry sweeper |
| `npm run payments` | Start the payment mock in watch mode on `PAYMENTS_PORT` |
| `npm run audit` | Check the four rules in SQL and print a pass/fail table; exit code 1 if one is broken, 2 if it can't run |

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
| `VITE_API_URL` | `http://localhost:3000` | Web: the API's address. Vite bakes it into the build, so a change needs a rebuild |
| `VITE_DEMO_PASSWORD` | `taquilla-dev` | Web: the seeded fans' password (`SEED_PASSWORD`) for **Log in as demo fan**. It ends up in the page, so use it only for shared demo accounts |

The web page reads the same `.env`. Vite passes only `VITE_` variables to the browser, so the API's secrets in that file never reach it.

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
curl -X POST localhost:4000/charges \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pay:11111111-2222-4333-8444-555555555555:attempt-1' \
  -d '{"orderId":"11111111-2222-4333-8444-555555555555","amountPaise":450000}'
```

## API

| Method | Path | Auth | What it does | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| `GET` | `/health` | None | The process is up | `200` | None |
| `GET` | `/ready` | None | The database answers too | `200` | `503` |
| `POST` | `/auth/signup` | None | Create an account | `201` | `400`, `409`, `429` |
| `POST` | `/auth/login` | None | Get a JWT | `200` | `400`, `401`, `429` |
| `GET` | `/events/:id/seats` | None | Seat map with live state | `200` | `404` |
| `GET` | `/events/:id/seats/states` | None | Only the ids of held and sold seats, for polling | `200` | `404` |
| `POST` | `/events/:id/holds` | JWT | Hold 1–6 seats, all or nothing; `Idempotency-Key` optional | `201` | `400`, `401`, `404`, `409`, `422` |
| `DELETE` | `/holds/:id` | JWT | Release a hold early | `204` | `401`, `404` |
| `POST` | `/holds/:id/checkout` | JWT | Reserve, charge, confirm; `Idempotency-Key` required | `200` with the paid order, as `GET /orders/:id` shows it | `400`, `401`, `402`, `404`, `409`, `422`, `503` |
| `GET` | `/orders/:id` | JWT | The fan's own order, with its tickets and their seats | `200` | `401`, `404` |
| `POST` | `/dev/buy-naive` | JWT | Dev only: the deliberately unsafe buy, `{ "seatId": 42 }` | `201` | `400`, `401`, `404`, `409` |

`GET /events/:id/seats/states` answers `{ "held": [42, 43], "sold": [7] }`: the seats the full map would show as held or sold, by the same rules, in id order. The web page loads the full map once and then polls this, since names and prices never change. It's under 10 KB even with every seat sold, against the full map's 185 KB, and Postgres writes its JSON, so polling costs the API little ([Benchmarks](#benchmarks)).

`DELETE /holds/:id` frees the seats the hold still has and marks it `released`. A seat another fan took after the hold lapsed stays theirs, and a paid hold stays as it is. Repeating it is harmless, and anyone else's hold gets the same `404` as one that doesn't exist.

An `Idempotency-Key` is 1 to 128 visible ASCII characters, such as a UUID, and belongs to the fan who sent it. Sending a request again with the same key and the same body returns the first answer, status and body, without doing anything again, and marks it `Idempotent-Replayed: true`. The same key with a different body, or on another route, gets `422`; while the first request is still running, `409 REQUEST_IN_PROGRESS`. An answer that means "try again", any `5xx` or `409 SEAT_BUSY`, isn't saved, so a retry with the same key runs again. A key left running for over 60 seconds belongs to a request that died, and the next request with it takes over.

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

`GET /orders/:id` shows a fan their own order, with one ticket per seat once it's paid, each with the seat's details. A paid checkout answers with exactly the same body, and so does checking out an order that is already paid, with any key, without charging again. Anyone else's order, an unknown one and a malformed id all get the same `404`, and the answer is sent with `Cache-Control: private, no-store`:

```json
{
  "orderId": "1a943714-35f4-4de0-8a51-ec5785481bbb",
  "holdId": "54a48b79-c360-49d3-9440-3362d8253ae7",
  "status": "paid",
  "amountPaise": 900000,
  "createdAt": "2026-11-06T15:41:52.112Z",
  "tickets": [
    { "id": 1, "seatId": 41, "section": "Lateral Este", "row": "B", "number": 16, "pricePaise": 450000 },
    { "id": 2, "seatId": 42, "section": "Lateral Este", "row": "B", "number": 17, "pricePaise": 450000 }
  ]
}
```

An order that isn't paid yet (`pending` or `paying`) or was `refunded` has no tickets.

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
- **Seat map:** 2,000 seats in order, a lapsed hold reads `available`, a locked seat doesn't make the map wait, and unknown or malformed event ids get `404`. The states route lists live holds and sales in id order but not a lapsed hold, agrees with the full map on every seat, stays under 10 KB with every seat sold, and doesn't wait for a locked seat either.
- **Tokens:** `npm run tokens` writes a token for each of the 1,000 seeded fans, and every one of them gets past `requireAuth`.
- **Auth:** sign-up, duplicate emails, wrong passwords, and expired, tampered and missing tokens are covered. So are the rate limit and equal timing for unknown emails.
- **Schema:** Postgres itself rejects a half-set hold on a seat, a second valid ticket for a seat and a second order for a hold.
- **Holds:** each strategy holds free seats until a database-clock expiry, refuses taken and sold seats with `409` and holds nothing, gives a lapsed hold's seat to the next fan, and rejects seats outside the event with `400`.
- **Holds route:** `POST /events/:id/holds` answers `201`, `400`, `401`, `404` and `409` under each strategy, and Postgres contention errors become `409 SEAT_BUSY` as requirements.md §6.4 maps them.
- **Sweeper:** one run frees every lapsed seat in batches of 1,000 and nothing else, steps past seats a booking has locked, never overlaps the previous run, keeps going after a failed run, and stops cleanly on `SIGTERM`. Each run also deletes idempotency keys older than 24 hours, finished or stuck, in batches, stepping past a key a request has locked.
- **Audit:** it passes on a healthy stadium with sales, a declined then paid order, a refund, a cancelled ticket and live holds. Each planted violation fails its own rule:
  - **INV-1:** a second valid ticket for a seat, planted after dropping the unique index that would refuse it.
  - **INV-2:** an order charged twice.
  - **INV-3:** a paid order with no charge, money taken for an unpaid order, and both at once with matching totals.
  - **INV-4:** a seat held 31 seconds past expiry. 29 seconds still passes.
  - **The real command** exits 0 on a freshly reset stadium, 1 with a rule broken, and 2 with the database down.
- **Orders:** the owner sees their paid order with each ticket's seat, exactly as the checkout answered it; an unpaid order has no tickets, and only valid tickets are listed. Another fan's order gets the same `404` as an unknown one, a malformed id gets `404`, and no login gets `401`.
- **Checkout recovery:** the provider is cut off mid-payment, and the fan retries with the same key. A lost answer is retried inside the request. With no retry left, the request ends in `503`, and the same key completes the order with the charge the first attempt made. A provider that stalls past every timeout still charges once; its decline comes back as `402`, and lost seats are refunded. When the provider is down and comes back, the same key pays once and another key gets `409`. A retry during the first request gets `409 REQUEST_IN_PROGRESS`. After a crash, the key is taken over at 60 seconds and the order completes; a crash after Confirm returns the paid order. Every case ends with exactly one charge.
- **Checkout route:** through the real payment mock, a payment charges once, sells the seats, issues one ticket each and converts the hold. The same key replays, a new key gets the paid order without a charge, and 10 tabs at once make one charge. No seat, hold or order lock is held while the provider works. A decline answers `402`, the order goes back to `pending`, and a new key pays. Seats lost while charging are refunded, with the rest of the hold freed, also when a seat merely lapsed. A failed refund answers `503` and the same key finishes it, and a refund that was never recorded still ends as `refunded`, never as a sale. An expired hold is never charged, an unreachable provider answers `503`, and a missing key, someone else's hold and a malformed id are refused.
- **Reserve:** a valid hold gets one order, set `paying` under `pay:{orderId}:{key}`, with its seats extended to 10 minutes and never shortened. A re-taken, lapsed or released hold gets `409 HOLD_EXPIRED` and no order. A paid order is returned untouched, another key gets `409 PAYMENT_IN_PROGRESS`, the same key resumes even if seats were lost, a declined order pays again under a new key, and a refunded one gets `409 SEAT_LOST_REFUNDED`. 20 tabs at once make one order. Reserve waits for a rival's seat lock and judges the seat as the rival left it, and it locks seats in ascending order.
- **Idempotency:** every branch of the middleware: a first run saved under the key, a replay that doesn't run again, the same body with its keys in another order, `422` for another body or route, `409` while the first is running, ten identical requests at once running once, a released key after a `5xx` or `SEAT_BUSY`, a saved `4xx`, missing and malformed keys, keys kept apart per fan, and a key stuck for 59 and 61 seconds. A stale request that finishes while a newer one holds its key neither saves its answer nor releases the key. Through `POST /events/:id/holds`, a retried hold returns the same hold and ten at once make one.
- **Payment client:** against the real mock, a success, a decline, a lost first response and a provider slower than the timeout each end in exactly one charge. An unreachable provider is reported as unavailable after 1 attempt and 3 retries. Against a scripted provider, `5xx` answers are retried with the same key, body and request ID, an attempt that gets no answer or stalls halfway through is cut off, and a refusal or an unexpected body is thrown without retrying.
- **Payment mock:** a repeated key returns the original charge, also when 20 first attempts race; one order can be charged twice under two keys; refunds are safe to repeat, also 10 at once; and each fault hits first attempts only, so the retry after a lost response gets back the one charge it made. Its migrations, settings and process are covered too.
- **Release:** `DELETE /holds/:id` frees only the seats the hold still has, answers `404` for anyone else's hold, and is harmless to repeat, even twice at once.
- **Concurrency:** through a real HTTP server, for every strategy: 100 parallel holds on one seat produce exactly one winner and 99 `409`s; overlapping multi-seat holds asked in opposite orders never get a `5xx`, and under `lock` never even wait long enough to get `SEAT_BUSY`; and a four-seat hold racing for its last seat is held whole or not at all. The suite passed 20 runs in a row.
- **Race:** 100 parallel naive buys of seat 42, at `RACE_DELAY_MS=0` and `50`. At 50, the check that only one buyer wins is marked `it.fails`, so it documents the bug without breaking CI, and turns CI red if the naive buy ever stops overselling. At 0 the count is only recorded, because whether the requests overlap depends on the machine. A separate check makes sure each race ran cleanly, with no `5xx`.
- **Expiry:** end to end with `HOLD_SECONDS=2`, a hold lasts 2 seconds, then its seats show as free and another fan can take them before any sweep, and the sweeper frees the rest. Under every strategy, a lapsed seat goes to the next fan, and a sweep running at the same moment never undoes their new hold. One sweep frees the whole stadium's lapsed seats, and four sweepers at once free each seat exactly once.
- **Web API client:** every error answer becomes an `ApiError` with its status, code, message, seats and request ID, for each of the 16 codes. An error page that isn't JSON, an unknown code and a body the schema refuses become `BAD_RESPONSE`; no answer becomes `NETWORK_ERROR`, and no full answer within 30 seconds (5 for `/health`), `TIMEOUT`. A cancel by the page itself is passed on as it is. Against the real API app over HTTP, the client calls `/health`, its body, token and key reach the server's parser, the server's errors arrive intact, and CORS lets the page send its headers and read the request ID. `npm run typecheck` fails if the web's error codes and the server's ever differ. A `401` to a request that carried a token ends the session; a `401` to a login doesn't. Through the real auth routes, sign-up and login work, the token passes `requireAuth`, and the page can read its expiry.
- **Web login:** in jsdom, the sign-up and login forms refuse what the API refuses, in its words, before sending anything, including a password of 37 `é`, which is 74 bytes. They send the email as the API stores it, sign up then log straight in, and show the API's refusals: a wrong password, a taken email, a rate limit, or no connection. The form locks while it waits. **Log in as demo fan** logs in as a random seeded fan, and explains how to seed them when the API doesn't know them. The session goes in `sessionStorage` and never `localStorage`; a reload keeps it, logging out clears it, and an expired token, whether found at load or reached while the page is open, sends the fan back to login with a notice. A token longer than `setTimeout`'s limit is waited out in steps. The sign-up and login rules live in one file both sides import, `api/src/auth/rules.ts`, and the web typecheck fails if it ever uses a Node API.
- **Web seat map:** in jsdom, each stand has a tab with its price and seats left, which shows it as a grid of seat buttons named like "Fondo Sur, row F, seat 12, available", and the four states differ in class and words, not colour alone; held and sold seats are `aria-disabled` but still reachable. Only one seat of the stand is in the tab order, and the arrow keys, Home and End (with Ctrl, the whole stand) move between seats, stopping at the edges; between the tabs they go round the ends. The page polls only the states, every 2 to 3 seconds at a random point in that window, pauses while the tab is hidden and catches up when it's shown, keeps the last map with a notice when a poll fails, retries a failed first load, and stops when it's gone. The whole 2,000-seat stadium renders.
- **Web plan and seat view (FR-WEB-6):** the plan draws all 2,000 seats where the ground's model puts them: seat 1 on a fan's left, each row above and behind the one in front, all outside the pitch and its run-off. Every point of a stand finds its own seat, and the pitch, the corners and the world outside find none. The fan's picked and held seats rise out of the plan, and the view shows the seat focused, hovered, or pointed at on the plan, else the newest pick, else the first seat held, with where it is in words and how far from the centre spot. A mouse click on a free seat of the plan picks it and shows its stand; a sold seat, the pitch and a finger's tap pick nothing. The view draws the pitch, its markings and the other stands with their crowd, holds and picks, and the rows in front of the fan, none from the front row; anything behind the camera is cut at its near plane rather than flipped, and every number on the picture is finite.
- **Web hold flow:** in jsdom with fake timers, a free seat becomes a pressed toggle, a seventh is refused with a reason, and a picked seat someone else takes drops out without counting. A fan who isn't logged in is asked to log in. A hold is sent with the token and an `Idempotency-Key`, the map is asked at once, and the seats show as the fan's own; nothing else can be picked during it. The countdown starts at the hold's length, announces the last minute, and at zero frees the seats and refreshes the map. A `409 SEAT_TAKEN` becomes "Someone just took A-2 in Fondo Norte. Pick another seat.", naming every seat stand by stand, dropping them from the picks and refreshing the map. A busy answer or a lost one is retried with the same key, so a hold made but not heard about comes back instead of colliding with itself; new seats or a refusal get a new key. Releasing frees the seats, and a hold already gone counts as released. Through the real API, two fans racing for one seat get one hold and one 409, which the page's own wording turns into the message above; a retried key returns the same hold; and another fan's hold can't be released.
- **Web checkout (FR-WEB-3):** the payment step makes its `Idempotency-Key` when it opens and keeps it for every retry: a `409 REQUEST_IN_PROGRESS` is sent again with it a second apart, up to 30 times, and a `503` or a lost answer is retried with it by the fan, also after going back and opening the step again. Only a decline, or a `422` for a key used elsewhere, makes a new one. Two clicks before the page redraws send one request. Paying hides the countdown and the release; paid shows the tickets and the order; a decline, an outage, a payment still going through and an unconfirmed one each say what happened in the fan's terms; and an expired hold, lost seats or a gone hold end it with a reason. Once a payment reaches the API, the countdown runs to at least 10 minutes, as Reserve keeps the seats (FR-PAY-5). Through the real checkout and payment mock, two clicks with one key at once make exactly one charge and both get the same paid order, and a decline followed by a new key pays with one successful charge.
- **Checkout acceptance,** the six cases of requirements.md §9.1, in `checkout.test.ts` through the real payment client and mock. They passed 20 runs in a row.
  - Same key sent twice in parallel: one charge. The second gets `409 REQUEST_IN_PROGRESS`, retries with the same key, and ends with the same answer as the first
  - Provider loses the response and the client retries: still one charge
  - Same key with a different body, or for another hold: `422`
  - Two tabs, two keys, one hold: one `200`, one `409`, one charge
  - A decline returns `402`; a retry with a new key can succeed
  - The hold expires and another fan takes the seat: `409`, no charge

### Continuous integration

Every push and pull request runs [the CI workflow](.github/workflows/ci.yml) against a Postgres 16 service container: `npm ci`, format check, lint, typecheck, the web build, migrate and test. A separate job runs `npm audit --audit-level=high`. Dependabot proposes npm and GitHub Actions updates every week.

Changes reach `main` only through a pull request, and both jobs must pass on a branch that is up to date with `main`. Branch protection enforces this for everyone, including admins.

### Load tests

| Scenario | What it does | Passes when |
| --- | --- | --- |
| `hot-seat` | 1,000 virtual users send 10,000 holds for seat 42 | Exactly one hold succeeds |
| `sellout` | 1,000 fans run 10,000 hold-then-checkout journeys for 1 to 4 adjacent seats, 70% aimed at the Lateral stands, with a fresh key per payment attempt | No failed requests; the audit passes |
| `double-click` | 1,000 fans each hold two seats, then send the same checkout twice at once with one key, retrying a `409 REQUEST_IN_PROGRESS` with that key | Both clicks end with the same answer; one successful charge per order |
| `churn` | In the Lateral Este stand, 250 fans hold every seat and walk away, 150 keep holding lapsed seats and walking away, and 300 keep trying to buy until holds expire | Expired seats are resold; the audit passes, also 45 s later |
| `seat-poll` | 1,000 fans each load the seat map once, then poll the seat states every 2 to 3 seconds for 60 s, as the web page does. `-e POLL=map` polls the full map instead | Poll p95 under 500 ms; under 0.1% failed |

```bash
npm run reset && npm run tokens
k6 run loadtest/hot-seat.js
npm run audit
```

`sellout` and `double-click` also need the payment mock (`npm run payments`) beside the API, and the sweeper (`npm run sweeper`) for the audit's fourth rule. Reset before each run.

- **`sellout`:**
  - **Picking seats:** a fan picks a row and asks for adjacent seats in it. When they're taken, the fan picks again, up to three times.
  - **Paying:** a decline is followed by a new attempt with a new key, up to three, and a `503` is retried with the same key, as the web page will (FR-WEB-3).
  - **The thresholds:** no unexpected status, under 0.1% failed requests, and at least one paid order.
- **`churn`:**
  - **Short holds:** run the API with `HOLD_SECONDS=10`, so holds lapse during the run. The script checks this from the first hold's expiry.
  - **Every sale is a resale:** the whole stand is held by fans who walk away before any buyer arrives, so every seat sold is an expired hold.
  - **The audit, twice:** run it right after, and again 45 seconds later, when the sweeper must have cleared any hold left over (INV-4).
- **`double-click`:**
  - **No contention for seats:** every fan's two seats are their own, so the only contention is a fan against their own second click.
  - **What it checks:** the two answers must match once any key order inside the JSON is ignored, because a replay is read back from a `jsonb` column.

Measured on an Intel Core i5-1135G7 (4 cores, 8 threads), 8 GB of RAM and Windows 11. PostgreSQL 16.15 ran in Docker, with the `lock` strategy and the API's pool of 20 connections. The payment mock used its default faults: 100–800 ms of latency, 5% declines and 2% lost answers. k6 2.3.0 ran on the same machine:

| Run | Requests | Failed | Outcome | Audit |
| --- | --- | --- | --- | --- |
| `sellout`, 1,000 fans, 10,000 journeys | 29,559 | 0 | 1,958 of 2,000 seats sold in 1,156 orders; 65 declines paid again with a new key | Pass: ₹68,91,000 charged and paid |
| `churn`, 700 fans for 80 s, `HOLD_SECONDS=10` | 24,400 | 0 | 642 seat holds abandoned; 424 of the stand's 500 seats resold in 212 orders, all after their holds expired. 415 of the abandoned holds were taken by the next fan before any sweep (lazy expiry), and the sweeper freed the other 227 | Pass right after, and again 45 s later, with no seat left held |
| `double-click`, 1,000 fans | 4,120 | 0 | 1,040 double-clicked payments: every one had a click told `409 REQUEST_IN_PROGRESS` that then got the saved answer; 0 different answers; 995 orders paid | Pass: 995 charges, none twice |

The sellout's holds took 1.25 s on average (p95 1.56 s). Its checkouts took 7.8 s (p95 8.9 s): the provider's own delay, plus a turn at each of a checkout's steps on an API whose single thread 1,000 fans keep busy (see [Benchmarks](#benchmarks)). Churn's 76 unsold seats were mostly single seats between sold pairs, which fans asking for two adjacent seats can't use. The 42 seats the sellout left unsold were still free when the last fans gave up picking at random, or were held by fans declined three times.

`npm run audit` checks the four rules directly in SQL and exits with code 1 on any violation, so CI and load-test runs fail loudly. It isn't `npm audit`, which is npm's own check of dependencies.

- **The checks:**
  1. **INV-1:** no seat has two valid tickets.
  2. **INV-2:** no order has two successful charges.
  3. **INV-3:** the money kept by the payment provider matches the paid orders, order by order, so two errors can't cancel out in the totals.
  4. **INV-4:** no seat is still marked held 30 seconds after its hold lapsed.
- **One snapshot:** all four read one read-only snapshot of the database, so orders and charges are compared at the same instant.
- **When to run it:** after a load test, once no checkout is still in flight.
- **Exit codes:** 0 when every rule holds, 1 when one is broken, and 2 when the audit can't run, such as when the database is down.

```text
Rule   Check                                          Result  Detail
-----  ---------------------------------------------  ------  -----------------------------------------------------
INV-1  A seat has at most one valid ticket            PASS    2 valid tickets, no seat twice
INV-2  An order has at most one successful charge     PASS    1 successful charge, none twice for one order
INV-3  Money charged equals the total of paid orders  PASS    charged ₹9,000.00, paid ₹9,000.00 across 1 paid order
INV-4  No seat stays held 30 s past expiry            PASS    no stale holds

Audit passed: all four rules hold.
```

For `hot-seat`, start the API with the strategy you want (`BOOKING_STRATEGY`) and the same `JWT_SECRET` the tokens were signed with, and reset before every run, because seat 42 is gone after the first. `k6 run -e TARGET=naive loadtest/hot-seat.js` aims it at the unsafe dev route instead, where it fails on purpose. Its thresholds are exactly one winner, under 0.1% failures, and p95 under 2,500 ms, the laptop baseline in NFR-3. Each virtual user's first request is spread over the first second, because Windows client editions refuse most connections opened in the same instant.

## Benchmarks

Each run started from a freshly reset stadium. The full results, how they were taken, the CPU profile and the query plans are in [docs/benchmarks.md](docs/benchmarks.md).

**Hot seat**, 10,000 hold requests for seat 42:

| Strategy | Hot-seat winners | p95 hold latency (ms) | Requests/s | Retries or aborts |
| --- | --- | --- | --- | --- |
| naive (dev route) | 1 at `RACE_DELAY_MS=0`; **114** at `50` | 445; 409 | 2,346; 2,344 | none: it never waits on a lock |
| `lock` | 1 | 1,481 | 684 | 0 `SEAT_BUSY` |
| `cas` | 1 | 1,454 | 712 | 0 `SEAT_BUSY` |
| `serializable` | 1 | 1,190 | 866 | 0 retries, 0 `SEAT_BUSY` |

**Sellout**, 10,000 hold-then-checkout journeys over 2,000 seats:

| Strategy | Seats sold | Orders paid | Requests/s | Hold p95 (ms) | Checkout p95 (ms) | Retries or aborts | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lock` | 1,959 | 1,145 | 653 | 1,521 | 8,429 | 0 `SEAT_BUSY` | Pass |
| `cas` | 1,959 | 1,152 | 582 | 1,490 | 9,111 | 0 `SEAT_BUSY` | Pass |
| `serializable` | 1,952 | 1,200 | 640 | 1,392 | 8,248 | 618 retries, 2 `SEAT_BUSY` | Pass |

**Setup:** Intel Core i5-1135G7 (4 cores, 8 threads) · 8 GB of RAM · Windows 11 Home · PostgreSQL 16.15 in Docker · one API process with a pool of 20 connections · 1,000 virtual users · 10,000 requests (hot seat) or 10,000 journeys, about 29,550 requests (sellout) · the payment mock with its default faults · k6 2.3.0 and the whole stack on one machine.

- **Every strategy gives exactly one hot-seat winner** and passes the audit after a sellout. The naive route oversells whenever its race window opens: here 114 times with `RACE_DELAY_MS=50`, and once at `0` (298 times in an earlier run on the same laptop).
- **`serializable` is the fastest correct strategy in the hot seat.** Its reads take no row lock, so the losing requests don't queue on seat 42. In the sellout it paid for that with 618 retries where overlapping holds conflicted. **`cas` costs Postgres twice the CPU of `lock`**, because its `UPDATE` locks and re-checks the row on every request.
- **The limit is the API's single Node.js thread.** It used about as much CPU time as each run's wall time, while Postgres used one or two of the eight threads. With every virtual user sending its next request as soon as the last one answers, latency is about 1,000 divided by requests per second. The next lever is more API processes, which the stateless API allows (NFR-7).
- **Tuning from a CPU profile:**
  - **JWTs:** a secret built into a key once, instead of on every request, cut the API's CPU per request by about 10%.
  - **Postgres:** `random_page_cost = 1.1` lets it read the seat map straight from its index, in 0.6–0.7 ms instead of 2.3–2.8 ms.
  - **Tried and reverted:** sending `BEGIN` and the transaction limits as one round trip made no measurable difference.
- **On a laptop, repeated runs vary by up to about 20%,** as the machine heats up. Compare strategies within one batch.

**Seat-map polling**, 1,000 fans each loading the map once and then polling every 2 to 3 seconds, with 1,950 of the 2,000 seats sold:

| What the fans poll | Requests/s | Poll p95 | Most one process serves, back to back |
| --- | --- | --- | --- |
| The full map, 185 KB | 185 | 4.3 s | 197/s |
| The seat states, 8.7 KB, JSON written by Postgres | 373 | 10.8 ms | 1,804/s |

The full map couldn't keep up with 1,000 fans, as WP 6.4 predicted. Polling only the states, with Postgres writing the JSON, uses about a fifth of one API process, with no cache: every answer is current.

These numbers compare strategies on one laptop. They are not a production capacity claim.

## Design decisions

- **Postgres is the only source of truth.** No Redis locks: a lock outside the database can expire mid-request and let two writers collide anyway. ([ADR 1](docs/adr/0001-postgres-is-the-source-of-truth.md))
- **Hand-written SQL, no ORM.** Every lock is visible in the code and easy to review. ([ADR 2](docs/adr/0002-hand-written-sql.md))
- **One lock order.** Seats are always locked in ascending id order, so overlapping holds queue instead of deadlocking. ([ADR 3](docs/adr/0003-lock-ordering.md))
- **Lazy expiry.** Queries treat `held_until < now()` as free, so correctness never waits for the sweeper.
- **No locks across network calls.** Checkout is three short steps around the payment call, so a slow provider can't freeze a queue of fans. ([ADR 4](docs/adr/0004-three-step-checkout.md))
- **The database clock decides expiry.** Always `now()` in Postgres, never the API server's clock.
- **Money is integer paise.** No floating point anywhere near a price.
- **The login token lives in `sessionStorage`.** A reload keeps the fan logged in, each tab can be a different fan, and nothing outlives the tab. Moving it to an httpOnly cookie is the planned upgrade. ([ADR 5](docs/adr/0005-session-token-in-sessionstorage.md))

The longer reasoning, with the alternatives that were rejected, is in the [architecture decision records](docs/adr/):

1. [Postgres is the source of truth](docs/adr/0001-postgres-is-the-source-of-truth.md)
2. [Hand-written SQL, no ORM](docs/adr/0002-hand-written-sql.md)
3. [Lock seats in ascending id order](docs/adr/0003-lock-ordering.md)
4. [Check out in three steps around the payment call](docs/adr/0004-three-step-checkout.md)
5. [Keep the login token in sessionStorage](docs/adr/0005-session-token-in-sessionstorage.md)

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
│   │   ├── auth/            # signup, login, JWT middleware; rules.ts is shared with the web page
│   │   ├── seats/           # seat map with lazy expiry
│   │   ├── holds/           # lock, cas and serializable strategies
│   │   ├── checkout/        # reserve → charge → confirm; payment-client.ts calls the provider
│   │   ├── orders/          # GET /orders/:id, and the order view checkout answers with
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
│   ├── src/
│   │   ├── api/             # typed API client: every error answer becomes an ApiError
│   │   ├── auth/            # login and sign-up forms, the demo fan, the tab's session
│   │   ├── checkout/        # paying for a hold: one key per attempt, riding out 409s
│   │   ├── holds/           # picking seats, holding them, the countdown, releasing, the payment step
│   │   ├── seats/           # the seat map: stand tabs and grids, keyboard moves, polling
│   │   ├── stadium/         # the ground as one model: the plan from above, the view from a seat
│   │   ├── config.ts        # VITE_API_URL and VITE_DEMO_PASSWORD, checked by the build and the page
│   │   ├── services.ts      # the client and session the page runs on, wired together
│   │   └── App.tsx          # the page: login, or who is logged in
│   └── test/
├── loadtest/                # k6 scenarios
├── scripts/                 # reset, seed, tokens, audit
├── docs/
│   ├── adr/                 # architecture decision records
│   └── benchmarks.md        # results, CPU profile, tuning and query plans
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
