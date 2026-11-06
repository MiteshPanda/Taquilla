import type { PoolClient } from 'pg';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { describeSeats } from '../holds/shared.js';
import { ORDER_COLUMNS, toOrder } from './order.js';
import type { Order, OrderRow } from './order.js';
import { paymentKey } from './payment-client.js';

// FR-PAY-5: long enough for the provider call and its retries (at most about 13 seconds), with
// room for a fan who comes back to resume a payment the provider never answered.
export const RESERVE_MINUTES = 10;

export interface ReserveRequest {
  holdId: string;
  userId: number;
  // The fan's Idempotency-Key for this payment attempt, from which the provider key is built.
  clientKey: string;
}

// What checkout does next: charge the provider under paymentKey, or nothing, because the order
// is already paid (FR-PAY-6). resumed means this key was already paying, so the Charge step
// finds the original charge instead of making a new one (FR-PAY-11).
export type ReserveOutcome =
  | { kind: 'charge'; order: Order; paymentKey: string; resumed: boolean }
  | { kind: 'paid'; order: Order };

interface SeatState {
  id: number;
  ours: boolean;
}

// Checkout step A (FR-PAY-3): one short transaction that decides whether the fan may be charged,
// and holds no lock once it returns.
export function reserve(
  db: Pick<Database, 'withTransaction'>,
  { holdId, userId, clientKey }: ReserveRequest,
): Promise<ReserveOutcome> {
  return db.withTransaction(async (client) => {
    // Someone else's hold answers like one that doesn't exist (FR-AUTH-3).
    const { rows: holds } = await client.query<{ seat_ids: number[]; amount_paise: number }>(
      'SELECT seat_ids, amount_paise FROM holds WHERE id = $1 AND user_id = $2',
      [holdId, userId],
    );
    const hold = holds[0];
    if (!hold) throw new AppError(404, 'NOT_FOUND', 'This hold does not exist.');

    // Seats first, in ascending id order, as the hold strategies and release lock them, so none
    // of them can deadlock with checkout (ADR 3); the order comes after. Every seat the hold was
    // made with is locked, including any another fan has since taken. A lapsed seat belongs to
    // nobody (lazy expiry), so it no longer counts as this hold's. A released hold has freed its
    // seats, so it fails the same check.
    const { rows: seats } = await client.query<SeatState>(
      `SELECT id, (status = 'held' AND hold_id = $1 AND held_until >= now()) AS ours
         FROM seats
        WHERE id = ANY($2::int[])
        ORDER BY id
          FOR UPDATE`,
      [holdId, hold.seat_ids],
    );

    const order = await lockOrder(client, holdId, userId, hold.amount_paise);
    const key = paymentKey(order.id, clientKey);

    switch (order.status) {
      case 'paid':
        return { kind: 'paid', order };

      case 'refunded':
        throw new AppError(
          409,
          'SEAT_LOST_REFUNDED',
          'Your seats were lost while you were paying, so the charge was refunded. Pick your seats again.',
        );

      case 'paying':
        if (order.paymentKey !== key) {
          throw new AppError(
            409,
            'PAYMENT_IN_PROGRESS',
            'This order is already being paid in another tab or window. Wait for it to finish.',
          );
        }
        // The same attempt again, after a crash or a lost answer. The charge may already exist,
        // so this goes on to the Charge step even if seats were lost: Confirm refunds then.
        await extendSeats(client, holdId, ownedIds(seats));
        return { kind: 'charge', order, paymentKey: key, resumed: true };

      case 'pending': {
        const lost = seats.filter((seat) => !seat.ours).map((seat) => seat.id);
        if (lost.length > 0) {
          const many = lost.length > 1;
          throw new AppError(
            409,
            'HOLD_EXPIRED',
            `Your hold has expired: ${describeSeats(lost).toLowerCase()} ${many ? 'are' : 'is'} no longer yours. Pick your seats again.`,
            { seatIds: lost },
          );
        }
        await extendSeats(client, holdId, ownedIds(seats));
        const paying = await startPaying(client, order.id, key);
        return { kind: 'charge', order: paying, paymentKey: key, resumed: false };
      }
    }
  });
}

function ownedIds(seats: SeatState[]): number[] {
  return seats.filter((seat) => seat.ours).map((seat) => seat.id);
}

// The hold's one order (FR-PAY-2): created on the first checkout, found on every later one,
// and locked either way. UNIQUE (hold_id) keeps it to one even if two inserts race.
async function lockOrder(
  client: PoolClient,
  holdId: string,
  userId: number,
  amountPaise: number,
): Promise<Order> {
  await client.query(
    `INSERT INTO orders (hold_id, user_id, amount_paise) VALUES ($1, $2, $3)
     ON CONFLICT (hold_id) DO NOTHING`,
    [holdId, userId, amountPaise],
  );
  const { rows } = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE hold_id = $1 FOR UPDATE`,
    [holdId],
  );
  if (!rows[0]) throw new Error(`Hold ${holdId} has no order after inserting one.`);
  return toOrder(rows[0]);
}

// At least RESERVE_MINUTES from now (FR-PAY-5). GREATEST never shortens a longer hold, and
// repeated attempts don't stack up extra time.
async function extendSeats(client: PoolClient, holdId: string, seatIds: number[]): Promise<void> {
  await client.query(
    `UPDATE seats
        SET held_until = GREATEST(held_until, now() + make_interval(mins => $3))
      WHERE id = ANY($2::int[]) AND hold_id = $1 AND status = 'held'`,
    [holdId, seatIds, RESERVE_MINUTES],
  );
}

async function startPaying(client: PoolClient, orderId: string, key: string): Promise<Order> {
  const { rows } = await client.query<OrderRow>(
    `UPDATE orders SET status = 'paying', payment_key = $2 WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
    [orderId, key],
  );
  if (!rows[0]) throw new Error(`Order ${orderId} vanished while locked.`);
  return toOrder(rows[0]);
}
