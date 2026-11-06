// An order as checkout's steps pass it along. One per hold (FR-PAY-2, DR-4).
export type OrderStatus = 'pending' | 'paying' | 'paid' | 'refunded';

export interface Order {
  id: string;
  holdId: string;
  userId: number;
  amountPaise: number;
  status: OrderStatus;
  paymentKey: string | null;
  createdAt: Date;
}

export interface OrderRow {
  id: string;
  hold_id: string;
  user_id: number;
  amount_paise: number;
  status: OrderStatus;
  payment_key: string | null;
  created_at: Date;
}

export const ORDER_COLUMNS = 'id, hold_id, user_id, amount_paise, status, payment_key, created_at';

export function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    holdId: row.hold_id,
    userId: row.user_id,
    amountPaise: row.amount_paise,
    status: row.status,
    paymentKey: row.payment_key,
    createdAt: row.created_at,
  };
}
