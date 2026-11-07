# Taquilla: Requirements Specification

**Version** 0.2 (draft) · **Date** 2 November 2026 · **Author** Mitesh Panda · **Status** In development

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
| FR-AUTH-1 | A fan MUST be able to sign up with an email and a password of at least 8 characters and at most 72 bytes; only a bcrypt hash (cost 12) of the password is stored, and the email is stored lowercase. |
| FR-AUTH-2 | Login MUST return a signed JWT. Every booking endpoint MUST reject a missing or invalid token with `401`. |
| FR-AUTH-3 | A fan MUST only see and act on their own holds and orders; anyone else's MUST return `404`. |
| FR-AUTH-4 | Login MUST give a wrong password and an unknown email the same `401` in similar time. Tokens MUST be verified with HS256 only and MUST expire after `JWT_EXPIRES_IN`. |
| FR-AUTH-5 | Each IP address MUST be limited to 10 requests a minute across `/auth/*`, answering `429 RATE_LIMITED` beyond that. |

### 4.2 Events and seat map

| ID | Requirement |
| --- | --- |
| FR-SEAT-1 | `GET /events/:id/seats` MUST be public and return every seat of the event with section, row, seat number, price and state (`available`, `held` or `sold`), ordered by section, row and seat, with `Cache-Control: no-store`. |
| FR-SEAT-2 | A seat whose hold has expired MUST be reported as `available`, even before the sweeper runs. |
| FR-SEAT-3 | Reading the seat map MUST NOT take row locks or block bookings. |
| FR-SEAT-4 | The seed MUST create one event and 2,000 seats in four stands (Lateral Este, Lateral Oeste, Fondo Norte, Fondo Sur; 20 rows × 25 seats each), plus 1,000 test fans (`fan1@taquilla.test` to `fan1000@taquilla.test`, password from `SEED_PASSWORD`). |
| FR-SEAT-5 | `GET /events/:id/seats/states` MUST be public and return `{ held, sold }`, the ids of the event's held and sold seats in id order, by the same rules as FR-SEAT-1 to FR-SEAT-3, with `Cache-Control: no-store`. A page polls it after loading the full map once, since names and prices never change. |

### 4.3 Seat holds

| ID | Requirement |
| --- | --- |
| FR-HOLD-1 | A fan MUST be able to hold 1 to 6 distinct seats of one event in a single request. |
| FR-HOLD-2 | Seat IDs that don't belong to the event MUST be rejected with `400`. |
| FR-HOLD-3 | Holds MUST be all-or-nothing: if any requested seat isn't free, nothing is held and the response is `409 SEAT_TAKEN`, listing the unavailable seats. |
| FR-HOLD-4 | When many fans request the same seat at once, exactly one hold MUST succeed and every other request MUST get `409`, never a `5xx`. |
| FR-HOLD-5 | The strategy MUST be selectable with `BOOKING_STRATEGY` (`lock`, `cas` or `serializable`), and all three MUST satisfy FR-HOLD-4. It MUST be chosen once at startup, and an unknown value MUST stop the API from starting. |
| FR-HOLD-6 | Multi-seat holds MUST lock seats in ascending ID order. |
| FR-HOLD-7 | A successful hold MUST return `201` with `holdId`, `seatIds`, `amountPaise` and `expiresAt`. |
| FR-HOLD-8 | A fan MUST be able to release their own active hold early with `DELETE /holds/:id`, which returns `204`. It MUST free only the seats still held by that hold, mark it `released` (a paid hold stays `converted`), and be harmless to repeat. |

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
| FR-PAY-5 | Reserve MUST extend the hold's seats to at least 10 minutes from now before charging, never shortening a hold with longer left. |
| FR-PAY-6 | If the order is already `paid`, checkout MUST return it without charging. If it is `paying` under a different payment key, checkout MUST respond `409 PAYMENT_IN_PROGRESS`. |
| FR-PAY-7 | The provider call MUST use the key `pay:{orderId}:{clientKey}`, a 3-second timeout and up to 3 retries with the same key. |
| FR-PAY-8 | On success, Confirm MUST atomically mark the seats `sold`, create one valid ticket per seat, and set the order `paid` and the hold `converted`. |
| FR-PAY-9 | If the seats were lost before Confirm, the system MUST refund the charge, set the order `refunded`, free any seats the hold still has, and respond `409 SEAT_LOST_REFUNDED`. If the refund can't be made, it MUST respond `503 PAYMENT_UNAVAILABLE` and leave the order `paying`, so a retry with the same key finishes the refund. A charge that comes back already refunded MUST never confirm a sale. |
| FR-PAY-10 | A declined charge MUST return the order to `pending` and respond `402 PAYMENT_DECLINED`; a retry with a new key MAY succeed. |
| FR-PAY-11 | A retry with the same key while the order is `paying` under that payment key MUST resume at the Charge step, even if seats were lost meanwhile, so the charge is settled and refunded rather than left unknown. |
| FR-PAY-12 | If the provider is still unreachable after all retries, the API MUST respond `503 PAYMENT_UNAVAILABLE` and leave the order `paying`, so a retry with the same key can resume it. |

### 4.6 Idempotency

| ID | Requirement |
| --- | --- |
| FR-IDEM-1 | `POST /events/:id/holds` MUST accept an optional `Idempotency-Key`; `POST /holds/:id/checkout` MUST require one. A key MUST be 1 to 128 visible ASCII characters. |
| FR-IDEM-2 | Keys MUST be scoped per fan: the pair `(user_id, idem_key)` is unique. |
| FR-IDEM-3 | A repeated key with the same body MUST replay the original status code and body without running the handler again, marked with `Idempotent-Replayed: true`. |
| FR-IDEM-4 | A repeated key with a different body MUST respond `422 IDEMPOTENCY_KEY_REUSED`. |
| FR-IDEM-5 | A repeated key while the first request is still running MUST respond `409 REQUEST_IN_PROGRESS`. |
| FR-IDEM-6 | If the handler fails with a `5xx`, or answers `409 SEAT_BUSY`, the key MUST be released so the client can retry. |
| FR-IDEM-7 | A key left in progress for more than 60 seconds MAY be re-claimed by a new request. |

### 4.7 Mock payment provider

| ID | Requirement |
| --- | --- |
| FR-MOCK-1 | The provider MUST run as a separate service (port 4000) and write to its own `payments` schema. |
| FR-MOCK-2 | `POST /charges` MUST be idempotent by key: a repeated key returns the original charge. |
| FR-MOCK-3 | The provider MUST NOT deduplicate by order, so only Taquilla's own logic can prevent double charges. |
| FR-MOCK-4 | `POST /charges/:key/refund` MUST mark the charge `refunded` and be safe to call twice. |
| FR-MOCK-5 | Fault injection MUST be configurable: random latency between `LATENCY_MIN_MS` and `LATENCY_MAX_MS` (default 100–800 ms), `DECLINE_RATE` (default 0.05) and `LOST_RESPONSE_RATE` (default 0.02), applied to first attempts only. |

### 4.8 Audit

| ID | Requirement |
| --- | --- |
| FR-AUD-1 | `npm run audit` MUST run one SQL check per invariant (INV-1 to INV-4), in one read-only snapshot, and print a pass/fail table. INV-3 MUST be compared order by order, not only in total. |
| FR-AUD-2 | The audit MUST exit with code 1 if any check fails, so it can gate CI and load-test runs, and with code 2 if it cannot run. |

### 4.9 Web frontend

| ID | Requirement |
| --- | --- |
| FR-WEB-1 | The seat map MUST show each stand as a grid with distinct styles for available, held by others, held by you and sold. The page knows its own hold from the hold response. |
| FR-WEB-2 | After a hold, the page MUST show a countdown to `expiresAt`. |
| FR-WEB-3 | The page MUST create one `Idempotency-Key` per payment attempt, reuse it on retries (including after `409 REQUEST_IN_PROGRESS` and `503`), and create a new one only after a decline. |
| FR-WEB-4 | The seat map SHOULD refresh every 2–3 seconds. |
| FR-WEB-5 | A `409` MUST be shown as a friendly message naming the seat, not as a raw error. |
| FR-WEB-6 | The page SHOULD show a plan of the ground with every seat in its state, raise the fan's picked and held seats on it, and show the view from the seat pointed at or picked last. |

### 4.10 Developer tooling

| ID | Requirement |
| --- | --- |
| FR-DEV-1 | `POST /dev/buy-naive` MUST reproduce the check-then-act race for demos and benchmarks, and MUST be disabled when `NODE_ENV=production`. |
| FR-DEV-2 | `RACE_DELAY_MS` (default 0) MUST widen the naive race window. |
| FR-DEV-3 | `npm run reset` MUST migrate and seed a clean stadium with no charges left in the `payments` schema, and MUST refuse to run when `NODE_ENV=production` or the database host isn't local. |
| FR-DEV-4 | `npm run tokens` MUST write JWTs for the 1,000 test fans to `loadtest/tokens.json`, which MUST be gitignored, and MUST refuse to run when `NODE_ENV=production` or the database host isn't local. |
| FR-DEV-5 | The repo MUST include the k6 scenarios `hot-seat`, `sellout`, `double-click`, `churn` and `seat-poll`. |

## 5. Non-functional requirements

| ID | Quality | Requirement |
| --- | --- | --- |
| NFR-1 | Correctness | The audit MUST pass after the `sellout` scenario: 10,000 hold-then-checkout journeys from 1,000 concurrent virtual users, about 30,000 requests. |
| NFR-2 | Correctness | The `hot-seat` scenario (10,000 requests for one seat) MUST produce exactly one successful hold. |
| NFR-3 | Latency | p95 hold latency SHOULD stay under 2,500 ms during `hot-seat` with 1,000 virtual users on a developer laptop. Every virtual user sends its next request as soon as the last one answers, so latency is about 1,000 divided by requests per second. Measured in WP 6.4 on an 8-thread laptop: 1.19 to 1.48 s across the strategies, limited by the API's single Node.js thread (`docs/benchmarks.md`). |
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
| `GET` | `/health` | None | No | `200` | None |
| `GET` | `/ready` | None | No | `200` | `503` |
| `POST` | `/auth/signup` | None | No | `201` with `{ id, email }` | `400`, `409`, `429` |
| `POST` | `/auth/login` | None | No | `200` with `{ token }` | `400`, `401`, `429` |
| `GET` | `/events/:id/seats` | None | No | `200` | `404` |
| `GET` | `/events/:id/seats/states` | None | No | `200` with `{ held, sold }` | `404` |
| `POST` | `/events/:id/holds` | JWT | Optional | `201` | `400`, `401`, `404`, `409`, `422` |
| `DELETE` | `/holds/:id` | JWT | No | `204` | `401`, `404` |
| `POST` | `/holds/:id/checkout` | JWT | Required | `200` with the paid order, as `GET /orders/:id` shows it | `400`, `401`, `402`, `404`, `409`, `422`, `503` |
| `GET` | `/orders/:id` | JWT | No | `200` with `{ orderId, holdId, status, amountPaise, createdAt, tickets: [{ id, seatId, section, row, number, pricePaise }] }` | `401`, `404` |
| `POST` | `/dev/buy-naive` | JWT | No | `201` with `{ ticketId, seatId }` | `400`, `401`, `404`, `409`; dev only, so `404` in production |

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
| `429` | `RATE_LIMITED` | Too many requests to `/auth/*` from one IP address |
| `500` | `INTERNAL_ERROR` | An unexpected failure; the details are only in the logs |
| `503` | `PAYMENT_UNAVAILABLE` | The provider was unreachable after retries; retry with the same key |
| `503` | `DATABASE_UNAVAILABLE` | `GET /ready` could not reach the database |

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
| DR-1 | All tables MUST be created by numbered SQL migrations: the API's in `api/migrations/`, and the mock provider's in `payments-mock/migrations/`, applied in its `payments` schema. |
| DR-2 | A seat MUST be `held` if and only if `hold_id` and `held_until` are both set, and any other seat MUST have neither set, enforced by a CHECK constraint. |
| DR-3 | `tickets` MUST have a partial unique index on `seat_id` where `status = 'valid'`. |
| DR-4 | `orders.hold_id` MUST be unique. |
| DR-5 | A hold MUST record its `seat_ids` and `amount_paise` when it is created. |
| DR-6 | Timestamps MUST be `TIMESTAMPTZ`, and every expiry decision MUST use the database clock (`now()`). |
| DR-7 | Holds and orders MUST use UUID primary keys from `gen_random_uuid()`. |
| DR-8 | Prices and amounts MUST be integers in paise. |
| DR-9 | `payments.charges` MUST be keyed by idempotency key and MUST NOT be unique on `order_id`. |
| DR-10 | A hold MUST cover 1 to 6 seats, and prices and amounts MUST be greater than zero, enforced by CHECK constraints. |
| DR-11 | A `paying` order MUST have a `payment_key`, and a `done` idempotency key MUST have a saved response, enforced by CHECK constraints. |
| DR-12 | `users.email` MUST be lowercase, enforced by a CHECK constraint, so the unique index ignores letter case. |

## 8. Technical requirements

### 8.1 Development environment

| Tool | Version | Purpose |
| --- | --- | --- |
| Git | Any recent | Version control |
| Docker with Compose v2 | Any recent | Builds the images and runs Postgres and every service |
| Node.js and npm | Current LTS | Scripts, tests and load-test tokens, and running a service on the host while developing it |
| k6 | Latest stable | Load tests |
| Machine | 4+ CPU cores and 8 GB+ RAM recommended | 1,000 virtual users beside the stack; use 500 on smaller machines |

### 8.2 Services

| Service | Port | What runs |
| --- | --- | --- |
| `postgres` | 5432 | PostgreSQL 16 |
| `migrate` | None | The API's migrations, then exits |
| `payments-migrate` | None | The payment mock's migrations, then exits |
| `seed` | None | Seeds the stadium into an empty database, then exits |
| `api` | 3000 | Express API |
| `payments-mock` | 4000 | Fake payment provider |
| `sweeper` | None | Expiry sweeper, no HTTP |
| `web` | 8080 | The seat map's static build, served by nginx |

Every port is published on `127.0.0.1` only. On the host, `npm run web` serves the page's development build on 5173.

The images are built from `api/Dockerfile`, `payments-mock/Dockerfile` and `web/Dockerfile` in several stages, so the final image holds the compiled code and the production dependencies only. The API's image also runs `migrate`, `seed` and `sweeper`, each with its own command. Every image runs as an unprivileged user and has a health check.

### 8.3 Dependencies

| Package | Runtime dependencies | Dev dependencies |
| --- | --- | --- |
| Root (shared by every package) | None | typescript, vitest, @vitest/coverage-v8, eslint, @eslint/js, typescript-eslint, eslint-config-prettier, eslint-plugin-react-hooks, prettier, husky, lint-staged, @types/node, @redocly/cli (lints the OpenAPI spec), ajv, ajv-formats and yaml (check the API's answers against it) |
| `api` | express, helmet, cors, express-rate-limit, pg, zod, jsonwebtoken, bcryptjs, pino, pino-http | tsx, supertest, @types/express, @types/cors, @types/pg, @types/jsonwebtoken, @types/supertest |
| `payments-mock` | express, pg, pino, pino-http, zod | tsx, @types/express, @types/pg |
| `web` | react, react-dom, zod, @fontsource-variable/archivo (the page's typeface, served with it rather than from a font CDN) | vite, @vitejs/plugin-react, @types/react, @types/react-dom, jsdom, @testing-library/react, @testing-library/dom |
| `loadtest` | k6, a standalone binary rather than an npm package | None |

The images build on `node:26.13.0-alpine3.24`, the Node.js version in `.nvmrc`, and serve the page with `nginxinc/nginx-unprivileged:1.30.6-alpine`.

Install the current stable versions and commit `package-lock.json`, so every install is reproducible. TypeScript stays on 6.0 until typescript-eslint supports a newer major version.

### 8.4 Configuration

All tunables MUST come from environment variables, with these defaults in `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://taquilla:taquilla@localhost:5432/taquilla` | Postgres connection |
| `PORT` | `3000` | API port |
| `JWT_SECRET` | None, required | Signs login tokens; at least 32 characters |
| `JWT_EXPIRES_IN` | `1h` | How long a login token lasts: a number and `s`, `m`, `h` or `d` |
| `BOOKING_STRATEGY` | `lock` | `lock`, `cas` or `serializable` |
| `HOLD_SECONDS` | `300` | Hold length (tests use `2`) |
| `SWEEP_INTERVAL_SECONDS` | `10` | How often the sweeper runs |
| `SWEEPER_HEARTBEAT_FILE` | None | Sweeper: a file it touches after every successful run, which its container's health check reads; unset, it keeps none |
| `PAYMENTS_URL` | `http://localhost:4000` | Mock provider address |
| `DECLINE_RATE` | `0.05` | Mock: share of charges declined |
| `LOST_RESPONSE_RATE` | `0.02` | Mock: share of first attempts whose response is lost |
| `LATENCY_MIN_MS` | `100` | Mock: shortest delay added to a first attempt |
| `LATENCY_MAX_MS` | `800` | Mock: longest delay added to a first attempt |
| `PAYMENTS_PORT` | `4000` | Mock: its port, kept apart from the API's `PORT` because both read one `.env` |
| `SEED_PASSWORD` | `taquilla-dev` | Password for seeded test fans (local only) |
| `RACE_DELAY_MS` | `0` | Dev only: widens the naive race window |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated browser origins allowed to call the API |
| `VITE_API_URL` | `http://localhost:3000` | Web: the API's address, baked into the build; an `http` or `https` URL with no query or fragment |
| `VITE_DEMO_PASSWORD` | `taquilla-dev` | Web: the seeded fans' password (`SEED_PASSWORD`) for the demo login; at least 8 characters, and readable by anyone with the page |

`docker-compose.yml` passes each service only the variables it uses, from `.env` or its own defaults. It sets `DATABASE_URL`, `PAYMENTS_URL` and `CORS_ORIGINS` for the containers' network, so `.env`'s values for those apply on the host only. The images set `NODE_ENV=production`. In the web image, `VITE_API_URL` and `VITE_DEMO_PASSWORD` are build arguments.

## 9. Verification and acceptance

| Requirement | Verified by | Passes when |
| --- | --- | --- |
| DR-2 to DR-8, DR-10 to DR-12 | `api/test/schema.test.ts` | Postgres rejects every state these rules forbid |
| FR-AUTH-1, FR-AUTH-2, FR-AUTH-4, FR-AUTH-5 | `api/test/auth.test.ts` | Sign-up, login, every bad-token case and the rate limit behave as specified |
| FR-SEAT-1 to FR-SEAT-3 | `api/test/seats.test.ts` | 2,000 seats in order, a lapsed hold reads `available`, and a locked seat doesn't delay the map |
| FR-SEAT-5 | `api/test/seats.test.ts` | Live holds and sales are listed in id order and a lapsed hold isn't; the answer agrees with the full map on every seat, stays under 10 KB with every seat sold, doesn't wait for a locked seat, and gives `404` for an unknown event |
| FR-WEB-1, FR-WEB-4 | `web/test/SeatMap.test.tsx`, `web/test/seats.test.ts` | One tab per stand with its price and seats left, showing that stand as a grid of buttons named like "Fondo Sur, row F, seat 12, available"; the four states differ in class and words as well as colour; one tab stop in the grid with arrow-key movement, and arrow keys between the tabs; states polled every 2 to 3 seconds, paused while the tab is hidden |
| FR-WEB-6 | `web/test/SeatMap.test.tsx`, `web/test/stadium.test.ts` | The plan draws all 2,000 seats in their stands, with seat 1 on a fan's left and each row above and behind the one in front; every point of a stand finds its seat and the pitch finds none; picked and held seats are raised; the view shows the seat focused, hovered or pointed at on the plan, else the newest pick, else the first seat held, named and placed in words; a mouse click on a free seat on the plan picks it and a tap only shows its stand; the view draws the pitch, the other stands with their crowd, holds and picks, and the rows in front, cut at the camera rather than flipped |
| FR-DEV-4 | `api/test/tokens.test.ts` | 1,000 tokens are written, one per seeded fan, and each one authenticates; production and remote hosts are refused |
| FR-SEAT-4, FR-DEV-3 | `api/test/reset.test.ts` | A reset leaves 2,000 seats, 1,000 fans and no charges, and refuses production or a remote host |
| FR-SEAT-4, NFR-10 (the stack's seed) | `api/test/seed.test.ts` | An empty database gets 2,000 seats and 1,000 fans, also when two seeders start at once; a database with a match or fans is left untouched |
| FR-HOLD-1 to FR-HOLD-3 | `api/test/holds.test.ts` | Free, taken, sold, lapsed and unknown seats give the specified result under each strategy |
| FR-HOLD-7, §6.4 | `api/test/holds-route.test.ts` | `POST /events/:id/holds` answers `201`, `400`, `401`, `404` and `409` under each strategy, and each Postgres code maps as §6.4 says |
| FR-HOLD-8, FR-AUTH-3 | `api/test/release.test.ts` | The owner frees the hold, a stranger gets `404`, and a repeated or simultaneous release changes nothing more |
| FR-HOLD-5 | `api/test/strategy.test.ts` | The server exits with code 1 on an unknown strategy, and starts and logs its choice for each valid one |
| FR-HOLD-3, FR-HOLD-4, FR-HOLD-6 | `api/test/concurrency.test.ts` | For each strategy: 100 parallel holds on one seat give 1 winner and 99 `409`s; opposite-order multi-seat holds get no `5xx` (and no `SEAT_BUSY` under `lock`); a racing four-seat hold is all or nothing |
| FR-DEV-1 | `api/test/race.test.ts`, marked `it.fails` | The naive buy sells seat 42 more than once |
| FR-DEV-1, FR-DEV-2 | `api/test/naive.test.ts` | The naive buy works, honours `RACE_DELAY_MS`, and answers `404` under `NODE_ENV=production` |
| FR-EXP-3, FR-EXP-5 | `api/test/sweeper.test.ts` | One run frees every lapsed seat in batches and nothing else, skips locked seats, never overlaps, deletes idempotency keys older than 24 hours, and the process stops with exit code 0 on `SIGTERM`; the heartbeat is touched after every successful run only, and the health check fails three intervals (at least 30 s) after the last one |
| FR-EXP-1 to FR-EXP-4, INV-4 | `api/test/expiry.test.ts`, one test with `HOLD_SECONDS=2` | A lapsed seat can be held by another fan before any sweep, a sweep never undoes a newer hold, and four sweepers at once free each seat exactly once |
| FR-MOCK-1 to FR-MOCK-5, DR-9 | `payments-mock/test/*.test.ts` | A repeated key returns the original charge, also when 20 first attempts race; one order can be charged under two keys; a refund is safe to repeat; and every fault hits first attempts only |
| FR-AUD-1, FR-AUD-2 | `api/test/audit.test.ts` | A healthy stadium passes; a planted violation of each rule fails exactly that rule (INV-2 also breaks INV-3); the command exits 0, 1 and 2 as specified |
| FR-AUTH-3 (orders) | `api/test/orders.test.ts` | The owner sees their order with each ticket's seat, the same body the checkout answered; a stranger, an unknown id and a malformed id all get the same `404` |
| FR-PAY-11, FR-PAY-12, NFR-6 | `api/test/checkout-recovery.test.ts` | A lost answer, a provider slower than every timeout, an outage and a crash each end, after a retry with the same key, in a completed order and exactly one charge |
| FR-PAY-1, FR-PAY-3, FR-PAY-8 to FR-PAY-10 | `api/test/checkout-route.test.ts` | Through the real payment mock: one charge then one ticket per seat; no lock held while charging; a decline answers `402` and a new key pays; lost seats are refunded and the rest freed, also after a failed or unrecorded refund |
| FR-PAY-2, FR-PAY-4 to FR-PAY-6, FR-PAY-11 (Reserve) | `api/test/reserve.test.ts` | A valid hold gets one `paying` order and seats extended to 10 minutes; a re-taken, lapsed or released hold gets `409 HOLD_EXPIRED` and no order; a paid order is returned untouched; another key gets `409 PAYMENT_IN_PROGRESS`; 20 tabs at once make one order |
| FR-IDEM-1 to FR-IDEM-7, FR-PAY-1 | `api/test/idempotency.test.ts` | Every branch of the middleware, including ten identical requests at once running once and a stale request that finishes after its key was taken over |
| FR-PAY-7, FR-PAY-12 (the client) | `api/test/payment-client.test.ts` | Every attempt uses one key and gets 3 seconds; a lost response or a slow provider still ends in one charge; an unreachable provider is reported as unavailable after 3 retries; a `4xx` is never retried |
| FR-IDEM-3 to FR-IDEM-6, FR-PAY-4 to FR-PAY-11 | `api/test/checkout.test.ts` | All six cases in 9.1 pass |
| INV-1 to INV-4, NFR-1 | k6 `sellout`, then `npm run audit` | The audit exits with code 0 |
| NFR-2 to NFR-4 | k6 `hot-seat` thresholds | `holds_won` count is 1, p95 is under 2,500 ms, failures are under 0.1% |
| INV-2 | k6 `double-click`, then the audit | Both clicks end with the same answer, and no order has two successful charges |
| FR-EXP-2, INV-4 | k6 `churn` with `HOLD_SECONDS=10`, then the audit | Every seat sold was an expired hold resold, and the audit exits with code 0 right after and 45 seconds later |
| FR-WEB-2, FR-WEB-5 | `web/test/Booking.test.tsx`, `web/test/selection.test.ts`, `api/test/web-client.test.ts` | Up to 6 free seats can be picked; a hold is sent with the fan's token and an `Idempotency-Key` kept for retries of the same seats; the hold counts down to `expiresAt`, warns at a minute and frees the seats when it runs out; a release frees them; a `409 SEAT_TAKEN` names the seats, as in "Someone just took F-12 in Fondo Sur. Pick another seat.", drops them and refreshes the map; two fans racing for one seat through the real API get one hold and one such message |
| FR-WEB-3 | `web/test/Booking.test.tsx`, `web/test/pay.test.ts`, `api/test/web-client.test.ts` | The payment key is made when the payment step opens and kept for every retry, after `409 REQUEST_IN_PROGRESS` (sent again a second apart, up to 30 times), a `503` or a lost answer, also across going back; a new one is made only after a decline (or a `422` for a reused key); a double-clicked Pay sends one request; paying, paid, declined, unavailable and the hold ending each show their own state; and through the real checkout and payment mock, two clicks with one key at once make exactly one charge and get the same paid order |
| FR-WEB-4, FR-SEAT-5 | k6 `seat-poll` | 1,000 fans each load the map once and poll the states every 2 to 3 seconds: p95 under 500 ms and failures under 0.1% |
| §6.2, §6.3 (the web's API client) | `web/test/client.test.ts`, `api/test/web-client.test.ts` | Every error answer becomes a typed error with its code, status and seats, also through the real API app; anything else becomes a network, timeout or bad-response error; and the typecheck fails if the web's codes and the server's differ |
| FR-AUTH-1, FR-AUTH-2 (the web page) | `web/test/App.test.tsx`, `web/test/session.test.ts`, `web/test/services.test.ts`, `api/test/auth-rules.test.ts`, `api/test/web-client.test.ts` | The forms refuse what the API refuses, in its words, using the same rules file; sign-up, login and the demo login work against the real routes; the token is kept in `sessionStorage` only; and an expired or refused token sends the fan back to login (ADR 5) |
| §6.1 to §6.3 (the OpenAPI spec, `docs/openapi.yaml`) | `npm run lint:api`, `api/test/openapi.test.ts` | The spec passes Redocly's `recommended-strict` rules; the API's routes and the spec's operations match one to one; its error codes are the API's; and the real API answers every operation with a documented status, headers and a body that matches its schema, reaching every documented success and `4xx` |
| NFR-10 | `docker compose up --build` on a fresh clone, with only `JWT_SECRET` set in `.env` | The jobs exit with code 0, every other service turns healthy, and the seat map at http://localhost:8080 shows the seeded stadium; a fan can log in as the demo fan, hold seats and pay |
| NFR-12 | GitHub Actions, `.github/workflows/ci.yml` | The workflow is green on every push: `test` (format, lint, the OpenAPI lint, typecheck, the build, migrate and the test suite), `stack` (the three images built and the stack healthy, then the k6 smoke test passing its thresholds and `npm run audit` exiting with code 0) and `audit` (`npm audit`) |

### 9.1 Checkout acceptance cases

1. The same key sent twice in parallel produces one charge. While the first runs, the second gets `409 REQUEST_IN_PROGRESS` (FR-IDEM-5); retried with the same key, it gets the first one's saved answer, so both end with identical responses.
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
| 0.2 | 2 Nov 2026 | Added `INTERNAL_ERROR`, `DATABASE_UNAVAILABLE`, `/health`, `/ready`, `NODE_ENV`, `LOG_LEVEL`, `CORS_ORIGINS` and the shared dev dependencies |
| 0.3 | 3 Nov 2026 | Tightened DR-2 so a half-set hold is rejected; added DR-10 and DR-11 |
| 0.4 | 3 Nov 2026 | Added the safety refusals to FR-DEV-3 |
| 0.5 | 3 Nov 2026 | Added password rules, FR-AUTH-4, FR-AUTH-5, `RATE_LIMITED`, DR-12, `JWT_EXPIRES_IN` and express-rate-limit |
| 0.6 | 3 Nov 2026 | Added the seat order and `Cache-Control: no-store` to FR-SEAT-1 |
| 0.7 | 4 Nov 2026 | Added the naive buy's response and errors to §6.1 |
| 0.8 | 4 Nov 2026 | FR-HOLD-5: the strategy is chosen once at startup, and an unknown one stops the API |
| 0.9 | 4 Nov 2026 | Added the verification row for FR-HOLD-1 to FR-HOLD-3 |
| 0.10 | 4 Nov 2026 | Added the verification row for FR-HOLD-7 and the §6.4 error mapping |
| 0.11 | 5 Nov 2026 | Widened the concurrency verification row to FR-HOLD-3 and FR-HOLD-6 |
| 0.12 | 5 Nov 2026 | Added the safety refusals to FR-DEV-4 |
| 0.13 | 5 Nov 2026 | NFR-3: replaced the 500 ms placeholder with the measured 2,500 ms laptop baseline |
| 0.14 | 5 Nov 2026 | FR-HOLD-8: what a release frees, and that repeating it is harmless |
| 0.15 | 6 Nov 2026 | Added the verification row for the sweeper (FR-EXP-3) |
| 0.16 | 6 Nov 2026 | Widened the expiry verification row to INV-4 |
| 0.17 | 6 Nov 2026 | The mock provider: its own migrations (DR-1), latency settings and `PAYMENTS_PORT`, its dependencies and verification row, and a reset that clears its charges (FR-DEV-3) |
| 0.18 | 6 Nov 2026 | Added the verification row for the payment client (FR-PAY-7, FR-PAY-12) |
| 0.19 | 6 Nov 2026 | Idempotency: the key format (FR-IDEM-1), the replay header (FR-IDEM-3), `SEAT_BUSY` also releases a key (FR-IDEM-6), and the verification row |
| 0.20 | 6 Nov 2026 | Reserve: FR-PAY-5 extends to at least 10 minutes from now, FR-PAY-11 resumes even after lost seats, and the verification row |
| 0.21 | 6 Nov 2026 | Charge and Confirm: the checkout's `200` body, FR-PAY-9's freed seats and failed refunds, and the verification row |
| 0.22 | 6 Nov 2026 | Added the verification row for resume and outage paths (FR-PAY-11, FR-PAY-12, NFR-6) |
| 0.23 | 6 Nov 2026 | `GET /orders/:id`'s body, which a paid checkout now shares, and its verification row |
| 0.24 | 6 Nov 2026 | §9.1 case 1: a parallel duplicate gets `409` and retries with the same key; FR-WEB-3's retries; FR-EXP-5 in the sweeper's verification row |
| 0.25 | 7 Nov 2026 | The audit: one snapshot and an order-by-order INV-3 (FR-AUD-1), exit code 2 (FR-AUD-2), and its verification row |
| 0.26 | 7 Nov 2026 | NFR-1 counts journeys instead of placeholder requests; the `double-click` verification row also requires matching answers |
| 0.27 | 7 Nov 2026 | The `churn` verification row: short holds, and an audit 45 seconds after the run |
| 0.28 | 7 Nov 2026 | NFR-3: the measured hot-seat latency per strategy and what limits it |
| 0.29 | 7 Nov 2026 | The web scaffold: `VITE_API_URL`, the web's dependencies (zod, React types, the hooks lint rules), and the verification row for its API client |
| 0.30 | 7 Nov 2026 | The web login: `VITE_DEMO_PASSWORD`, the web's test dependencies (jsdom, Testing Library), and the verification row for FR-AUTH-1 and FR-AUTH-2 in the page |
| 0.31 | 7 Nov 2026 | FR-SEAT-5, the seat states a page polls; the `seat-poll` scenario in FR-DEV-5; verification rows for FR-SEAT-5, FR-WEB-1 and FR-WEB-4 |
| 0.32 | 7 Nov 2026 | The verification row for the hold flow, FR-WEB-2 and FR-WEB-5 |
| 0.33 | 7 Nov 2026 | The verification row for the payment step, FR-WEB-3 |
| 0.34 | 7 Nov 2026 | FR-WEB-6, the plan of the ground and the view from a seat; FR-WEB-1's verification row shows one stand at a time; the web page's typeface in §8.3 |
| 0.35 | 7 Nov 2026 | Production containers (WP 8.1): the services and images in §8.2, the base images in §8.3, `SWEEPER_HEARTBEAT_FILE` and how Compose passes variables in §8.4, and verification rows for NFR-10 and the stack's seed |
| 0.36 | 7 Nov 2026 | CI hardening (WP 8.2): the verification row for NFR-12 names the jobs, including the stack built from its images, the k6 smoke test and the audit |
| 0.37 | 7 Nov 2026 | The OpenAPI spec (WP 8.3): its verification row, its lint in the NFR-12 row, and its tools in §8.3 |
