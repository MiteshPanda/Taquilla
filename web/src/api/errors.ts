// Every code the API answers with (requirements.md §6.3). api/test/web-client.test.ts checks this
// list against the server's own type, so the two can't drift apart.
export const SERVER_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'PAYMENT_DECLINED',
  'NOT_FOUND',
  'EMAIL_TAKEN',
  'SEAT_TAKEN',
  'SEAT_BUSY',
  'HOLD_EXPIRED',
  'SEAT_LOST_REFUNDED',
  'PAYMENT_IN_PROGRESS',
  'REQUEST_IN_PROGRESS',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'PAYMENT_UNAVAILABLE',
  'DATABASE_UNAVAILABLE',
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

// Failures with no usable answer from the API, which the client names itself:
// - NETWORK_ERROR: no answer at all, as when the API is down or the browser blocks the request
// - TIMEOUT: no full answer in time
// - BAD_RESPONSE: an answer that isn't the API's JSON, such as a proxy's error page
export type ClientErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'BAD_RESPONSE';

export type ApiErrorCode = ServerErrorCode | ClientErrorCode;

export interface ApiErrorInit {
  // The HTTP status, or 0 when no answer arrived.
  status: number;
  code: ApiErrorCode;
  // Safe to show to the fan: the API writes its messages for them.
  message: string;
  // The seats that caused the error, such as the one just taken; empty for most errors.
  seatIds?: readonly number[];
  // The API's X-Request-Id, which finds this request in its logs.
  requestId?: string | undefined;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly seatIds: readonly number[];
  readonly requestId: string | undefined;

  constructor({ status, code, message, seatIds = [], requestId, cause }: ApiErrorInit) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.seatIds = seatIds;
    this.requestId = requestId;
  }
}
