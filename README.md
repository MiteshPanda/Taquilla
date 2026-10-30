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

`POST /dev/buy-naive` (dev only) checks the seat, then writes. Fire 100 parallel requests at seat 42 and it sells that seat **[N] times**.

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

Pick one with `BOOKING_STRATEGY`. All three pass the same concurrency tests.

| Strategy | How it works | Trade-off |
| --- | --- | --- |
| `lock` (default) | `SELECT … FOR UPDATE` in id order, check, then update | Easy to reason about; contenders queue on the row |
| `cas` | One conditional `UPDATE` that only matches free seats; all-or-nothing | One statement, no read-then-write gap |
| `serializable` | Naive check-then-act inside `SERIALIZABLE`, retried on error `40001` | Correct even with naive code; wastes work under contention |

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
| `npm run reset` | Drop, migrate and seed a clean stadium |
| `npm run tokens` | Write JWTs for the 1,000 test fans to `loadtest/tokens.json` |
| `npm run sweeper` | Start the expiry sweeper |
| `npm run audit` | Check the four rules; exit code 1 on any violation |

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://taquilla:taquilla@localhost:5432/taquilla` | Postgres connection |
| `PORT` | `3000` | API port |
| `JWT_SECRET` | none, required | Signs login tokens |
| `BOOKING_STRATEGY` | `lock` | `lock`, `cas` or `serializable` |
| `HOLD_SECONDS` | `300` | Hold length (tests use `2`) |
| `SWEEP_INTERVAL_SECONDS` | `10` | How often the sweeper runs |
| `PAYMENTS_URL` | `http://localhost:4000` | Mock provider address |
| `DECLINE_RATE` | `0.05` | Mock: share of charges declined |
| `LOST_RESPONSE_RATE` | `0.02` | Mock: share of first attempts whose response is lost |
| `SEED_PASSWORD` | `taquilla-dev` | Password for seeded test fans (local only) |
| `RACE_DELAY_MS` | `0` | Dev only: widens the naive race window |

## API

| Method | Path | Auth | What it does | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/auth/signup` | None | Create an account | `201` | `400`, `409` |
| `POST` | `/auth/login` | None | Get a JWT | `200` | `400`, `401` |
| `GET` | `/events/:id/seats` | None | Seat map with live state | `200` | `404` |
| `POST` | `/events/:id/holds` | JWT | Hold 1–6 seats, all or nothing; `Idempotency-Key` optional | `201` | `400`, `401`, `404`, `409`, `422` |
| `DELETE` | `/holds/:id` | JWT | Release a hold early | `204` | `401`, `404` |
| `POST` | `/holds/:id/checkout` | JWT | Reserve, charge, confirm; `Idempotency-Key` required | `200` | `400`, `401`, `402`, `404`, `409`, `422`, `503` |
| `GET` | `/orders/:id` | JWT | Order with its tickets | `200` | `401`, `404` |

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
npm test
```

- **Concurrency:** 100 parallel holds on one seat produce exactly one winner and 99 `409`s, for every strategy.
- **Race:** the naive buy is marked `it.fails`, so it documents the bug without breaking CI.
- **Expiry:** with `HOLD_SECONDS=2`, another fan can take a lapsed hold's seat, and the sweeper frees it.
- **Checkout and idempotency:**
  - Same key sent twice in parallel: one charge, identical responses
  - Provider loses the response and the client retries: still one charge
  - Same key, different body: `422`
  - Two tabs, two keys, one hold: one `200`, one `409`, one charge
  - A decline returns `402`; a retry with a new key can succeed
  - The hold expires and another fan takes the seat: `409`, no charge

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

- **Postgres is the only source of truth.** No Redis locks: a lock outside the database can expire mid-request and let two writers collide anyway.
- **Hand-written SQL, no ORM.** Every lock is visible in the code and easy to review.
- **Lazy expiry.** Queries treat `held_until < now()` as free, so correctness never waits for the sweeper.
- **No locks across network calls.** Checkout is three short steps around the payment call, so a slow provider can't freeze a queue of fans.
- **The database clock decides expiry.** Always `now()` in Postgres, never the API server's clock.
- **Money is integer paise.** No floating point anywhere near a price.

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
│   ├── src/
│   │   ├── db.ts            # pool + withTransaction helper
│   │   ├── server.ts
│   │   ├── auth/            # signup, login, JWT middleware
│   │   ├── seats/           # seat map with lazy expiry
│   │   ├── holds/           # lock, cas and serializable strategies
│   │   ├── checkout/        # reserve → charge → confirm
│   │   ├── idempotency/     # Idempotency-Key middleware
│   │   ├── jobs/sweeper.ts  # frees expired holds (own process)
│   │   └── dev/             # naive buy, dev only
│   └── test/                # concurrency, race, expiry, checkout
├── payments-mock/           # fake provider with fault injection
├── web/                     # React + Vite seat map
├── loadtest/                # k6 scenarios
├── scripts/                 # reset, seed, tokens, audit
├── .github/workflows/ci.yml
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
