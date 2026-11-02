import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createShutdown } from '../src/shutdown.js';

const logger = createLogger('silent');

let server: Server;
let releaseRequest: () => void;
let requestStarted: Promise<void>;

async function startServer(): Promise<string> {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  requestStarted = started.promise;
  releaseRequest = release.resolve;

  server = createServer((req, res) => {
    if (req.url === '/slow') {
      started.resolve();
      void release.promise.then(() => res.end('finished'));
    } else {
      res.end('ok');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
  releaseRequest();
  server.closeAllConnections();
  server.close();
});

describe('createShutdown', () => {
  it('stops accepting, finishes the in-flight request, then closes and exits 0', async () => {
    const url = await startServer();
    const events: string[] = [];
    const exit = vi.fn((code: number) => {
      events.push(`exit ${code}`);
    });
    const close = () => {
      events.push('closed');
      return Promise.resolve();
    };
    const shutdown = createShutdown({ server, logger, closers: [close], exit });

    const inFlight = fetch(`${url}/slow`);
    await requestStarted;
    const done = shutdown('SIGTERM');

    await expect(fetch(`${url}/ok`)).rejects.toThrow();
    expect(events).toEqual([]);

    releaseRequest();
    await expect((await inFlight).text()).resolves.toBe('finished');
    await done;

    expect(events).toEqual(['closed', 'exit 0']);
  });

  it('closes an idle keep-alive connection instead of waiting for it', async () => {
    const url = await startServer();
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, exit });

    await (await fetch(`${url}/ok`, { keepalive: true })).text();
    await shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('forces exit 1 when a request never finishes', async () => {
    const url = await startServer();
    const close = vi.fn(() => Promise.resolve());
    const exited = Promise.withResolvers<number>();
    const shutdown = createShutdown({
      server,
      logger,
      closers: [close],
      forceAfterMs: 50,
      exit: exited.resolve,
    });

    fetch(`${url}/slow`).catch(() => undefined);
    await requestStarted;
    void shutdown('SIGTERM');

    await expect(exited.promise).resolves.toBe(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('exits 1 when closing a resource fails', async () => {
    await startServer();
    const exit = vi.fn();
    const close = () => Promise.reject(new Error('pool stuck'));

    await createShutdown({ server, logger, closers: [close], exit })('SIGTERM');

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('ignores a second signal', async () => {
    await startServer();
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, exit });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
