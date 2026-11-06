import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { Logger } from 'pino';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

const BEGIN: Record<IsolationLevel, string> = {
  'read committed': 'BEGIN ISOLATION LEVEL READ COMMITTED',
  'repeatable read': 'BEGIN ISOLATION LEVEL REPEATABLE READ',
  serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
};

// query_timeout is honoured by pg but missing from its types, so this can't be written inline.
const READY_QUERY = { text: 'SELECT 1', query_timeout: 2_000 };

// Postgres's default random_page_cost of 4 assumes spinning disks. The stadium is small enough
// to stay in memory, where reading by index costs about what reading in order does. At 4, the
// planner reads the whole seats table and sorts it for the seat map (2.3–2.8 ms); at 1.1, the
// SSD value, it walks the (event, section, row, seat) index already in that order (0.6–0.7 ms).
// See docs/benchmarks.md.
const SESSION_OPTIONS = '-c random_page_cost=1.1';

// Sends SESSION_OPTIONS in each connection's startup message, so Postgres applies them before the
// first query, with no query of their own. pg lets the URL's `options` override the pool's, so
// they're appended to any the URL already carries; a later -c wins, so they hold whatever it says.
function withSessionOptions(connectionString: string): string {
  const url = new URL(connectionString);
  const carried = url.searchParams.get('options');
  url.searchParams.set('options', carried ? `${carried} ${SESSION_OPTIONS}` : SESSION_OPTIONS);
  return url.href;
}

export interface DatabaseOptions {
  connectionString: string;
  logger: Logger;
  max?: number;
  connectionTimeoutMillis?: number;
}

export interface Database {
  pool: Pool;
  withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    options?: { isolation?: IsolationLevel },
  ): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase({
  connectionString,
  logger,
  max = 20,
  connectionTimeoutMillis = 5_000,
}: DatabaseOptions): Database {
  const pool = new Pool({
    connectionString: withSessionOptions(connectionString),
    max,
    connectionTimeoutMillis,
    // Queries outside a transaction get the same limit that withTransaction sets.
    statement_timeout: 5_000,
    application_name: 'taquilla-api',
  });

  // Without a listener, an idle connection dropping would crash the process.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle database connection lost');
  });

  return {
    pool,

    async withTransaction(fn, { isolation = 'read committed' } = {}) {
      const client = await pool.connect();
      // The pool only listens for errors on idle clients, so a checked-out client needs its own.
      const onConnectionLost = (err: Error) => {
        logger.error({ err }, 'database connection lost mid-transaction');
      };
      client.on('error', onConnectionLost);
      let broken = false;

      try {
        await client.query(BEGIN[isolation]);
        await client.query(`SET LOCAL lock_timeout = '2s'`);
        await client.query(`SET LOCAL statement_timeout = '5s'`);
        const result = await fn(client);
        // COMMIT on an aborted transaction "succeeds" by rolling back, so check what it did.
        const { command } = await client.query('COMMIT');
        if (command !== 'COMMIT') {
          throw new Error('The transaction was rolled back: a query in it had failed.');
        }
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          broken = true;
          logger.error({ err: rollbackErr }, 'rollback failed, discarding the connection');
        }
        throw err;
      } finally {
        client.removeListener('error', onConnectionLost);
        client.release(broken);
      }
    },

    async ping() {
      await pool.query(READY_QUERY);
    },

    close() {
      return pool.end();
    },
  };
}
