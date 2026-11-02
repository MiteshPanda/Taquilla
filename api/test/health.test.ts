import { connect, createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHealthRouter } from '../src/health/routes.js';
import { createLogger } from '../src/logger.js';
import { DOWN_DATABASE_URL, TEST_DATABASE_URL } from './helpers/database.js';

interface LogLine {
  level: number;
  err?: { message: string; stack: string };
}

const logs: LogLine[] = [];
const logger = createLogger('info', {
  write: (line: string) => logs.push(JSON.parse(line) as LogLine),
});

const UNAVAILABLE = {
  error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is unavailable.' },
};

function buildApp(db: Database) {
  return createApp({
    config: { CORS_ORIGINS: [] },
    logger,
    routes: createHealthRouter(db),
  });
}

const up = createDatabase({ connectionString: TEST_DATABASE_URL, logger });
const down = createDatabase({ connectionString: DOWN_DATABASE_URL, logger });

beforeEach(() => {
  logs.length = 0;
});

afterAll(async () => {
  await Promise.all([up.close(), down.close()]);
});

describe('GET /health', () => {
  it('answers 200 while the database is up', async () => {
    const res = await request(buildApp(up)).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('still answers 200 while the database is down, because the process is up', async () => {
    const res = await request(buildApp(down)).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /ready', () => {
  it('answers 200 while the database is up', async () => {
    const res = await request(buildApp(up)).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('answers 503 while the database is down, without the connection details', async () => {
    const res = await request(buildApp(down)).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);
    expect(res.text).not.toContain('127.0.0.1');
  });

  it('logs why the database is unavailable', async () => {
    await request(buildApp(down)).get('/ready');

    await vi.waitFor(() => {
      const line = logs.find((entry) => entry.err);
      expect(line?.level).toBe(50);
      expect(line?.err?.stack).toContain('ECONNREFUSED');
    });
  });

  it('answers 503 when an open connection stops responding', async () => {
    let stalled = false;
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
    };
    const proxy = createServer((client) => {
      const upstream = connect(5432, 'localhost');
      track(client);
      track(upstream);
      client.on('data', (data) => stalled || upstream.write(data));
      upstream.on('data', (data) => stalled || client.write(data));
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const { port } = proxy.address() as AddressInfo;
    const viaProxy = createDatabase({
      connectionString: `postgres://taquilla:taquilla@127.0.0.1:${port}/taquilla_test`,
      logger,
    });
    const app = buildApp(viaProxy);

    expect((await request(app).get('/ready')).status).toBe(200);
    stalled = true;
    const res = await request(app).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);

    for (const socket of sockets) socket.destroy();
    await viaProxy.close();
    proxy.close();
  });

  it('answers 503 when a server accepts the connection but never responds', async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    const stalled = createDatabase({
      connectionString: `postgres://taquilla:taquilla@127.0.0.1:${port}/taquilla_test`,
      logger,
      connectionTimeoutMillis: 100,
    });

    const res = await request(buildApp(stalled)).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual(UNAVAILABLE);

    await stalled.close();
    for (const socket of sockets) socket.destroy();
    silent.close();
  });
});
