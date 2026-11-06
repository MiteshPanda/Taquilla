import type { PoolClient } from 'pg';
import type { Database } from '../db.js';
import { ORDER_COLUMNS, toOrder } from './order.js';
import type { Order, OrderRow } from './order.js';

export interface Ticket {
  id: number;
  seatId: number;
}

export interface PaymentRef {
  order: Order;
  paymentKey: string;
}

// What Confirm found once the charge had succeeded: the order is paid, or some seats were lost
// while the provider was working, so the charge must be refunded (FR-PAY-9).
export type ConfirmOutcome =
  { kind: 'paid'; order: Order; tickets: Ticket[] } | { kind: 'seats_lost'; lost: number[] };

type Db = Pick<Database, 'withTransaction'>;

// Checkout step C (FR-PAY-8): in one transaction, every seat sold, one valid ticket per seat,
// the order paid and the hold converted. All of it or none of it.
export function confirm(db: Db, { order, paymentKey }: PaymentRef): Promise<ConfirmOutcome> {
  return db.withTransaction(async (client) => {
    const { rows: holds } = await client.query<{ seat_ids: number[] }>(
      'SELECT seat_ids FROM holds WHERE id = $1',
      [order.holdId],
    );
    const seatIds = holds[0]?.seat_ids ?? [];

    // Seats in ascending id order, then the hold, then the order, as Reserve and release lock
    // them (ADR 3). A lapsed seat belongs to nobody, as everywhere else (lazy expiry).
    const { rows: seats } = await client.query<{ id: number; ours: boolean }>(
      `SELECT id, (status = 'held' AND hold_id = $1 AND held_until >= now()) AS ours
         FROM seats
        WHERE id = ANY($2::int[])
        ORDER BY id
          FOR UPDATE`,
      [order.holdId, seatIds],
    );
    await client.query('SELECT 1 FROM holds WHERE id = $1 FOR UPDATE', [order.holdId]);
    // A paid order never gets here: a retry of one stops at Reserve, which returns it.
    assertStillPaying(await lockOrder(client, order.id), paymentKey);

    const lost = seats.filter((seat) => !seat.ours).map((seat) => seat.id);
    if (lost.length > 0) return { kind: 'seats_lost', lost };

    await client.query(
      `UPDATE seats SET status = 'sold', hold_id = NULL, held_until = NULL
        WHERE id = ANY($1::int[])`,
      [seatIds],
    );
    // The partial unique index on tickets (DR-3) would refuse a second valid ticket for a seat,
    // even if everything above were wrong.
    const { rows: tickets } = await client.query<{ id: number; seat_id: number }>(
      `INSERT INTO tickets (order_id, seat_id)
       SELECT $1, seat_id FROM unnest($2::int[]) AS seat_id ORDER BY seat_id
       RETURNING id, seat_id`,
      [order.id, seatIds],
    );
    const { rows: paid } = await client.query<OrderRow>(
      `UPDATE orders SET status = 'paid' WHERE id = $1 RETURNING ${ORDER_COLUMNS}`,
      [order.id],
    );
    await client.query(`UPDATE holds SET status = 'converted' WHERE id = $1`, [order.holdId]);

    return {
      kind: 'paid',
      order: toOrder(paid[0] as OrderRow),
      tickets: tickets
        .map((ticket) => ({ id: ticket.id, seatId: ticket.seat_id }))
        .sort((a, b) => a.seatId - b.seatId),
    };
  });
}

// A declined charge leaves nothing to undo except the order, which can be paid again with a new
// key (FR-PAY-10). The seats keep the time Reserve gave them.
export function markDeclined(db: Db, { order, paymentKey }: PaymentRef): Promise<void> {
  return db.withTransaction(async (client) => {
    await client.query(
      `UPDATE orders SET status = 'pending', payment_key = NULL
        WHERE id = $1 AND status = 'paying' AND payment_key = $2`,
      [order.id, paymentKey],
    );
  });
}

// After a refund (FR-PAY-9): the order is refunded for good, and any seats the hold still has
// are freed at once, since a refunded order can never pay for them.
export function markRefunded(db: Db, { order, paymentKey }: PaymentRef): Promise<void> {
  return db.withTransaction(async (client) => {
    await client.query('SELECT 1 FROM seats WHERE hold_id = $1 ORDER BY id FOR UPDATE', [
      order.holdId,
    ]);
    await client.query('SELECT 1 FROM holds WHERE id = $1 FOR UPDATE', [order.holdId]);
    const current = await lockOrder(client, order.id);
    if (current.status === 'refunded') return;
    assertStillPaying(current, paymentKey);

    await client.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
        WHERE hold_id = $1 AND status = 'held'`,
      [order.holdId],
    );
    await client.query(`UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active'`, [
      order.holdId,
    ]);
    await client.query(`UPDATE orders SET status = 'refunded' WHERE id = $1`, [order.id]);
  });
}

async function lockOrder(client: PoolClient, orderId: string): Promise<Order> {
  const { rows } = await client.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId],
  );
  if (!rows[0]) throw new Error(`Order ${orderId} does not exist.`);
  return toOrder(rows[0]);
}

// Only the request holding this payment's key reaches Charge, so no one else can have moved the
// order on. If someone did, stop rather than sell or refund on a stale view.
function assertStillPaying(order: Order, paymentKey: string): void {
  if (order.status !== 'paying' || order.paymentKey !== paymentKey) {
    throw new Error(
      `Order ${order.id} is ${order.status} under ${order.paymentKey ?? 'no key'}, not paying under ${paymentKey}.`,
    );
  }
}
