import type { ErrorRequestHandler, RequestHandler } from 'express';
// Adds res.err to Express's types, which this file sets.
import type {} from 'pino-http';
import { z } from 'zod';

// The mock answers in the API's error shape (requirements.md §6.2), with codes of its own.
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'CHARGE_DECLINED'
  | 'INTERNAL_ERROR';

export class MockError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MockError';
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

function toMockError(err: unknown): MockError | undefined {
  if (err instanceof MockError) return err;
  const clientError = clientErrorSchema.safeParse(err);
  if (!clientError.success) return undefined;
  const message = CLIENT_ERROR_MESSAGES[clientError.data.type ?? ''] ?? 'The request is invalid.';
  return new MockError(400, 'VALIDATION_FAILED', message);
}

export const notFoundHandler: RequestHandler = () => {
  throw new MockError(404, 'NOT_FOUND', 'This route does not exist.');
};

// Express only treats a middleware as an error handler when it declares all four arguments.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  const mockError = toMockError(err);
  const status = mockError?.status ?? 500;

  // pino-http logs this on the request's one log line, with its stack.
  if (status >= 500) res.err = err instanceof Error ? err : new Error(String(err));

  if (res.headersSent) {
    res.destroy();
    return;
  }

  res.status(status).json({
    error: {
      code: mockError?.code ?? 'INTERNAL_ERROR',
      message: mockError?.message ?? 'Something went wrong. Please try again.',
    },
  });
};
