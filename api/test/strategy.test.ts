import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOKING_STRATEGIES } from '../src/config.js';
import type { BookingStrategy } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { createLogger } from '../src/logger.js';
import { DOWN_DATABASE_URL } from './helpers/database.js';

const SERVER = path.resolve(import.meta.dirname, '../src/server.ts');
const logger = createLogger('silent');

interface ServerRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function freePort(): Promise<number> {
  const probe = createServer().listen(0);
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Starts the real server in its own process, as `npm run dev` would, and stops it once it is
// listening. Nothing here needs a database: the pool only connects on its first query.
async function runServer(bookingStrategy: string): Promise<ServerRun> {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      PORT: String(await freePort()),
      JWT_SECRET: 'strategy-test-secret-at-least-32-chars',
      DATABASE_URL: DOWN_DATABASE_URL,
      BOOKING_STRATEGY: bookingStrategy,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes('"msg":"server listening"')) child.kill();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const [exitCode] = (await once(child, 'exit')) as [number | null];
  return { exitCode, stdout, stderr };
}

describe('createHoldStrategy', () => {
  const db = createDatabase({ connectionString: DOWN_DATABASE_URL, logger });

  it.each(BOOKING_STRATEGIES)('builds the %s strategy', (name) => {
    expect(createHoldStrategy(name, { db, holdSeconds: 300 }).name).toBe(name);
  });

  it('throws for a name that config validation would have refused', () => {
    expect(() =>
      createHoldStrategy('optimism' as BookingStrategy, { db, holdSeconds: 300 }),
    ).toThrow('Unknown booking strategy "optimism".');
  });
});

describe('choosing the strategy at startup', { timeout: 30_000 }, () => {
  it('refuses to start with an unknown BOOKING_STRATEGY, naming the valid ones', async () => {
    const run = await runServer('optimism');

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('BOOKING_STRATEGY');
    expect(run.stderr).toContain('expected one of "lock"|"cas"|"serializable"');
    expect(run.stdout).not.toContain('server listening');
  });

  it.each(BOOKING_STRATEGIES)('starts with %s and logs which strategy it chose', async (name) => {
    const run = await runServer(name);

    expect(run.stdout).toContain(`"strategy":"${name}","msg":"booking strategy selected"`);
    expect(run.stdout).toContain('"msg":"server listening"');
  });
});
