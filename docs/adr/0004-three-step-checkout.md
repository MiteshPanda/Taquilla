# 4. Check out in three steps around the payment call

- **Status:** Accepted
- **Date:** 6 Nov 2026

## Context

Checkout has to turn a hold into sold seats and take the fan's money exactly once. Two rules pull against each other:

1. **The seats must not change hands mid-payment.** If they can, a fan might pay for a seat someone else then gets.
2. **The payment provider is slow and unreliable.** A call can take seconds, fail, or charge the card and then lose its answer. The mock provider does all three on purpose (FR-MOCK-5).

The obvious design is one transaction that locks the seats, calls the provider and then marks the seats sold. It breaks the second rule:
- **Locks held across the call:** every fan who wants one of those seats queues behind the provider's latency.
- **A pinned connection:** the transaction holds a pool connection for the whole call.
- **An unknown charge:** if the provider times out, the transaction rolls back while the charge may already exist.

## Decision

Checkout is three short steps, and no lock or transaction is open during the provider call (FR-PAY-3):

1. **Reserve: one transaction.**
   - **Locks:** the hold's seats, in id order (ADR 3), then the hold's one order (FR-PAY-2).
   - **Check:** every seat must still be the fan's. If one isn't, the answer is `409 HOLD_EXPIRED` and nothing is charged (FR-PAY-4).
   - **Writes:** it extends the seats to at least 10 minutes from now (FR-PAY-5), and sets the order `paying` under the provider key `pay:{orderId}:{clientKey}`.
2. **Charge: no transaction.**
   - **The call:** the provider is called with that key, a 3-second timeout and up to 3 retries with the same key (FR-PAY-7).
   - **The provider's role:** it is idempotent by key, so every retry, and every later request with the same fan key, gets back the one charge the first attempt made.
3. **Confirm: one transaction.**
   - **Locks:** seats, hold and order, in the same order.
   - **If the seats are still the fan's:** they are sold, with one ticket each, the order `paid` and the hold `converted`, all at once (FR-PAY-8).
   - **If any was lost:** the charge is refunded and the order `refunded` (FR-PAY-9).

What makes the steps safe to repeat:

- **The order is a state machine:** `pending`, `paying`, then `paid` or `refunded`. It records how far a payment got, so any request can tell where to pick up:
  - **`paid`:** returned without a charge.
  - **`paying` under another key:** `409 PAYMENT_IN_PROGRESS`.
  - **`paying` under the same key:** it resumes at Charge (FR-PAY-6, FR-PAY-11).
- **Two layers of keys:**
  - **The fan's `Idempotency-Key`** replays a finished answer, and refuses a duplicate while the first is running (FR-IDEM-3, FR-IDEM-5).
  - **The provider key,** derived from the order and the fan's key, makes every retry of one attempt the same charge.
  - **A new attempt after a decline** needs a new fan key, so it gets a new provider key and a fresh charge.
- **Failures leave the order where a retry can finish it:**
  - **A timeout or outage** answers `503` and leaves the order `paying` (FR-PAY-12).
  - **A crash** leaves the fan's key in progress; a new request takes it over after 60 seconds (FR-IDEM-7).
  - **Either way,** the retry resumes with the same provider key, so it never charges twice (NFR-6).

## Consequences

- **A slow provider holds up only the fan who is paying.** Locks last only for Reserve's and Confirm's few statements. `checkout-route.test.ts` pauses the provider mid-charge and locks the seats, the hold and the order from another connection with `NOWAIT`.
- **Seats can be lost between Reserve and Confirm,** for example if a payment outlives its 10 minutes, so a fan can be charged and refunded. That is the price of not locking across the call. The refund is automatic, and an unrecorded refund still ends as `refunded`, never as a sale.
- **The 10-minute extension keeps the seats from lapsing mid-payment.** A fan who abandons a payment keeps the seats for up to 10 minutes.
- **An order stuck in `paying` under a key nobody retries blocks other keys** with `PAYMENT_IN_PROGRESS` until its seats lapse. A reconciler that settles such orders with the provider is on the roadmap.
- **The six acceptance cases in requirements.md §9.1** run against the real payment mock in `checkout.test.ts`. `checkout-recovery.test.ts` cuts the provider off in each way it can fail. Every case ends with at most one successful charge.

## Alternatives considered

- **One transaction around the provider call:** rejected, for the reasons in Context.
- **Charge first, then claim the seats:** rejected. Most failures would end in a refund, and the fan would see money taken for seats they may not get.
- **A background worker that charges from a queue (an outbox):** rejected for v1. It survives crashes without the fan retrying, but the fan would have to poll for the result, and it adds a worker and a queue. Fan-driven retries with the same key give the same guarantee here.
- **Distributed transactions (two-phase commit) with the provider:** rejected. Payment providers don't offer them, and a provider's idempotency keys already give the safety they would.
