import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';

const SERIALIZATION_FAILURE = '40001';

export interface RetryOptions {
  logger: Logger;
  retries?: number;
  baseDelayMs?: number;
  // Replaceable so tests can pin the jitter and skip the waiting.
  random?: () => number;
  wait?: (ms: number) => Promise<unknown>;
}

function isSerializationFailure(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && err.code === SERIALIZATION_FAILURE
  );
}

// Runs attempt() again when Postgres aborts it with a serialization failure (40001), up to
// `retries` more times, then lets the last failure through for the route to map to 409 SEAT_BUSY
// (requirements.md §6.4). Any other error is thrown at once.
export async function retrySerializationFailures<T>(
  attempt: () => Promise<T>,
  { logger, retries = 3, baseDelayMs = 20, random = Math.random, wait = sleep }: RetryOptions,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!isSerializationFailure(err) || retry >= retries) throw err;
      // Exponential backoff with full jitter: a random wait below a cap that doubles each time,
      // so fans who collided once don't all retry at the same moment and collide again.
      const delayMs = Math.round(random() * baseDelayMs * 2 ** retry);
      logger.warn({ retry: retry + 1, delayMs }, 'serialization failure, retrying the hold');
      await wait(delayMs);
    }
  }
}
