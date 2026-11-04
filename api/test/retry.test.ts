import { describe, expect, it } from 'vitest';
import { retrySerializationFailures } from '../src/holds/retry.js';
import { createLogger } from '../src/logger.js';

const serializationFailure = Object.assign(new Error('could not serialize access'), {
  code: '40001',
});
const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });

interface Run {
  result: Promise<string>;
  calls: () => number;
  waits: number[];
  warnings: { retry: number; delayMs: number }[];
}

// Fails with each error in turn, then succeeds. Jitter is pinned to half, and nothing really waits.
function run(failures: Error[], options: { retries?: number } = {}): Run {
  let calls = 0;
  const waits: number[] = [];
  const warnings: Run['warnings'] = [];
  const logger = createLogger('warn', {
    write: (line: string) => warnings.push(JSON.parse(line) as Run['warnings'][number]),
  });

  const result = retrySerializationFailures(
    () => {
      const failure = failures[calls];
      calls += 1;
      return failure === undefined ? Promise.resolve('held') : Promise.reject(failure);
    },
    {
      logger,
      baseDelayMs: 20,
      random: () => 0.5,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      ...options,
    },
  );
  return { result, calls: () => calls, waits, warnings };
}

describe('retrySerializationFailures', () => {
  it('returns the first result when nothing fails', async () => {
    const attempt = run([]);

    await expect(attempt.result).resolves.toBe('held');
    expect(attempt.calls()).toBe(1);
    expect(attempt.waits).toEqual([]);
  });

  it('retries a serialization failure, waiting longer each time, and logs each retry', async () => {
    const attempt = run([serializationFailure, serializationFailure]);

    await expect(attempt.result).resolves.toBe('held');
    expect(attempt.calls()).toBe(3);
    // Half of a cap that doubles: 20 ms, then 40 ms.
    expect(attempt.waits).toEqual([10, 20]);
    expect(attempt.warnings).toMatchObject([
      { retry: 1, delayMs: 10 },
      { retry: 2, delayMs: 20 },
    ]);
  });

  it('gives up after 3 retries and lets the last failure through', async () => {
    const attempt = run(Array.from({ length: 10 }, () => serializationFailure));

    await expect(attempt.result).rejects.toMatchObject({ code: '40001' });
    expect(attempt.calls()).toBe(4);
    expect(attempt.waits).toEqual([10, 20, 40]);
  });

  it.each([
    ['a deadlock', deadlock],
    ['any other error', new Error('connection refused')],
  ])('does not retry %s', async (_name, error) => {
    const attempt = run([error]);

    await expect(attempt.result).rejects.toBe(error);
    expect(attempt.calls()).toBe(1);
  });

  it('keeps every wait below its cap, whatever the jitter', async () => {
    const waits: number[] = [];
    await expect(
      retrySerializationFailures(() => Promise.reject(serializationFailure), {
        logger: createLogger('silent'),
        baseDelayMs: 20,
        random: () => 0.999,
        wait: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(serializationFailure);

    expect(waits).toEqual([20, 40, 80]);
  });
});
