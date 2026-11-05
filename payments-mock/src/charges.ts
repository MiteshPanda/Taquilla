import type { Pool } from 'pg';

export type ChargeStatus = 'succeeded' | 'declined' | 'refunded';

// A charge as the provider returns it.
export interface Charge {
  id: string;
  key: string;
  orderId: string;
  amountPaise: number;
  status: ChargeStatus;
  createdAt: string;
  refundedAt: string | null;
}

export interface NewCharge {
  key: string;
  orderId: string;
  amountPaise: number;
  status: 'succeeded' | 'declined';
}

interface ChargeRow {
  id: string;
  key: string;
  order_id: string;
  amount_paise: number;
  status: ChargeStatus;
  created_at: Date;
  refunded_at: Date | null;
}

export type Queryable = Pick<Pool, 'query'>;

const COLUMNS = 'id, key, order_id, amount_paise, status, created_at, refunded_at';

function toCharge(row: ChargeRow): Charge {
  return {
    id: row.id,
    key: row.key,
    orderId: row.order_id,
    amountPaise: row.amount_paise,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    refundedAt: row.refunded_at?.toISOString() ?? null,
  };
}

export async function findCharge(db: Queryable, key: string): Promise<Charge | undefined> {
  const { rows } = await db.query<ChargeRow>(`SELECT ${COLUMNS} FROM charges WHERE key = $1`, [
    key,
  ]);
  return rows[0] && toCharge(rows[0]);
}

// Records the charge, or returns undefined if the key already has one. Two first attempts
// racing with one key both get here: Postgres makes the second wait for the first to commit,
// then skips it, so a key never has two charges.
export async function insertCharge(
  db: Queryable,
  { key, orderId, amountPaise, status }: NewCharge,
): Promise<Charge | undefined> {
  const { rows } = await db.query<ChargeRow>(
    `INSERT INTO charges (key, order_id, amount_paise, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [key, orderId, amountPaise, status],
  );
  return rows[0] && toCharge(rows[0]);
}

// Refunds a succeeded charge, or returns undefined if the key has no succeeded charge. A second
// refund waits for the first one's row lock, then finds the charge already refunded and skips it.
export async function refundCharge(db: Queryable, key: string): Promise<Charge | undefined> {
  const { rows } = await db.query<ChargeRow>(
    `UPDATE charges SET status = 'refunded', refunded_at = now()
     WHERE key = $1 AND status = 'succeeded'
     RETURNING ${COLUMNS}`,
    [key],
  );
  return rows[0] && toCharge(rows[0]);
}
