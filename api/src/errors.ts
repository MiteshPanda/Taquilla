import type { ErrorRequestHandler, RequestHandler } from 'express';
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
  | 'INTERNAL_ERROR'
  | 'PAYMENT_UNAVAILABLE';

export interface ErrorDetails {
  seatIds: number[];
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
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

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
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
