# I tried to oversell a stadium

*How 1,000 simulated fans, one seat and a double-clicked Pay button taught me where booking systems break, and how Postgres stops it.*

Every ticketing site has the same nightmare. Two fans click the same seat in the same instant, both see "available", and the stadium ends up with two tickets for one chair. Or a nervous fan double-clicks **Pay** and is charged twice. Most booking demos never meet that moment, because they're tested one click at a time.

So I built [Taquilla](https://github.com/MiteshPanda/Taquilla), a booking engine for a fictional 2,000-seat stadium. I set out to break it on purpose, then fix it, then prove the fix under load with an audit anyone can rerun. You can [book a seat on the live demo](https://taquilla-omega.vercel.app). Please don't load-test it; it runs on free tiers.

## Step one: write the bug

The obvious way to sell a seat is two queries: check that it's free, then mark it sold.

```ts
const { rows } = await pool.query('SELECT status FROM seats WHERE id = $1', [seatId]);
if (rows[0].status !== 'available') throw new ConflictError('Seat taken');
await pool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [seatId]);
```

It reads fine, and it passes a unit test. Then I sent 100 parallel buyers at seat 42.

On my laptop it sold that one seat **up to 100 times**, with a median of 85. Every request read `available` before any of them wrote `sold`. Then the same test ran on GitHub's faster Linux runner, and it sold the seat **once**: each buy finished before the next one arrived.

That was the most useful thing I learned. A race condition can pass every test on a fast machine and still oversell under real load. To make it visible every time, the naive route has a `RACE_DELAY_MS` setting that widens the gap between check and write. At 50 ms it oversold 83 to 100 times, everywhere. That test is marked `it.fails` in CI, so it documents the bug without breaking the build, and turns CI red if the bug ever stops reproducing.

## Step two: decide while holding the lock

The fix is to make the check and the write one atomic decision. Postgres can do that if you ask it to lock the row while you read it:

```sql
SELECT id, price_paise,
       status = 'available' OR (status = 'held' AND held_until < now()) AS is_free
  FROM seats
 WHERE event_id = $1 AND id = ANY($2::int[])
 ORDER BY id
   FOR UPDATE;
```

`FOR UPDATE` makes every other contender wait on that row until the first transaction commits. When the next one gets its turn, it re-reads the row, sees `held`, and gets a clean `409`.

Two details matter:
- **`ORDER BY id`.** A fan holding seats 41 and 42 and another holding 42 and 41 would deadlock if each locked in its own order. With one global order, they queue instead.
- **`held_until < now()`.** A hold that has lapsed counts as free in the query itself, by the database's clock. Correctness never depends on a background job having tidied up first.

I built three strategies behind one setting:
- **`lock`:** the query above.
- **`cas`:** a single conditional `UPDATE` that only matches free seats.
- **`serializable`:** the naive code inside a `SERIALIZABLE` transaction, retried on conflict.

All three pass the same tests: 100 parallel holds on one seat give exactly one winner and 99 `409`s.

## Step three: make the bad state unstorable

Locks are code, and code changes. So the last line of defence lives in the schema:

```sql
CREATE UNIQUE INDEX one_valid_ticket_per_seat
    ON tickets (seat_id) WHERE status = 'valid';
```

Even if a future change skips the lock, Postgres refuses to store a second valid ticket for the same seat. I'd rather get an error than a double sale.

## The other half: charging exactly once

Holding a seat is half the problem. The scarier half is money. A fan double-clicks **Pay**, or their connection drops and the page retries. Did the first attempt charge them?

The answer is an **idempotency key**. The page makes one random key when the payment step opens, and sends it with every attempt.
- **Retries keep the key:** after a timeout, a dropped connection or a busy server, the retry uses the same key.
- **A decline ends the attempt:** only then does the next try get a new key.
- **On the server:** the first request with a key claims it, in a single `INSERT` that only one request can win. A repeat gets the saved answer back, marked `Idempotent-Replayed: true`, without running again. A repeat that arrives while the first is still running gets `409 REQUEST_IN_PROGRESS`, and the page retries with the same key until the answer is saved.

Checkout itself is three short steps, and no lock is held across the network call:
1. **Reserve:** lock the seats, check they're still yours, extend the hold.
2. **Charge:** call the payment provider, reusing one provider key on every retry.
3. **Confirm:** in one transaction, sell the seats, issue the tickets and mark the order paid.

A slow provider can't freeze a queue of fans behind a row lock. If the seats were somehow lost between charging and confirming, the charge is refunded and the fan is told which seats went.

The payment provider is a mock I wrote to be unkind. It adds 100–800 ms of latency, declines 5% of charges, and on 2% of first attempts it records the charge, then drops the connection without answering. That last one is the case that double-charges people in real systems, and the retry has to discover that the charge already happened.

## Proving it under load

Unit tests show the logic. Load shows the truth. I used k6 for 1,000 virtual users on one laptop, a 4-core i5 with 8 GB of RAM, with Postgres in Docker:

| Scenario | What happened |
| --- | --- |
| **Hot seat:** 10,000 holds for seat 42 | Exactly **1** winner under every strategy. The naive route sold it to **114** fans. |
| **Sellout:** 10,000 hold-then-pay journeys, about 29,550 requests | **0** oversold seats and **0** duplicate charges, under every strategy |
| **Double-click:** 1,000 fans each sending the same checkout twice at once | 1,040 double-clicked payments, **0** pairs with different answers, and 995 orders paid with 995 charges, none twice |

The verdict on every run comes from `npm run audit`. It's a set of SQL queries that check the four rules directly in the database:
- a seat has at most one valid ticket;
- an order has at most one successful charge;
- money charged equals the total of paid orders;
- no seat stays held more than 30 seconds past its expiry.

It passed after every run.

The numbers had surprises too:
- **`serializable` was the fastest correct strategy in the hot seat,** at 866 requests a second against 684 for `lock`. Its reads take no row lock, so losers don't queue. It paid for that in the sellout, with 618 retries.
- **`cas` cost Postgres twice the CPU of `lock`.**
- **The real bottleneck was neither.** It was the API's single Node.js thread, which is why the API is stateless: the next lever is simply more processes.

## The parts nobody blogs about

Getting the demo live taught me as much as the locking did. Three deploys failed for three different reasons:
- **The start command:** Render runs a Docker start command without a shell, so my quoted `sh -c "migrate && seed && serve"` never ran. Now it's a three-line script.
- **The database connection:** Neon's connection pooler refuses startup parameters, including a Postgres tuning setting the API sends on connect. The direct connection accepts it, and the migrations need a direct connection anyway, for their session locks.
- **The `api/` folder:** Vercel treats any top-level folder called `api/` as serverless functions, and my API lives in `api/`. Vercel cheerfully tried to deploy every source file as its own function. The fix was to root the Vercel project at the web page's folder.

None of these are interesting bugs. All of them are the kind of thing that eats an evening.

## What I'd take away

1. **Make the database decide.** A check in application code and a write a moment later is a race, whatever language it's in. Lock the row, or make the write conditional, or let `SERIALIZABLE` catch the conflict.
2. **Make the bad state impossible to store.** A partial unique index is one line, and it outlives every refactor.
3. **Give every payment attempt a key, and keep it across retries.** "Did the first one go through?" should never be a question the client has to answer.
4. **Prove it with the data, not the logs.** An audit that queries the final state can't be fooled by a test that happened to run on a fast machine.

The code, the load tests and the audit are all on [GitHub](https://github.com/MiteshPanda/Taquilla), and the README walks you through reproducing every number above on your own machine. If you find a way to oversell my stadium, I'd genuinely love to hear about it.
