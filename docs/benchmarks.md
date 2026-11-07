# Benchmarks

Measured on 7 November 2026 for WP 6.4.

These runs compare the strategies on one laptop. They are not a production capacity claim.

## Setup

| | |
| --- | --- |
| Machine | Intel Core i5-1135G7 (4 cores, 8 threads), 8 GB of RAM |
| OS | Windows 11 Home |
| Database | PostgreSQL 16.15 in Docker Desktop |
| API | One Node.js 26 process; a pool of 20 connections; `LOG_LEVEL=warn` |
| Payment mock | Default faults: 100–800 ms of latency, 5% declines, 2% lost answers |
| Load | k6 2.3.0, with 1,000 virtual users (one per seeded fan) |
| On the same machine | k6, the API, the payment mock, the sweeper and Postgres |

**How each run was taken:**
1. The stadium was reset (`npm run reset`).
2. The API was restarted with the strategy under test (`BOOKING_STRATEGY`), with the same `JWT_SECRET` the tokens were signed with.
3. The scenario ran.
4. After a sellout, `npm run audit` ran.

CPU time was read twice for each run:
- **The API:** from the process.
- **Postgres:** from its container's cgroup.

The final runs below are on the code as merged.

## Hot seat

`loadtest/hot-seat.js`: 1,000 virtual users send 10,000 hold requests for seat 42. Each sends its next request as soon as the last one answers.

| Strategy | Winners | p95 (ms) | Median (ms) | Requests/s | Retries or aborts | API CPU per request | Postgres CPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| naive (dev route), `RACE_DELAY_MS=0` | 1 | 445 | 360 | 2,346 | none: it waits on no lock | 0.51 ms | 2.7 s |
| naive (dev route), `RACE_DELAY_MS=50` | **114** | 409 | 369 | 2,344 | none | 0.52 ms | 3.1 s |
| `lock` | 1 | 1,481 | 1,389 | 684 | 0 `SEAT_BUSY` | 1.26 ms | 13.0 s |
| `cas` | 1 | 1,454 | 1,369 | 712 | 0 `SEAT_BUSY` | 1.45 ms | 26.0 s |
| `serializable` | 1 | 1,190 | 1,116 | 866 | 0 retries, 0 `SEAT_BUSY` | 1.23 ms | 12.4 s |

- **Every strategy gives exactly one winner.** No request failed: no `5xx`, no timeout.
- **The naive route oversells whenever its race window opens.** With `RACE_DELAY_MS=50` it sold seat 42 to 114 fans. At `0` it sold once in this run, and 298 times in WP 3.8's run on the same laptop. Whether its requests overlap depends on timing, which is exactly why the bug survives testing.
- **The naive route is fast because it does almost nothing:** no transaction, no lock, two short queries.
- **`serializable` is the fastest correct strategy here.** Its read takes no row lock, so the 9,999 losing requests see the seat taken without queueing on seat 42's lock. Only the winner writes, so nothing conflicts and nothing retries.
- **`cas` costs Postgres twice the CPU of `lock`.** Its single `UPDATE` takes the row lock and re-checks the row on every request, even when the seat is long gone.
- **`lock` never waited long enough to get `SEAT_BUSY`.** ADR 3's ascending lock order holds up under load.

## Sellout

`loadtest/sellout.js`: 1,000 virtual users run 10,000 hold-then-checkout journeys over the 2,000 seats, 70% aimed at the Lateral stands. That comes to about 29,550 requests per run.

| Strategy | Seats sold | Orders paid | Requests/s | Hold p95 (ms) | Checkout p95 (ms) | Retries or aborts | API CPU per request | Postgres CPU | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lock` | 1,959 | 1,145 | 653 | 1,521 | 8,429 | 0 `SEAT_BUSY` | 1.51 ms | 60.5 s | Pass |
| `cas` | 1,959 | 1,152 | 582 | 1,490 | 9,111 | 0 `SEAT_BUSY` | 1.72 ms | 95.0 s | Pass |
| `serializable` | 1,952 | 1,200 | 640 | 1,392 | 8,248 | 618 retries, 2 `SEAT_BUSY` | 1.54 ms | 61.0 s | Pass |

- **The audit passed after every run.** No seat was sold twice, no order was charged twice, the money charged matched paid orders, and no hold was stale. Each run took ₹68.7 to ₹68.9 lakh.
- **No request failed in any run.**
- **`serializable` retried 618 times** where overlapping multi-seat holds conflicted. Twice it ran out of its 3 retries and answered `409 SEAT_BUSY`, as its contract allows. `lock` and `cas` never got `SEAT_BUSY`.
- **`cas` again used the most Postgres CPU,** and was the slowest here.
- **A checkout's p95 of 8 to 9 seconds is mostly waiting.** A checkout makes about six trips to the database, each waiting its turn on a saturated API, plus the provider's own 100–800 ms. Holds take about 1.4 s for the same reason.

## Where the time goes

**The limit is the API's single Node.js thread.** In every run the API process used about as much CPU time as the run's wall time, while Postgres averaged one to two of the eight threads:

| Run | Wall | API CPU | Postgres CPU |
| --- | --- | --- | --- |
| hot seat, `lock` | 15.4 s | 12.6 s | 13.0 s |
| sellout, `lock` | 46.1 s | 44.7 s | 60.5 s |

**What follows:**
- **More database connections wouldn't help,** and neither would a faster database.
- **Latency equals the number of virtual users divided by throughput,** because every virtual user sends its next request the moment the last one answers: about 1,000 / 684 per second, or roughly 1.5 s, for `lock`.
- **The next lever is more API processes.** The API keeps no state in memory (NFR-7), so several can run side by side.

**A CPU profile of the API during a hot-seat run (`node --cpu-prof`)** showed where its thread spent its busy time:

| Share | What |
| --- | --- |
| 11.4% | `crypto.createPublicKey`, called by `jsonwebtoken` on every request (fixed, below) |
| 13% | writing to sockets: HTTP responses and Postgres messages |
| 7% | `pg` and `pg-protocol`: encoding queries, parsing results |
| 4% | `pino-http`'s per-request child logger, which redacts its bindings even when nothing is logged |
| 3% | the HMAC of the token's signature itself |
| the rest | spread thinly: Express, routing, Zod, error objects, garbage collection |

## Tuning

| Change | Evidence | Result |
| --- | --- | --- |
| **Kept: sign and verify JWTs with a key object built once** | Given the secret as a string, `jsonwebtoken` first tries to read it as a public key, which throws, on every request. That was 11.4% of the API's busy time. Hot-seat `lock` runs alternated between the old and new code to cancel out the laptop's drift. | About **10% less API CPU per request** (16.5 s against 14.8 s for 10,000 requests, averaged over 3 runs each), and about 9% more requests per second. A second profile no longer shows `createPublicKey`. |
| **Kept: `random_page_cost = 1.1` on the API's connections** | At Postgres's default of 4, which assumes spinning disks, the planner read the whole seats table and sorted it for the seat map. Forced onto the `(event_id, section, row_label, seat_no)` index, the same query was 3 to 4 times faster. | **The seat-map query takes 0.6–0.7 ms instead of 2.3–2.8 ms**, over four alternating trials, from the index with no sort. Over HTTP, seat-map throughput is unchanged (200 to 230 requests/s either way, over two alternating rounds): turning 2,000 seats into roughly 200 KB of JSON costs far more than the query. The gain is Postgres CPU, on the one tier that can't be scaled by adding servers. |
| **Tried and reverted: `BEGIN` and both `SET LOCAL`s in one round trip** | A rejected hold would make 4 trips to Postgres instead of 6. | **No measurable change** in API CPU per request (1.33 ms against 1.34 ms), so the round trips weren't the cost. Reverted to keep the code as it was. |

**Run-to-run variance is large on a laptop.** Across the 12 hot-seat `lock` runs of this session, on four versions of the code, throughput ranged from 469 to 689 requests/s as the machine heated up. Compare strategies within one batch, as the tables above do, and repeat a run before trusting a difference under about 20%.

## Seat-map polling (WP 7.3)

WP 6.4 found that one API process served the full seat map (`GET /events/:id/seats`) only 200 to 230 times a second. Each answer is 2,000 seats, about 185 KB of JSON. The web page refreshes the map every 2 to 3 seconds (FR-WEB-4), so 1,000 fans ask about 400 times a second.

**The fix: poll only what changes.**
- **The page loads the full map once.** Seat names and prices never change, so they're never sent again.
- **Then it polls `GET /events/:id/seats/states` (FR-SEAT-5),** which lists only the ids of held and sold seats: 23 bytes on an empty stadium, 8.7 KB with 1,950 seats sold.
- **Postgres writes that answer's JSON itself,** in one row the API passes straight on. The first version parsed one row per taken seat and serialised them again, and capped out at 470 requests a second near a sellout.

`loadtest/seat-poll.js`, on the same laptop, with 1,950 of the 2,000 seats sold, the largest answer. Each fan loads the full map once, arriving over the first 10 seconds, then polls every 2 to 3 seconds for 60 seconds:

| Run | Requests/s | Poll p95 | Failed | Under 500 ms? |
| --- | --- | --- | --- | --- |
| 1,000 fans polling the full map | 185 | 4.3 s | 0 | No |
| 1,000 fans polling the states, one row per seat | 345 | 1.02 s | 0 | No |
| 1,000 fans polling the states, JSON from Postgres | 373 | **10.8 ms** | 0 | Yes |

With no pauses, 50 virtual users sending requests back to back measure the most one process can serve:

| Endpoint | Requests/s | p95 |
| --- | --- | --- |
| Full map | 197 | 360 ms |
| States, one row per seat | 469 | 136 ms |
| States, JSON from Postgres | **1,804** | 39 ms |

**What follows:**
- **The polls of 1,000 fans now take about a fifth of one API process,** where the full map needed twice what it could give.
- **No cache was needed.** Every answer is current, every API process stays stateless (NFR-7), and FR-SEAT-1's `no-store` holds.
- **The cost of a poll still grows with the seats taken,** since sold seats are listed; 1,950 sold is close to the worst case.

## Query plans

`EXPLAIN (ANALYZE, BUFFERS)` ran against the stadium a `lock` sellout left behind: 2,000 seats (1,954 sold), 1,166 orders, 1,954 tickets and 1,215 idempotency keys, after `ANALYZE`.

| Query | Plan | Execution |
| --- | --- | --- |
| Hold, `lock` and `serializable`: `seats WHERE event_id = 1 AND id = ANY(…) ORDER BY id FOR UPDATE` | Bitmap index scan on `seats_pkey`, then lock rows | under 1 ms |
| Hold, `cas`: the conditional `UPDATE … WHERE id = ANY(…)` | Bitmap index scan on `seats_pkey` | 0.09 ms |
| Seat map: `seats WHERE event_id = 1 ORDER BY section, row_label, seat_no` | At the default cost settings: a sequential scan, then a sort. With `random_page_cost = 1.1`: an index scan on `seats_event_id_section_row_label_seat_no_key`, no sort | 2.3–2.8 ms, now 0.6–0.7 ms |
| Sweeper, lapsed seats: `status = 'held' AND held_until < now()` | Index scan on `seats_held_until_idx` (partial) | 0.05 ms |
| Release: `seats WHERE hold_id = $1 FOR UPDATE` | Index scan on `seats_hold_id_idx` (partial) | under 0.4 ms |
| Idempotency: a fan's key | Index scan on `idempotency_keys_pkey` | 0.01 ms |
| Sweeper, keys older than 24 hours | Index scan on `idempotency_keys_locked_at` | 0.01 ms |
| `GET /orders/:id`: an order's tickets and their seats | Bitmap index scan on `tickets_order_id_idx`, then `seats_pkey` per ticket | 0.06 ms |

`api/test/seats.test.ts` checks that the seat-map query uses the index and doesn't sort. It first rewrites half the seats, so that, as after real use, the table on disk is no longer in index order.
