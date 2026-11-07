import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { Queryable } from '../src/charges.js';
import { createFaults, NO_FAULTS } from '../src/faults.js';
import { createLogger } from '../src/logger.js';

interface LogLine {
  level: number;
  req?: { url: string };
}

describe('request logging', () => {
  it("logs Docker's passing health check at debug, and other requests at info", async () => {
    const logs: LogLine[] = [];
    const logger = createLogger('debug', {
      write: (line: string) => logs.push(JSON.parse(line) as LogLine),
    });
    const app = createApp({ db: {} as Queryable, faults: createFaults(NO_FAULTS), logger });

    await request(app).get('/health');
    await request(app).get('/nowhere');

    const levelOf = (url: string) =>
      vi.waitFor(() => {
        const line = logs.find((entry) => entry.req?.url === url);
        if (!line) throw new Error(`no log line for ${url}`);
        return line.level;
      });
    expect(await levelOf('/health')).toBe(20);
    expect(await levelOf('/nowhere')).toBe(30);
  });
});
