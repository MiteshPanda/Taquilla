import type { Server } from 'node:http';
import type { Logger } from 'pino';

export interface ShutdownOptions {
  server: Server;
  logger: Logger;
  closers?: (() => Promise<void>)[];
  forceAfterMs?: number;
  exit?: (code: number) => void;
}

export function createShutdown({
  server,
  logger,
  closers = [],
  forceAfterMs = 10_000,
  exit = (code) => process.exit(code),
}: ShutdownOptions): (signal: string) => Promise<void> {
  let started = false;

  return async (signal) => {
    if (started) return;
    started = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error({ forceAfterMs }, 'shutdown timed out, forcing exit');
      exit(1);
    }, forceAfterMs);
    forceExit.unref();

    try {
      // Stops accepting connections, then resolves once in-flight requests have finished.
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      for (const close of closers) await close();
      clearTimeout(forceExit);
      logger.info('shutdown complete');
      exit(0);
    } catch (err) {
      clearTimeout(forceExit);
      logger.error({ err }, 'shutdown failed');
      exit(1);
    }
  };
}
