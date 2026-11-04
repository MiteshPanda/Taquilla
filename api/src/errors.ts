import type { ErrorRequestHandler, RequestHandler } from 'express';
import { DatabaseError } from 'pg';
// Adds res.err to Express's types. Imported here because this file sets it, so it type-checks
// even when nothing else has loaded pino-http.
import type {} from 'pino-http';
import { z } from 'zod';

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'PAYMENT_DECLINED'
  | 'NOT_FOUND'
  | 'EMAIL_TAKEN'
  | 'SEAT_TAKEN'
  | 'SEAT_BUSY'
  | 'HOLD_EXPIRED'
  | 'SEAT_LOST_REFUNDED'
  | 'PAYMENT_IN_PROGRESS'
  | 'REQUEST_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'PAYMENT_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE';

export interface ErrorDetails {
  seatIds: number[];
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

// Errors raised by Express and body-parser before a handler runs carry a 4xx status.
const clientErrorSchema = z.object({
  status: z.number().int().min(400).max(499),
  type: z.string().optional(),
});

const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'The request body is not valid JSON.',
  'entity.too.large': 'The request body is too large.',
};

const SEAT_BUSY_MESSAGE = 'Those seats are busy right now. Try again in a moment.';

// The Postgres errors that mean contention rather than a bug, as requirements.md §6.4 maps them.
// Anything else from Postgres is unexpected and stays a 500.
export function mapDatabaseError(err: unknown): AppError | undefined {
  if (!(err instanceof DatabaseError)) return undefined;

  switch (err.code) {
    // Serialization failure (after the serializable strategy's retries), deadlock, lock timeout.
    case '40001':
    case '40P01':
    case '55P03':
      return new AppError(409, 'SEAT_BUSY', SEAT_BUSY_MESSAGE, undefined, { cause: err });
    case '23505':
      return mapUniqueViolation(err);
    default:
      return undefined;
  }
}

function mapUniqueViolation(err: DatabaseError): AppError | undefined {
  if (err.constraint === 'one_valid_ticket_per_seat') {
    // Postgres names the duplicate key, as in "Key (seat_id)=(42) already exists."
    const seatId = Number(/\(seat_id\)=\((\d+)\)/.exec(err.detail ?? '')?.[1]);
    return Number.isInteger(seatId)
      ? new AppError(409, 'SEAT_TAKEN', `Seat ${seatId} was just taken. Pick another seat.`, {
          seatIds: [seatId],
        })
      : new AppError(409, 'SEAT_TAKEN', 'A seat was just taken. Pick another seat.');
  }
  if (err.constraint === 'users_email_key') {
    return new AppError(
      409,
      'EMAIL_TAKEN',
      'An account with this email already exists. Log in instead.',
    );
  }
  return undefined;
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  const databaseError = mapDatabaseError(err);
  if (databaseError) return databaseError;
  const clientError = clientErrorSchema.safeParse(err);
  if (!clientError.success) return undefined;
  const message = CLIENT_ERROR_MESSAGES[clientError.data.type ?? ''] ?? 'The request is invalid.';
  return new AppError(400, 'VALIDATION_FAILED', message);
}

export const notFoundHandler: RequestHandler = () => {
  throw new AppError(404, 'NOT_FOUND', 'This route does not exist.');
};

// Express only treats a middleware as an error handler when it declares all four arguments.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  const appError = toAppError(err);
  const status = appError?.status ?? 500;

  // pino-http logs this on the request's one log line, with its stack.
  if (status >= 500) res.err = err instanceof Error ? err : new Error(String(err));

  // The response has started, so the status can't change. Cutting it off tells the client it failed.
  if (res.headersSent) {
    res.destroy();
    return;
  }

  res.status(status).json({
    error: {
      code: appError?.code ?? 'INTERNAL_ERROR',
      message: appError?.message ?? 'Something went wrong. Please try again.',
      ...appError?.details,
    },
  });
};
