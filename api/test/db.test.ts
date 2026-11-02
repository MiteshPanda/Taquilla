import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { DOWN_DATABASE_URL, TEST_DATABASE_URL } from './helpers/database.js';

const logs: { msg: string }[] = [];
const logger = createLogger('error', {
  write: (line: string) => logs.push(JSON.parse(line) as { msg: string }),
});

let db: Database;

function open(options: { max?: number; connectionTimeoutMillis?: number } = {}): Database {
  return createDatabase({ connectionString: TEST_DATABASE_URL, logger, ...options });
}

async function noteCount(): Promise<number> {
  const { rows } = await db.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM db_layer_probe',
  );
  return rows[0]?.count ?? -1;
}

async function backendPid(client: { query: Database['pool']['query'] }): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]?.pid ?? -1;
}

function expectAllClientsReleased(database: Database): void {
  expect(database.pool.idleCount).toBe(database.pool.totalCount);
  expect(database.pool.waitingCount).toBe(0);
}

beforeAll(async () => {
  db = open();
  await db.pool.query('DROP TABLE IF EXISTS db_layer_probe');
  await db.pool.query(`
    CREATE TABLE db_layer_probe (
      id int PRIMARY KEY,
      ref int UNIQUE DEFERRABLE INITIALLY DEFERRED
    )
  `);
});

beforeEach(async () => {
  logs.length = 0;
  await db.pool.query('TRUNCATE db_layer_probe');
});

afterAll(async () => {
  await db.pool.query('DROP TABLE db_layer_probe');
  await db.close();
});

describe('withTransaction', () => {
  it('commits the work and returns the result', async () => {
    const result = await db.withTransaction(async (client) => {
      await client.query('INSERT INTO db_layer_probe (id) VALUES (1)');
      return 'done';
    });

    expect(result).toBe('done');
    expect(await noteCount()).toBe(1);
    expectAllClientsReleased(db);
  });

  it('rolls back and rethrows when the callback throws, and releases the client', async () => {
    const failure = new Error('business rule failed');

    await expect(
      db.withTransaction(async (client) => {
        await client.query('INSERT INTO db_layer_probe (id) VALUES (1)');
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await noteCount()).toBe(0);
    expectAllClientsReleased(db);
  });

  it('rolls back and rethrows when a query fails, and releases the client', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query('INSERT INTO db_layer_probe (id) VALUES (1)');
        await client.query('INSERT INTO db_layer_probe (id) VALUES (1)');
      }),
    ).rejects.toMatchObject({ code: '23505' });

    expect(await noteCount()).toBe(0);
    expectAllClientsReleased(db);
  });

  it('throws when COMMIT itself fails, and releases the client', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query('INSERT INTO db_layer_probe (id, ref) VALUES (1, 7), (2, 7)');
      }),
    ).rejects.toMatchObject({ code: '23505' });

    expect(await noteCount()).toBe(0);
    expectAllClientsReleased(db);
  });

  it('never reports success when the callback swallowed a failed query', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query('INSERT INTO db_layer_probe (id) VALUES (1)');
        await client.query('SELECT 1 / 0').catch(() => undefined);
      }),
    ).rejects.toThrow(/rolled back/);

    expect(await noteCount()).toBe(0);
    expectAllClientsReleased(db);
  });

  it('survives the connection dropping mid-transaction, and discards that client', async () => {
    const before = db.pool.totalCount;
    await db.ping();

    await expect(
      db.withTransaction(async (client) => {
        const pid = await backendPid(client);
        await db.pool.query('SELECT pg_terminate_backend($1)', [pid]);
        await vi.waitFor(() => {
          expect(logs.map((line) => line.msg)).toContain(
            'database connection lost mid-transaction',
          );
        });
        await client.query('INSERT INTO db_layer_probe (id) VALUES (1)');
      }),
    ).rejects.toThrow(/not queryable|terminat/i);

    expect(logs.map((line) => line.msg)).toContain('rollback failed, discarding the connection');
    expect(db.pool.totalCount).toBeLessThanOrEqual(Math.max(before, 2));
    expectAllClientsReleased(db);
    expect(await noteCount()).toBe(0);
  });

  it('keeps every client released when many transactions outnumber the pool', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, id) =>
        db.withTransaction(async (client) => {
          await client.query('INSERT INTO db_layer_probe (id) VALUES ($1)', [id]);
          if (id % 3 === 0) throw new Error('fails on purpose');
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(20);
    expect(await noteCount()).toBe(40);
    expect(db.pool.totalCount).toBeLessThanOrEqual(20);
    expectAllClientsReleased(db);
  });

  it('sets the lock and statement timeouts, only for the transaction', async () => {
    const single = open({ max: 1 });
    const show = async (client: Parameters<Parameters<Database['withTransaction']>[0]>[0]) => {
      const lock = await client.query<{ lock_timeout: string }>('SHOW lock_timeout');
      const statement = await client.query<{ statement_timeout: string }>('SHOW statement_timeout');
      return [lock.rows[0]?.lock_timeout, statement.rows[0]?.statement_timeout];
    };

    const inside = await single.withTransaction(show);
    const lockAfter = await single.pool.query<{ lock_timeout: string }>('SHOW lock_timeout');
    await single.close();

    expect(inside).toEqual(['2s', '5s']);
    expect(lockAfter.rows[0]?.lock_timeout).toBe('0');
  });

  it('fails fast with 55P03 instead of queueing on a locked row', async () => {
    await db.pool.query('INSERT INTO db_layer_probe (id) VALUES (1)');
    const locked = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const holder = db.withTransaction(async (client) => {
      await client.query('SELECT * FROM db_layer_probe WHERE id = 1 FOR UPDATE');
      locked.resolve();
      await finish.promise;
    });
    await locked.promise;

    const waiter = db.withTransaction((client) =>
      client.query('SELECT * FROM db_layer_probe WHERE id = 1 FOR UPDATE'),
    );

    await expect(waiter).rejects.toMatchObject({ code: '55P03' });
    finish.resolve();
    await holder;
    expectAllClientsReleased(db);
  });

  it.each(['read committed', 'repeatable read', 'serializable'] as const)(
    'runs at the %s isolation level',
    async (isolation) => {
      const level = await db.withTransaction(
        async (client) => {
          const { rows } = await client.query<{ transaction_isolation: string }>(
            'SHOW transaction_isolation',
          );
          return rows[0]?.transaction_isolation;
        },
        { isolation },
      );

      expect(level).toBe(isolation);
    },
  );

  it('defaults to read committed', async () => {
    const level = await db.withTransaction(async (client) => {
      const { rows } = await client.query<{ transaction_isolation: string }>(
        'SHOW transaction_isolation',
      );
      return rows[0]?.transaction_isolation;
    });

    expect(level).toBe('read committed');
  });
});

describe('the pool', () => {
  it('survives an idle connection dropping', async () => {
    const victim = await db.pool.connect();
    const other = await db.pool.connect();
    const pid = await backendPid(victim);
    victim.release();

    await other.query('SELECT pg_terminate_backend($1)', [pid]);
    other.release();

    await vi.waitFor(() => {
      expect(logs.map((line) => line.msg)).toContain('idle database connection lost');
    });
    await expect(db.ping()).resolves.toBeUndefined();
  });

  it('gives up waiting for a client after the connection timeout', async () => {
    const single = open({ max: 1, connectionTimeoutMillis: 100 });
    const finish = Promise.withResolvers<void>();
    const holder = single.withTransaction(() => finish.promise);
    await vi.waitFor(() => {
      expect(single.pool.totalCount).toBe(1);
    });

    await expect(single.withTransaction(() => Promise.resolve())).rejects.toThrow(/timeout/i);

    finish.resolve();
    await holder;
    await expect(single.ping()).resolves.toBeUndefined();
    await single.close();
  });

  it('caps statements outside a transaction with the statement timeout', async () => {
    const { rows } = await db.pool.query<{ statement_timeout: string }>('SHOW statement_timeout');

    expect(rows[0]?.statement_timeout).toBe('5s');
  });

  it('rejects when the database is down, with nothing left checked out', async () => {
    const down = createDatabase({ connectionString: DOWN_DATABASE_URL, logger });

    await expect(down.ping()).rejects.toThrow();
    await expect(down.withTransaction(() => Promise.resolve())).rejects.toThrow();

    expect(down.pool.totalCount).toBe(0);
    await down.close();
  });
});
