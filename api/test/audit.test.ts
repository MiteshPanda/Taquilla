import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Pool } from 'pg';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSchema } from '../../payments-mock/test/helpers/mock.js';
import { formatReport, runAudit } from '../../scripts/audit.js';
import type { AuditReport } from '../../scripts/audit.js';
import { resetDatabase } from '../../scripts/reset.js';
import { seedStadium } from '../../scripts/seed.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import {
  DOWN_DATABASE_URL,
  schemaConnectionString,
  TEST_DATABASE_URL,
} from './helpers/database.js';

// FR-AUD-1 and FR-AUD-2: the audit passes on a healthy stadium, and planting a violation of any
// one rule makes it fail on that rule.
const SCHEMA = 'audit_probe';
const PAYMENTS_SCHEMA = 'audit_payments';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const FAN = 1;
// Lateral Este, 4,500 rupees each.
const PRICE = 450_000;

const logger = createLogger('silent');

let db: Database;
let charges: Pool;

function audit(): Promise<AuditReport> {
  return runAudit({ connectionString: CONNECTION_STRING, paymentsSchema: PAYMENTS_SCHEMA });
}

function failing(report: AuditReport): string[] {
  return report.checks.filter((check) => !check.passed).map((check) => check.id);
}

function detailOf(report: AuditReport, id: string): string | undefined {
  return report.checks.find((check) => check.id === id)?.detail;
}

async function newHold(seatIds: number[]): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES ($1, 1, $2, $3) RETURNING id`,
    [FAN, seatIds, PRICE * seatIds.length],
  );
  return rows[0]?.id ?? '';
}

async function newOrder(holdId: string, status: string, amountPaise: number): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO orders (hold_id, user_id, amount_paise, status, payment_key)
     VALUES ($1, $2, $3, $4, 'pay:test') RETURNING id`,
    [holdId, FAN, amountPaise, status],
  );
  return rows[0]?.id ?? '';
}

async function charge(orderId: string, amountPaise: number, status = 'succeeded'): Promise<void> {
  await charges.query(
    `INSERT INTO charges (key, order_id, amount_paise, status, refunded_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      `pay:${randomUUID()}`,
      orderId,
      amountPaise,
      status,
      status === 'refunded' ? new Date() : null,
    ],
  );
}

// What a successful checkout leaves: seats sold, one ticket each, the order paid, one charge.
async function sell(seatIds: number[]): Promise<string> {
  const holdId = await newHold(seatIds);
  const orderId = await newOrder(holdId, 'paid', PRICE * seatIds.length);
  await db.pool.query(`UPDATE holds SET status = 'converted' WHERE id = $1`, [holdId]);
  await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = ANY($1::int[])`, [seatIds]);
  await db.pool.query(`INSERT INTO tickets (order_id, seat_id) SELECT $1, unnest($2::int[])`, [
    orderId,
    seatIds,
  ]);
  await charge(orderId, PRICE * seatIds.length);
  return orderId;
}

// A seat held by a fresh hold, lapsing secondsLeft from now (negative: already lapsed).
async function holdSeat(seatId: number, secondsLeft: number): Promise<void> {
  const holdId = await newHold([seatId]);
  await db.pool.query(
    `UPDATE seats SET status = 'held', hold_id = $1, held_until = now() + make_interval(secs => $2)
      WHERE id = $3`,
    [holdId, secondsLeft, seatId],
  );
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
  charges = await createTestSchema(PAYMENTS_SCHEMA);
});

beforeEach(async () => {
  await db.pool.query('DELETE FROM tickets');
  await db.pool.query('DELETE FROM orders');
  await db.pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
      WHERE status <> 'available'`,
  );
  await db.pool.query('DELETE FROM holds');
  await charges.query('TRUNCATE charges');
});

afterAll(async () => {
  await charges.query(`DROP SCHEMA IF EXISTS ${PAYMENTS_SCHEMA} CASCADE`);
  await charges.end();
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('runAudit on a healthy stadium', () => {
  it('passes every rule after sales, a decline, a refund and live holds', async () => {
    await sell([41, 42]);
    await sell([43]);
    // Declined first, then paid with a new key: two charges, one of them successful.
    const retried = await sell([48]);
    await charge(retried, PRICE, 'declined');
    // A declined attempt on an order that is pending again, and a sale refunded after lost seats.
    const pending = await newOrder(await newHold([44]), 'pending', PRICE);
    await charge(pending, PRICE, 'declined');
    const refunded = await newOrder(await newHold([45]), 'refunded', PRICE);
    await charge(refunded, PRICE, 'refunded');
    // A live hold, and one lapsed 10 s ago that the sweeper still has time to free.
    await holdSeat(46, 300);
    await holdSeat(47, -10);
    // A cancelled ticket beside the valid one for the same seat doesn't count.
    await db.pool.query(
      `INSERT INTO tickets (order_id, seat_id, status)
       SELECT order_id, seat_id, 'cancelled' FROM tickets WHERE seat_id = 43`,
    );

    const report = await audit();

    expect(failing(report)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => [check.id, check.detail])).toEqual([
      ['INV-1', '4 valid tickets, no seat twice'],
      ['INV-2', '3 successful charges, none twice for one order'],
      ['INV-3', 'charged ₹18,000.00, paid ₹18,000.00 across 3 paid orders'],
      ['INV-4', 'no stale holds'],
    ]);
  });

  it('passes on an empty stadium', async () => {
    const report = await audit();

    expect(report.passed).toBe(true);
    expect(detailOf(report, 'INV-3')).toBe('charged ₹0.00, paid ₹0.00 across 0 paid orders');
  });
});

describe('runAudit with a planted violation', () => {
  describe('INV-1: a seat sold twice', () => {
    afterEach(async () => {
      await db.pool.query('DELETE FROM tickets');
      await db.pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS one_valid_ticket_per_seat
           ON tickets (seat_id) WHERE status = 'valid'`,
      );
    });

    it('fails on the seat with two valid tickets, and only on INV-1', async () => {
      const orderId = await sell([41, 42]);
      // The partial unique index refuses a second valid ticket, so it goes first.
      await db.pool.query('DROP INDEX one_valid_ticket_per_seat');
      await db.pool.query('INSERT INTO tickets (order_id, seat_id) VALUES ($1, 42)', [orderId]);

      const report = await audit();

      expect(failing(report)).toEqual(['INV-1']);
      expect(report.passed).toBe(false);
      expect(detailOf(report, 'INV-1')).toBe('seat 42 has 2 valid tickets');
    });
  });

  it('INV-2: fails on an order charged twice', async () => {
    const orderId = await sell([41]);
    await charge(orderId, PRICE);

    const report = await audit();

    // The extra money also breaks INV-3, as it should.
    expect(failing(report)).toEqual(['INV-2', 'INV-3']);
    expect(detailOf(report, 'INV-2')).toBe(`order ${orderId} has 2 successful charges`);
  });

  it('INV-3: fails on a paid order with no charge', async () => {
    const holdId = await newHold([41]);
    const orderId = await newOrder(holdId, 'paid', PRICE);

    const report = await audit();

    expect(failing(report)).toEqual(['INV-3']);
    expect(detailOf(report, 'INV-3')).toBe(
      `charged ₹0.00, paid ₹4,500.00 across 1 paid order; order ${orderId}: charged ₹0.00, paid ₹4,500.00`,
    );
  });

  it('INV-3: fails on money taken for an order that was never paid', async () => {
    const orderId = await newOrder(await newHold([41]), 'paying', PRICE);
    await charge(orderId, PRICE);

    const report = await audit();

    expect(failing(report)).toEqual(['INV-3']);
  });

  it('INV-3: fails even when the totals match, if they match by accident', async () => {
    // A paid order with no charge, and a charge for another order that isn't paid: the sums
    // agree, but two fans were wronged.
    await newOrder(await newHold([41]), 'paid', PRICE);
    const unpaid = await newOrder(await newHold([42]), 'pending', PRICE);
    await charge(unpaid, PRICE);

    const report = await audit();

    expect(failing(report)).toEqual(['INV-3']);
    expect(detailOf(report, 'INV-3')).toMatch(
      /^charged ₹4,500\.00, paid ₹4,500\.00 across 1 paid order; /,
    );
  });

  it('INV-4: fails on a seat held 31 s past expiry, and passes at 29 s', async () => {
    await holdSeat(43, -29);
    expect((await audit()).passed).toBe(true);

    await holdSeat(44, -31);
    const report = await audit();

    expect(failing(report)).toEqual(['INV-4']);
    expect(detailOf(report, 'INV-4')).toMatch(/^Seat 44 is still held, up to 3\d s past expiry$/);
  });

  it('names at most five offenders and counts the rest', async () => {
    for (const seatId of [41, 42, 43, 44, 45, 46, 47]) await holdSeat(seatId, -60);

    const report = await audit();

    expect(detailOf(report, 'INV-4')).toMatch(
      /^Seats 41, 42, 43, 44 and 45, and 2 more are still held, up to \d+ s past expiry$/,
    );
  });
});

describe('formatReport', () => {
  it('prints one row per rule and the verdict', async () => {
    await holdSeat(44, -31);

    const text = formatReport(await audit());

    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Rule\s+Check\s+Result\s+Detail$/);
    expect(lines.slice(2, 6).map((line) => line.split(/\s{2,}/)[2])).toEqual([
      'PASS',
      'PASS',
      'PASS',
      'FAIL',
    ]);
    expect(lines.at(-1)).toBe('Audit failed: 1 rule broken.');
  });

  it('refuses a payments schema name that is not a plain identifier', async () => {
    await expect(
      runAudit({ connectionString: CONNECTION_STRING, paymentsSchema: 'payments; DROP' }),
    ).rejects.toThrow('Bad schema name');
  });
});

// The real command, against a database of its own reset the way a developer would.
describe('npm run audit', { timeout: 60_000 }, () => {
  const PROBE_DATABASE = 'taquilla_audit_probe';
  const PROBE_URL = TEST_DATABASE_URL.replace(/taquilla_test$/, PROBE_DATABASE);
  const CLI = path.resolve(import.meta.dirname, '../../scripts/audit-cli.ts');

  async function admin(sql: string): Promise<void> {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function runCli(databaseUrl: string): Promise<{ code: number | null; stdout: string }> {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI], {
      env: { ...process.env, DATABASE_URL: databaseUrl, LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const [code] = (await once(child, 'exit')) as [number | null];
    return { code, stdout };
  }

  beforeAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${PROBE_DATABASE}`);
    await resetDatabase({
      connectionString: PROBE_URL,
      nodeEnv: 'test',
      seedPassword: 'audit-probe-password',
      logger,
    });
  }, 60_000);

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`);
  }, 30_000);

  it('exits 0 and prints the table on a freshly reset stadium', async () => {
    const run = await runCli(PROBE_URL);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Audit passed: all four rules hold.');
  });

  it('exits 1 when a rule is broken (FR-AUD-2)', async () => {
    const client = new Client({ connectionString: PROBE_URL });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise)
         VALUES (1, 1, '{42}', 450000) RETURNING id`,
      );
      await client.query(
        `UPDATE seats SET status = 'held', hold_id = $1, held_until = now() - interval '1 minute'
          WHERE id = 42`,
        [rows[0]?.id],
      );
    } finally {
      await client.end();
    }

    const run = await runCli(PROBE_URL);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('Audit failed: 1 rule broken.');
  });

  it('exits 2 when it cannot reach the database', async () => {
    const run = await runCli(DOWN_DATABASE_URL);

    expect(run.code).toBe(2);
    expect(run.stdout).toContain('audit could not run');
  });
});
