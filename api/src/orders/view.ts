import type { OrderStatus } from '../checkout/order.js';
import type { Database } from '../db.js';

// A ticket with its seat, named the way the seat map names seats.
export interface OrderTicket {
  id: number;
  seatId: number;
  section: string;
  row: string;
  number: number;
  pricePaise: number;
}

// How the API shows an order, from GET /orders/:id and from a paid checkout alike. Only a paid
// order has tickets.
export interface OrderView {
  orderId: string;
  holdId: string;
  status: OrderStatus;
  amountPaise: number;
  createdAt: Date;
  tickets: OrderTicket[];
}

export interface FindOrderRequest {
  orderId: string;
  userId: number;
}

// The fan's own order, or undefined for anyone else's, so callers answer both with the same 404
// (FR-AUTH-3).
export async function findOrder(
  db: Pick<Database, 'pool'>,
  { orderId, userId }: FindOrderRequest,
): Promise<OrderView | undefined> {
  const { rows: orders } = await db.pool.query<Omit<OrderView, 'tickets'>>(
    `SELECT id AS "orderId", hold_id AS "holdId", status, amount_paise AS "amountPaise",
            created_at AS "createdAt"
       FROM orders
      WHERE id = $1 AND user_id = $2`,
    [orderId, userId],
  );
  const order = orders[0];
  if (!order) return undefined;

  const { rows: tickets } = await db.pool.query<OrderTicket>(
    `SELECT t.id, t.seat_id AS "seatId", s.section, s.row_label AS "row", s.seat_no AS "number",
            s.price_paise AS "pricePaise"
       FROM tickets t
       JOIN seats s ON s.id = t.seat_id
      WHERE t.order_id = $1 AND t.status = 'valid'
      ORDER BY t.seat_id`,
    [orderId],
  );
  return { ...order, tickets };
}
