# Taquilla: Requirements Specification

**Version** 0.1 (draft) · **Date** 23 October 2026 · **Author** Mitesh Panda · **Status** In development

The keywords **MUST**, **SHOULD** and **MAY** follow [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Requirement IDs are stable; reference them in tests, commits and pull requests.

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Definitions](#2-definitions)
3. [System invariants](#3-system-invariants)
4. [Functional requirements](#4-functional-requirements)
5. [Non-functional requirements](#5-non-functional-requirements)
6. [API contract](#6-api-contract)
7. [Data requirements](#7-data-requirements)
8. [Technical requirements](#8-technical-requirements)
9. [Verification and acceptance](#9-verification-and-acceptance)
10. [Milestones](#10-milestones)
11. [Out of scope for v1](#11-out-of-scope-for-v1)
12. [Constraints and assumptions](#12-constraints-and-assumptions)
13. [Revision history](#13-revision-history)

## 1. Purpose and scope

Taquilla is a match-ticket booking engine for a fictional stadium. Its defining goal is that **under heavy concurrent demand, no seat is ever sold twice and no fan is ever charged twice**, with both claims proven by repeatable load tests and a SQL audit.

**In scope for v1:** one match in a 2,000-seat stadium, a public seat map, expiring seat holds, checkout against a mock payment provider, idempotent write endpoints, three selectable concurrency strategies, k6 load tests with an invariant audit, a minimal React frontend, Docker Compose and CI.

Everything else is out of scope; see [section 11](#11-out-of-scope-for-v1).

## 2. Definitions

| Term | Meaning |
| --- | --- |
| Fan | An authenticated user who books seats |
| Seat | One seat for one event, in state `available`, `held` or `sold` |
| Hold | A temporary, exclusive claim on 1–6 seats that expires after `HOLD_SECONDS` |
| Order | The checkout record for a hold; at most one per hold |
| Ticket | Proof of purchase for one seat, either `valid` or `cancelled` |
| Idempotency key | A client-generated string that makes retrying a request safe |
| Strategy | The concurrency-control method for holds: `lock`, `cas` or `serializable` |
| Lazy expiry | Treating a hold as free as soon as `held_until < now()`, without waiting for cleanup |
| VU | A k6 virtual user, simulating one concurrent fan |
| Paise | One hundredth of a rupee; all money is stored as integer paise |

## 3. System invariants

These MUST hold at all times, under any load. Each one has its own audit check (FR-AUD-1).

| ID | Invariant | Enforced by |
| --- | --- | --- |
| INV-1 | A seat has at most one valid ticket | Row locks on seats; partial unique index `one_valid_ticket_per_seat` as a backstop |
| INV-2 | An order has at most one successful charge | Idempotency keys, the order state machine, provider-key reuse on retries |
| INV-3 | The total successfully charged equals the total of `paid` orders | Orders become `paid` only in Confirm; lost seats are refunded |
| INV-4 | An expired hold is free immediately, and no seat stays `held` more than 30 seconds past expiry while the sweeper runs | Lazy expiry in every query; the sweeper |

## 4. Functional requirements

### 4.1 Accounts and authentication

| ID | Requirement |
| --- | --- |
| FR-AUTH-1 | A fan MUST be able to sign up with an email and password; only a bcrypt hash of the password is stored. |
| FR-AUTH-2 | Login MUST return a signed JWT. Every booking endpoint MUST reject a missing or invalid token with `401`. |
| FR-AUTH-3 | A fan MUST only see and act on their own holds and orders; anyone else's MUST return `404`. |

### 4.2 Events and seat map

| ID | Requirement |
| --- | --- |
| FR-SEAT-1 | `GET /events/:id/seats` MUST be public and return every seat of the event with section, row, seat number, price and state (`available`, `held` or `sold`). |
| FR-SEAT-2 | A seat whose hold has expired MUST be reported as `available`, even before the sweeper runs. |
| FR-SEAT-3 | Reading the seat map MUST NOT take row locks or block bookings. |
| FR-SEAT-4 | The seed MUST create one event and 2,000 seats in four stands (Lateral Este, Lateral Oeste, Fondo Norte, Fondo Sur; 20 rows × 25 seats each), plus 1,000 test fans (`fan1@taquilla.test` to `fan1000@taquilla.test`, password from `SEED_PASSWORD`). |

### 4.3 Seat holds

| ID | Requirement |
| --- | --- |
| FR-HOLD-1 | A fan MUST be able to hold 1 to 6 distinct seats of one event in a single request. |
| FR-HOLD-2 | Seat IDs that don't belong to the event MUST be rejected with `400`. |
| FR-HOLD-3 | Holds MUST be all-or-nothing: if any requested seat isn't free, nothing is held and the response is `409 SEAT_TAKEN`, listing the unavailable seats. |
| FR-HOLD-4 | When many fans request the same seat at once, exactly one hold MUST succeed and every other request MUST get `409`, never a `5xx`. |
| FR-HOLD-5 | The strategy MUST be selectable with `BOOKING_STRATEGY` (`lock`, `cas` or `serializable`), and all three MUST satisfy FR-HOLD-4. |
| FR-HOLD-6 | Multi-seat holds MUST lock seats in ascending ID order. |
| FR-HOLD-7 | A successful hold MUST return `201` with `holdId`, `seatIds`, `amountPaise` and `expiresAt`. |
| FR-HOLD-8 | A fan MUST be able to release their own active hold early with `DELETE /holds/:id`, which returns `204`. |

### 4.4 Hold expiry

| ID | Requirement |
| --- | --- |
| FR-EXP-1 | A hold MUST expire `HOLD_SECONDS` after creation (default 300). |
| FR-EXP-2 | An expired seat MUST be holdable by another fan immediately, without waiting for the sweeper. |
| FR-EXP-3 | A sweeper process MUST reset expired held seats to `available` every `SWEEP_INTERVAL_SECONDS` (default 10), in batches of up to 1,000, using `FOR UPDATE SKIP LOCKED`. |
| FR-EXP-4 | Two or more sweepers running at once MUST stay correct. |
| FR-EXP-5 | The sweeper MUST delete idempotency keys older than 24 hours. |

### 4.5 Checkout and payment

| ID | Requirement |
| --- | --- |
| FR-PAY-1 | `POST /holds/:id/checkout` MUST require an `Idempotency-Key` header and return `400` without one. |
| FR-PAY-2 | A hold MUST have at most one order. |
| FR-PAY-3 | Checkout MUST run in three steps: **Reserve** (one transaction), **Charge** (no open transaction) and **Confirm** (one transaction). No row lock may be held during the provider call. |
| FR-PAY-4 | Reserve MUST verify that every seat of the hold is still held by it. If not, it MUST respond `409 HOLD_EXPIRED` and MUST NOT charge. |
| FR-PAY-5 | Reserve MUST extend the hold's seats by 10 minutes before charging. |
| FR-PAY-6 | If the order is already `paid`, checkout MUST return it without charging. If it is `paying` under a different payment key, checkout MUST respond `409 PAYMENT_IN_PROGRESS`. |
| FR-PAY-7 | The provider call MUST use the key `pay:{orderId}:{clientKey}`, a 3-second timeout and up to 3 retries with the same key. |
| FR-PAY-8 | On success, Confirm MUST atomically mark the seats `sold`, create one valid ticket per seat, and set the order `paid` and the hold `converted`. |
| FR-PAY-9 | If the seats were lost before Confirm, the system MUST refund the charge, set the order `refunded` and respond `409 SEAT_LOST_REFUNDED`. |
| FR-PAY-10 | A declined charge MUST return the order to `pending` and respond `402 PAYMENT_DECLINED`; a retry with a new key MAY succeed. |
| FR-PAY-11 | A retry with the same key while the order is `paying` under that payment key MUST resume at the Charge step. |
| FR-PAY-12 | If the provider is still unreachable after all retries, the API MUST respond `503 PAYMENT_UNAVAILABLE` and leave the order `paying`, so a retry with the same key can resume it. |

### 4.6 Idempotency

| ID | Requirement |
| --- | --- |
| FR-IDEM-1 | `POST /events/:id/holds` MUST accept an optional `Idempotency-Key`; `POST /holds/:id/checkout` MUST require one. |
| FR-IDEM-2 | Keys MUST be scoped per fan: the pair `(user_id, idem_key)` is unique. |
| FR-IDEM-3 | A repeated key with the same body MUST replay the original status code and body without running the handler again. |
| FR-IDEM-4 | A repeated key with a different body MUST respond `422 IDEMPOTENCY_KEY_REUSED`. |
| FR-IDEM-5 | A repeated key while the first request is still running MUST respond `409 REQUEST_IN_PROGRESS`. |
| FR-IDEM-6 | If the handler fails with a `5xx`, the key MUST be released so the client can retry. |
| FR-IDEM-7 | A key left in progress for more than 60 seconds MAY be re-claimed by a new request. |

### 4.7 Mock payment provider

| ID | Requirement |
| --- | --- |
| FR-MOCK-1 | The provider MUST run as a separate service (port 4000) and write to its own `payments` schema. |
| FR-MOCK-2 | `POST /charges` MUST be idempotent by key: a repeated key returns the original charge. |
| FR-MOCK-3 | The provider MUST NOT deduplicate by order, so only Taquilla's own logic can prevent double charges. |
| FR-MOCK-4 | `POST /charges/:key/refund` MUST mark the charge `refunded` and be safe to call twice. |
| FR-MOCK-5 | Fault injection MUST be configurable: 100–800 ms random latency, `DECLINE_RATE` (default 0.05) and `LOST_RESPONSE_RATE` (default 0.02), applied to first attempts only. |

### 4.8 Audit

| ID | Requirement |
| --- | --- |
| FR-AUD-1 | `npm run audit` MUST run one SQL check per invariant (INV-1 to INV-4) and print a pass/fail table. |
| FR-AUD-2 | The audit MUST exit with code 1 if any check fails, so it can gate CI and load-test runs. |

### 4.9 Web frontend

| ID | Requirement |
| --- | --- |
| FR-WEB-1 | The seat map MUST show each stand as a grid with distinct styles for available, held by others, held by you and sold. The page knows its own hold from the hold response. |
| FR-WEB-2 | After a hold, the page MUST show a countdown to `expiresAt`. |
| FR-WEB-3 | The page MUST create one `Idempotency-Key` per payment attempt, reuse it on retries, and create a new one only after a decline. |
| FR-WEB-4 | The seat map SHOULD refresh every 2–3 seconds. |
| FR-WEB-5 | A `409` MUST be shown as a friendly message naming the seat, not as a raw error. |

### 4.10 Developer tooling

| ID | Requirement |
| --- | --- |
| FR-DEV-1 | `POST /dev/buy-naive` MUST reproduce the check-then-act race for demos and benchmarks, and MUST be disabled when `NODE_ENV=production`. |
| FR-DEV-2 | `RACE_DELAY_MS` (default 0) MUST widen the naive race window. |
| FR-DEV-3 | `npm run reset` MUST migrate and seed a clean stadium. |
| FR-DEV-4 | `npm run tokens` MUST write JWTs for the 1,000 test fans to `loadtest/tokens.json`, which MUST be gitignored. |
| FR-DEV-5 | The repo MUST include the k6 scenarios `hot-seat`, `sellout`, `double-click` and `churn`. |

## 5. Non-functional requirements

| ID | Quality | Requirement |
| --- | --- | --- |
| NFR-1 | Correctness | The audit MUST pass after the `sellout` scenario: [10,000] requests from [1,000] concurrent virtual users. |
| NFR-2 | Correctness | The `hot-seat` scenario (10,000 requests for one seat) MUST produce exactly one successful hold. |
| NFR-3 | Latency | p95 hold latency SHOULD stay under 500 ms during `hot-seat` on a developer laptop. This is a baseline to tune after the first run. |
| NFR-4 | Reliability | Unexpected failures (`5xx` and timeouts) MUST stay below 0.1% of requests under load; `409` is an expected answer. |
| NFR-5 | Fail fast | Every booking transaction MUST set `lock_timeout = '2s'`, so no request waits on a lock indefinitely. |
| NFR-6 | Recovery | A crash or timeout mid-payment MUST NOT cause a double charge, and a retry with the same key MUST complete the order. |
| NFR-7 | Statelessness | The API MUST keep no booking state in memory, so several instances stay correct together. |
| NFR-8 | Security | SQL MUST be parameterised, all input MUST be validated with Zod, secrets MUST come from environment variables, and holds and orders MUST use UUIDs. |
| NFR-9 | Security | No secret may be committed: `.env` is gitignored and only `.env.example` is tracked. |
| NFR-10 | Portability | The full stack MUST start with `docker compose up`. |
| NFR-11 | Reproducibility | Published benchmarks MUST state CPU, RAM, OS, PostgreSQL version, virtual users and request count. |
| NFR-12 | Testability | CI MUST run migrations, the test suite, a short k6 smoke test and the audit on every push. |
| NFR-13 | Maintainability | TypeScript MUST run in `strict` mode, and booking SQL MUST be hand-written rather than generated by an ORM. |
| NFR-14 | Observability | Logs MUST be structured JSON with a request ID on every line. |
| NFR-15 | Data integrity | Money MUST be stored and computed as integer paise, with no floating-point arithmetic on prices. |

## 6. API contract

### 6.1 Endpoints

| Method | Path | Auth | Idempotency-Key | Success | Possible errors |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/auth/signup` | None | No | `201` | `400`, `409` |
| `POST` | `/auth/login` | None | No | `200` with `{ token }` | `400`, `401` |
| `GET` | `/events/:id/seats` | None | No | `200` | `404` |
| `POST` | `/events/:id/holds` | JWT | Optional | `201` | `400`, `401`, `404`, `409`, `422` |
| `DELETE` | `/holds/:id` | JWT | No | `204` | `401`, `404` |
| `POST` | `/holds/:id/checkout` | JWT | Required | `200` | `400`, `401`, `402`, `404`, `409`, `422`, `503` |
| `GET` | `/orders/:id` | JWT | No | `200` | `401`, `404` |
| `POST` | `/dev/buy-naive` | JWT | No | `201` | Dev only; `404` in production |

### 6.2 Error format

Every error response MUST use this shape. `seatIds` appears only when specific seats caused the error.

```json
{
  "error": {
    "code": "SEAT_TAKEN",
    "message": "Seat 42 was just taken. Pick another seat.",
    "seatIds": [42]
  }
}
```

### 6.3 Error codes

| HTTP | Code | When |
| --- | --- | --- |
| `400` | `VALIDATION_FAILED` | Invalid body, unknown seat IDs, or a missing required header |
| `401` | `UNAUTHORIZED` | Missing or invalid token |
| `402` | `PAYMENT_DECLINED` | The provider declined the charge |
| `404` | `NOT_FOUND` | The resource doesn't exist or belongs to another fan |
| `409` | `EMAIL_TAKEN` | Signup with an email that already exists |
| `409` | `SEAT_TAKEN` | A requested seat is held or sold |
| `409` | `SEAT_BUSY` | A lock wait timed out or a deadlock was detected; safe to retry |
| `409` | `HOLD_EXPIRED` | The hold's seats were re-taken before checkout |
| `409` | `SEAT_LOST_REFUNDED` | The seats were lost after charging; the charge was refunded |
| `409` | `PAYMENT_IN_PROGRESS` | The order is being paid under another key |
| `409` | `REQUEST_IN_PROGRESS` | The same idempotency key is still being processed |
| `422` | `IDEMPOTENCY_KEY_REUSED` | Same key, different request body |
| `503` | `PAYMENT_UNAVAILABLE` | The provider was unreachable after retries; retry with the same key |

### 6.4 Database error mapping

| Postgres code | Meaning | API response |
| --- | --- | --- |
| `23505` | Unique violation | `409 SEAT_TAKEN` on the ticket index, `409 EMAIL_TAKEN` on users |
| `40001` | Serialization failure | Retry up to 3 times, then `409 SEAT_BUSY` |
| `40P01` | Deadlock detected | `409 SEAT_BUSY` |
| `55P03` | Lock not available (`lock_timeout`) | `409 SEAT_BUSY` |

## 7. Data requirements

| ID | Requirement |
| --- | --- |
| DR-1 | All tables MUST be created by numbered SQL migrations in `api/migrations/`. |
| DR-2 | A seat MUST be `held` if and only if `hold_id` and `held_until` are both set, enforced by a CHECK constraint. |
| DR-3 | `tickets` MUST have a partial unique index on `seat_id` where `status = 'valid'`. |
| DR-4 | `orders.hold_id` MUST be unique. |
| DR-5 | A hold MUST record its `seat_ids` and `amount_paise` when it is created. |
| DR-6 | Timestamps MUST be `TIMESTAMPTZ`, and every expiry decision MUST use the database clock (`now()`). |
| DR-7 | Holds and orders MUST use UUID primary keys from `gen_random_uuid()`. |
| DR-8 | Prices and amounts MUST be integers in paise. |
| DR-9 | `payments.charges` MUST be keyed by idempotency key and MUST NOT be unique on `order_id`. |

## 8. Technical requirements

### 8.1 Development environment

| Tool | Version | Purpose |
| --- | --- | --- |
| Git | Any recent | Version control |
| Docker with Compose v2 | Any recent | Runs Postgres and every service |
| Node.js and npm | Current LTS | API, payment mock, scripts, tests and the web build |
| k6 | Latest stable | Load tests |
| Machine | 4+ CPU cores and 8 GB+ RAM recommended | 1,000 virtual users beside the stack; use 500 on smaller machines |

### 8.2 Services

| Service | Port | What runs |
| --- | --- | --- |
| `postgres` | 5432 | PostgreSQL 16 |
| `api` | 3000 | Express API |
| `payments-mock` | 4000 | Fake payment provider |
| `sweeper` | None | Expiry sweeper, no HTTP |
| `web` | 5173 | React + Vite seat map |

### 8.3 Dependencies

| Package | Runtime dependencies | Dev dependencies |
| --- | --- | --- |
| `api` | express, pg, zod, jsonwebtoken, bcryptjs, pino, pino-http | typescript, tsx, vitest, supertest, @types/express, @types/pg, @types/jsonwebtoken, @types/supertest |
| `payments-mock` | express, pg, pino | typescript, tsx |
| `web` | react, react-dom | vite, @vitejs/plugin-react, typescript |
| `loadtest` | k6, a standalone binary rather than an npm package | None |

Install the current stable versions and commit `package-lock.json`, so every install is reproducible.

### 8.4 Configuration

All tunables MUST come from environment variables, with these defaults in `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://taquilla:taquilla@localhost:5432/taquilla` | Postgres connection |
| `PORT` | `3000` | API port |
| `JWT_SECRET` | None, required | Signs login tokens |
| `BOOKING_STRATEGY` | `lock` | `lock`, `cas` or `serializable` |
| `HOLD_SECONDS` | `300` | Hold length (tests use `2`) |
| `SWEEP_INTERVAL_SECONDS` | `10` | How often the sweeper runs |
| `PAYMENTS_URL` | `http://localhost:4000` | Mock provider address |
| `DECLINE_RATE` | `0.05` | Mock: share of charges declined |
| `LOST_RESPONSE_RATE` | `0.02` | Mock: share of first attempts whose response is lost |
| `SEED_PASSWORD` | `taquilla-dev` | Password for seeded test fans (local only) |
| `RACE_DELAY_MS` | `0` | Dev only: widens the naive race window |

## 9. Verification and acceptance

| Requirement | Verified by | Passes when |
| --- | --- | --- |
| FR-HOLD-4, FR-HOLD-5 | `api/test/concurrency.test.ts` | 100 parallel holds on one seat give 1 winner and 99 `409`s, for each strategy |
| FR-DEV-1 | `api/test/race.test.ts`, marked `it.fails` | The naive buy sells seat 42 more than once |
| FR-EXP-1 to FR-EXP-4 | `api/test/expiry.test.ts` with `HOLD_SECONDS=2` | A lapsed seat can be held by another fan, and the sweeper frees it |
| FR-IDEM-3 to FR-IDEM-6, FR-PAY-4 to FR-PAY-11 | `api/test/checkout.test.ts` | All six cases in 9.1 pass |
| INV-1 to INV-4, NFR-1 | k6 `sellout`, then `npm run audit` | The audit exits with code 0 |
| NFR-2 to NFR-4 | k6 `hot-seat` thresholds | `holds_won` count is 1, p95 is under 500 ms, failures are under 0.1% |
| INV-2 | k6 `double-click`, then the audit | No order has two successful charges |
| FR-EXP-2, INV-4 | k6 `churn`, then the audit | Expired seats are resold and the audit exits with code 0 |
| NFR-12 | GitHub Actions | The workflow is green on every push |

### 9.1 Checkout acceptance cases

1. The same key sent twice in parallel produces one charge and identical responses.
2. The provider loses the response and the client retries: still one charge.
3. The same key with a different body returns `422`.
4. Two tabs with two keys on one hold: one `200`, one `409`, one charge.
5. A decline returns `402`; a retry with a new key can succeed.
6. The hold expires and another fan takes the seat: `409`, no charge.

## 10. Milestones

| Phase | Days | Delivers | Exit criterion |
| --- | --- | --- | --- |
| 0. Setup | 1 | Project skeleton, part of NFR-10 | `GET /health` returns `200` |
| 1. Model the stadium | 2–3 | FR-AUTH, FR-SEAT | 2,000 seats served, all available |
| 2. Build it wrong | 4 | FR-DEV-1, FR-DEV-2 | The naive race test fails reliably |
| 3. Make it correct | 5–7 | FR-HOLD, DR-3 | One winner under every strategy |
| 4. Holds that expire | 8–9 | FR-EXP | Expiry tests pass |
| 5. Checkout and idempotency | 10–13 | FR-PAY, FR-IDEM, FR-MOCK | All six checkout cases pass |
| 6. Load tests | 14–16 | FR-AUD, FR-DEV-3 to FR-DEV-5, NFR-1 to NFR-4 | All scenarios and the audit pass |
| 7. Frontend | 17–19 | FR-WEB | A 60-second demo is recorded |
| 8. Ship | 20–21 | NFR-9, NFR-11, NFR-12 | A fresh clone reproduces the audit result |

## 11. Out of scope for v1

- Real payment gateways; Razorpay test mode is a stretch goal
- Ticket cancellation, refunds on request and resale; `SOLD` is final
- Virtual waiting rooms and queueing
- Multiple venues, event management and admin screens
- Real stadium geometry; the seat map is a grid per stand
- Email, SMS or PDF tickets
- Multi-node databases, replicas and sharding
- Anti-hoarding limits beyond 6 seats per hold

## 12. Constraints and assumptions

- A single PostgreSQL 16 instance is the system of record.
- Load tests run on a developer laptop; results compare strategies and are not capacity claims.
- The stadium, clubs and match are fictional, with no real club names, crests or logos.
- Payments are simulated; no real money or card data is ever handled.
- The project is built solo over about 21 working days, following the phases in section 10.

## 13. Revision history

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 23 Oct 2026 | Initial draft |
