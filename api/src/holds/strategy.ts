import type { BookingStrategy } from '../config.js';
import type { Database } from '../db.js';

export interface StrategyOptions {
  db: Pick<Database, 'pool' | 'withTransaction'>;
  holdSeconds: number;
}

export interface HoldRequest {
  userId: number;
  eventId: number;
  // 1 to 6 distinct seat ids. The route checks this before calling a strategy (FR-HOLD-1).
  seatIds: number[];
}

// What a successful hold returns, and what POST /events/:id/holds sends back (FR-HOLD-7).
export interface Hold {
  holdId: string;
  seatIds: number[];
  amountPaise: number;
  // Read back from Postgres, so expiry follows the database clock (DR-6).
  expiresAt: Date;
}

// One way of making a hold safe when many fans want the same seats (FR-HOLD-5). Every strategy
// must give the same answers; only how it handles contention differs.
//
// hold() either holds every requested seat or none of them (FR-HOLD-3), and then:
// - resolves with the Hold, the seats held until expiresAt;
// - throws AppError 404 NOT_FOUND if the event doesn't exist;
// - throws AppError 400 VALIDATION_FAILED if a seat doesn't belong to the event (FR-HOLD-2);
// - throws AppError 409 SEAT_TAKEN, listing the unavailable seats, if any seat is held or sold;
// - may let a Postgres error through (lock timeout, deadlock, serialization failure), which the
//   holds route maps to 409 SEAT_BUSY (requirements.md §6.4). It never answers with a 5xx for
//   contention alone (FR-HOLD-4).
export interface HoldStrategy {
  readonly name: BookingStrategy;
  hold(request: HoldRequest): Promise<Hold>;
}
