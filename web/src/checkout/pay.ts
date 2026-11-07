import type { ApiClient, Order } from '../api/client.js';
import { ApiError } from '../api/errors.js';

// While the first request with a key is still running, the API answers 409 REQUEST_IN_PROGRESS
// (FR-IDEM-5). The page then waits and sends the same request with the same key, until the first
// one's answer is saved and comes back (FR-WEB-3). Thirty tries a second apart outlast the
// slowest checkout, a charge and then a refund.
export const IN_PROGRESS_WAIT_MS = 1_000;
export const IN_PROGRESS_TRIES = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PayOptions {
  // Waits between tries; tests pass their own.
  wait?: (ms: number) => Promise<void>;
}

// Pays for a hold with one key, riding out 409 REQUEST_IN_PROGRESS. Any other answer, including
// one more 409 after the last try, is the caller's to show.
export async function payHold(
  api: ApiClient,
  holdId: string,
  token: string,
  key: string,
  { wait = sleep }: PayOptions = {},
): Promise<Order> {
  for (let tries = 1; ; tries += 1) {
    try {
      return await api.checkout(holdId, token, key);
    } catch (err) {
      const inProgress = err instanceof ApiError && err.code === 'REQUEST_IN_PROGRESS';
      if (!inProgress || tries >= IN_PROGRESS_TRIES) throw err;
      await wait(IN_PROGRESS_WAIT_MS);
    }
  }
}
