import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import { z } from 'zod';

// FR-PAY-7: each attempt gets 3 seconds, and up to 3 retries follow the first attempt.
export const PAYMENT_TIMEOUT_MS = 3_000;
export const PAYMENT_RETRIES = 3;

const providerCharge = z.object({
  id: z.uuid(),
  key: z.string(),
  orderId: z.uuid(),
  amountPaise: z.number().int(),
  status: z.enum(['succeeded', 'declined', 'refunded']),
  createdAt: z.string(),
  refundedAt: z.string().nullable(),
});

const providerError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export type ProviderCharge = z.output<typeof providerCharge>;

// unavailable: every attempt failed, so the charge may or may not exist. Retrying with the same
// key later is always safe, and finds out (FR-PAY-12).
export type ChargeResult =
  { status: 'succeeded' | 'declined'; charge: ProviderCharge } | { status: 'unavailable' };

export type RefundResult =
  { status: 'refunded'; charge: ProviderCharge } | { status: 'unavailable' };

export interface ChargeRequest {
  key: string;
  orderId: string;
  amountPaise: number;
}

// Per call, so a route can pass its own request logger and ID: the provider logs the same ID.
export interface CallContext {
  logger?: Logger;
  requestId?: string;
}

export interface PaymentClient {
  charge(request: ChargeRequest, context?: CallContext): Promise<ChargeResult>;
  refund(key: string, context?: CallContext): Promise<RefundResult>;
}

export interface PaymentClientOptions {
  baseUrl: string;
  logger: Logger;
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  // Replaceable so tests can pin the jitter and skip the waiting.
  random?: () => number;
  wait?: (ms: number) => Promise<unknown>;
}

// The provider answered in a way that retrying can't fix: a 4xx, or a body it shouldn't send.
// It reaches the fan as a 500, because it means a bug on one side or the other.
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PaymentProviderError';
  }
}

// The provider key for one payment attempt of one order (FR-PAY-7). The provider accepts keys of
// up to 255 visible ASCII characters, so the fan's own key must stay within 214 of them.
export function paymentKey(orderId: string, clientKey: string): string {
  return `pay:${orderId}:${clientKey}`;
}

// What one attempt came to: an answer to interpret, or a failure that a retry may fix.
type Attempt =
  { answered: true; status: number; body: unknown } | { answered: false; reason: string };

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export function createPaymentClient({
  baseUrl,
  logger: defaultLogger,
  timeoutMs = PAYMENT_TIMEOUT_MS,
  retries = PAYMENT_RETRIES,
  baseDelayMs = 100,
  random = Math.random,
  wait = sleep,
}: PaymentClientOptions): PaymentClient {
  async function send(
    path: string,
    init: { headers: Record<string, string>; body?: string },
  ): Promise<Attempt> {
    let status: number;
    let text: string;
    try {
      // The timeout covers the whole exchange, body included, so a provider that stalls
      // halfway through its answer is cut off too.
      const response = await fetch(new URL(path, baseUrl), {
        method: 'POST',
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      if (status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        return { answered: false, reason: `status ${status}` };
      }
      text = await response.text();
    } catch (err) {
      if (isTimeout(err)) return { answered: false, reason: 'timeout' };
      // fetch fails with a TypeError when the connection is refused, reset or cut off mid-answer.
      if (err instanceof TypeError) {
        const cause = err.cause instanceof Error ? err.cause.message : err.message;
        return { answered: false, reason: `network: ${cause}` };
      }
      throw err;
    }

    try {
      return { answered: true, status, body: JSON.parse(text) as unknown };
    } catch (err) {
      throw new PaymentProviderError(
        `The payment provider answered ${status} with a body that is not JSON.`,
        status,
        undefined,
        { cause: err },
      );
    }
  }

  // Sends the request up to 1 + retries times, always with the same key, and hands the first
  // answer to interpret(). Waits between attempts use exponential backoff with full jitter.
  async function withRetries<T>(
    operation: 'charge' | 'refund',
    key: string,
    attempt: () => Promise<Attempt>,
    interpret: (status: number, body: unknown) => T,
    logger: Logger,
  ): Promise<T | { status: 'unavailable' }> {
    for (let retry = 0; ; retry += 1) {
      const result = await attempt();
      if (result.answered) return interpret(result.status, result.body);
      if (retry >= retries) {
        logger.error(
          { operation, key, attempts: retry + 1, reason: result.reason },
          'payment provider unavailable, giving up',
        );
        return { status: 'unavailable' };
      }
      const delayMs = Math.round(random() * baseDelayMs * 2 ** retry);
      logger.warn(
        { operation, key, attempt: retry + 1, reason: result.reason, delayMs },
        'payment provider call failed, retrying with the same key',
      );
      await wait(delayMs);
    }
  }

  function parseCharge(status: number, body: unknown, key: string): ProviderCharge {
    const charge = providerCharge.safeParse(body);
    if (charge.success) return charge.data;
    throw new PaymentProviderError(
      `The payment provider sent an unexpected answer (${status}) for ${key}.`,
      status,
      undefined,
      { cause: charge.error },
    );
  }

  function refusal(
    operation: string,
    status: number,
    body: unknown,
    key: string,
  ): PaymentProviderError {
    const parsed = providerError.safeParse(body);
    const code = parsed.success ? parsed.data.error.code : undefined;
    const detail = parsed.success ? `: ${parsed.data.error.message}` : '';
    return new PaymentProviderError(
      `The payment provider refused the ${operation} for ${key} (${status} ${code ?? 'unknown'})${detail}`,
      status,
      code,
    );
  }

  function requestIdHeader(requestId: string | undefined): Record<string, string> {
    return requestId === undefined ? {} : { 'X-Request-Id': requestId };
  }

  return {
    charge({ key, orderId, amountPaise }, { logger = defaultLogger, requestId } = {}) {
      const init = {
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...requestIdHeader(requestId),
        },
        body: JSON.stringify({ orderId, amountPaise }),
      };
      return withRetries(
        'charge',
        key,
        () => send('/charges', init),
        (status, body) => {
          if (status !== 200 && status !== 201) throw refusal('charge', status, body, key);
          const charge = parseCharge(status, body, key);
          // Only a charge that was refunded earlier comes back like this, and it can't pay again.
          if (charge.status === 'refunded') {
            throw new PaymentProviderError(`The charge for ${key} was already refunded.`, status);
          }
          return { status: charge.status, charge };
        },
        logger,
      );
    },

    refund(key, { logger = defaultLogger, requestId } = {}) {
      return withRetries(
        'refund',
        key,
        // The key is in the path, so the refund itself is what makes a repeat harmless.
        () =>
          send(`/charges/${encodeURIComponent(key)}/refund`, {
            headers: requestIdHeader(requestId),
          }),
        (status, body) => {
          if (status !== 200) throw refusal('refund', status, body, key);
          const charge = parseCharge(status, body, key);
          if (charge.status !== 'refunded') {
            throw new PaymentProviderError(
              `The refund of ${key} left it ${charge.status}.`,
              status,
            );
          }
          return { status: 'refunded' as const, charge };
        },
        logger,
      );
    },
  };
}
