import { Client } from 'pg';
import { describeSeats } from '../api/src/holds/shared.js';
import { assertSchemaName, PAYMENTS_SCHEMA } from '../payments-mock/src/db.js';

// The four rules every run must leave true (requirements.md §3), each checked straight in SQL
// (FR-AUD-1). The audit only reads, so it is safe to point at any database.

export type RuleId = 'INV-1' | 'INV-2' | 'INV-3' | 'INV-4';

export interface CheckResult {
  id: RuleId;
  rule: string;
  passed: boolean;
  detail: string;
}

export interface AuditReport {
  checks: CheckResult[];
  passed: boolean;
}

export interface AuditOptions {
  connectionString: string;
  // The payment mock's schema; tests use a scratch one.
  paymentsSchema?: string;
}

// The seat-map rule allows the sweeper this long to free a lapsed seat (INV-4).
export const STALE_HOLD_SECONDS = 30;
// A failing check names at most this many offenders, so the table stays readable.
const EXAMPLES = 5;

type Query = Pick<Client, 'query'>;

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

export function formatRupees(paise: number): string {
  const rupees = Math.trunc(paise / 100).toLocaleString('en-IN');
  return `₹${rupees}.${String(Math.abs(paise % 100)).padStart(2, '0')}`;
}

function andMore(total: number): string {
  return total > EXAMPLES ? `, and ${total - EXAMPLES} more` : '';
}

// INV-1: no seat is sold twice.
async function oneTicketPerSeat(db: Query): Promise<CheckResult> {
  const rule = 'A seat has at most one valid ticket';
  const { rows } = await db.query<{ seat_id: number; tickets: number }>(
    `SELECT seat_id, count(*)::int AS tickets FROM tickets
      WHERE status = 'valid'
      GROUP BY seat_id HAVING count(*) > 1
      ORDER BY seat_id`,
  );
  if (rows.length > 0) {
    const shown = rows.slice(0, EXAMPLES);
    return {
      id: 'INV-1',
      rule,
      passed: false,
      detail: `${shown.map((row) => `seat ${row.seat_id} has ${row.tickets} valid tickets`).join('; ')}${andMore(rows.length)}`,
    };
  }
  const { rows: totals } = await db.query<{ tickets: number }>(
    `SELECT count(*)::int AS tickets FROM tickets WHERE status = 'valid'`,
  );
  return {
    id: 'INV-1',
    rule,
    passed: true,
    detail: `${count(totals[0]?.tickets ?? 0, 'valid ticket')}, no seat twice`,
  };
}

// INV-2: no order is charged twice.
async function oneChargePerOrder(db: Query, schema: string): Promise<CheckResult> {
  const rule = 'An order has at most one successful charge';
  const { rows } = await db.query<{ order_id: string; charges: number }>(
    `SELECT order_id, count(*)::int AS charges FROM ${schema}.charges
      WHERE status = 'succeeded'
      GROUP BY order_id HAVING count(*) > 1
      ORDER BY order_id`,
  );
  if (rows.length > 0) {
    const shown = rows.slice(0, EXAMPLES);
    return {
      id: 'INV-2',
      rule,
      passed: false,
      detail: `${shown.map((row) => `order ${row.order_id} has ${row.charges} successful charges`).join('; ')}${andMore(rows.length)}`,
    };
  }
  const { rows: totals } = await db.query<{ charges: number }>(
    `SELECT count(*)::int AS charges FROM ${schema}.charges WHERE status = 'succeeded'`,
  );
  return {
    id: 'INV-2',
    rule,
    passed: true,
    detail: `${count(totals[0]?.charges ?? 0, 'successful charge')}, none twice for one order`,
  };
}

// INV-3: money kept matches what was sold. Compared order by order, so a paid order with no
// charge can't hide behind a charge with no paid order of the same amount.
async function chargedEqualsPaid(db: Query, schema: string): Promise<CheckResult> {
  const rule = 'Money charged equals the total of paid orders';
  const { rows: totals } = await db.query<{ charged: string; paid: string; orders: number }>(
    `SELECT (SELECT coalesce(sum(amount_paise), 0)::bigint FROM ${schema}.charges
              WHERE status = 'succeeded') AS charged,
            (SELECT coalesce(sum(amount_paise), 0)::bigint FROM orders
              WHERE status = 'paid') AS paid,
            (SELECT count(*)::int FROM orders WHERE status = 'paid') AS orders`,
  );
  const charged = Number(totals[0]?.charged ?? 0);
  const paid = Number(totals[0]?.paid ?? 0);
  const orders = totals[0]?.orders ?? 0;

  const { rows: mismatched } = await db.query<{ order_id: string; charged: string; paid: string }>(
    `WITH charged AS (
       SELECT order_id, sum(amount_paise)::bigint AS charged FROM ${schema}.charges
        WHERE status = 'succeeded' GROUP BY order_id
     ), paid AS (
       SELECT id AS order_id, amount_paise::bigint AS paid FROM orders WHERE status = 'paid'
     )
     SELECT coalesce(charged.order_id, paid.order_id) AS order_id,
            coalesce(charged.charged, 0) AS charged, coalesce(paid.paid, 0) AS paid
       FROM charged FULL JOIN paid ON paid.order_id = charged.order_id
      WHERE coalesce(charged.charged, 0) <> coalesce(paid.paid, 0)
      ORDER BY 1`,
  );
  const totalsLine = `charged ${formatRupees(charged)}, paid ${formatRupees(paid)} across ${count(orders, 'paid order')}`;
  if (mismatched.length === 0 && charged === paid) {
    return { id: 'INV-3', rule, passed: true, detail: totalsLine };
  }
  const shown = mismatched
    .slice(0, EXAMPLES)
    .map(
      (row) =>
        `order ${row.order_id}: charged ${formatRupees(Number(row.charged))}, paid ${formatRupees(Number(row.paid))}`,
    );
  return {
    id: 'INV-3',
    rule,
    passed: false,
    detail: `${totalsLine}; ${shown.join('; ')}${andMore(mismatched.length)}`,
  };
}

// INV-4: expired holds don't linger. Every query already treats a lapsed hold as free; this checks
// that the sweeper also clears the rows within STALE_HOLD_SECONDS.
async function noStaleHolds(db: Query): Promise<CheckResult> {
  const rule = `No seat stays held ${STALE_HOLD_SECONDS} s past expiry`;
  const { rows } = await db.query<{ id: number; overdue: number }>(
    `SELECT id, floor(extract(epoch FROM now() - held_until))::int AS overdue FROM seats
      WHERE status = 'held' AND held_until < now() - make_interval(secs => $1)
      ORDER BY id`,
    [STALE_HOLD_SECONDS],
  );
  if (rows.length === 0) {
    return { id: 'INV-4', rule, passed: true, detail: 'no stale holds' };
  }
  const seats = rows.slice(0, EXAMPLES).map((row) => row.id);
  const worst = Math.max(...rows.map((row) => row.overdue));
  const verb = rows.length === 1 ? 'is' : 'are';
  return {
    id: 'INV-4',
    rule,
    passed: false,
    detail: `${describeSeats(seats)}${andMore(rows.length)} ${verb} still held, up to ${worst} s past expiry`,
  };
}

export async function runAudit({
  connectionString,
  paymentsSchema = PAYMENTS_SCHEMA,
}: AuditOptions): Promise<AuditReport> {
  assertSchemaName(paymentsSchema);
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: 'taquilla-audit',
  });
  // A dropped connection fails the query in progress; without a listener it would crash instead.
  client.on('error', () => undefined);
  await client.connect();

  try {
    // One snapshot for all four checks, so orders and charges are compared at the same instant.
    // READ ONLY makes Postgres refuse any write, whatever a check might try.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const checks = [
      await oneTicketPerSeat(client),
      await oneChargePerOrder(client, paymentsSchema),
      await chargedEqualsPaid(client, paymentsSchema),
      await noStaleHolds(client),
    ];
    await client.query('COMMIT');
    return { checks, passed: checks.every((check) => check.passed) };
  } finally {
    await client.end();
  }
}

// A plain-text table, one row per rule, then the verdict.
export function formatReport({ checks, passed }: AuditReport): string {
  const header = ['Rule', 'Check', 'Result', 'Detail'];
  const rows = checks.map((check) => [
    check.id,
    check.rule,
    check.passed ? 'PASS' : 'FAIL',
    check.detail,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join('  ');
  const failed = checks.filter((check) => !check.passed).length;
  return [
    line(header),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
    '',
    passed
      ? 'Audit passed: all four rules hold.'
      : `Audit failed: ${count(failed, 'rule')} broken.`,
  ].join('\n');
}
