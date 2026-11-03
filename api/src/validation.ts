import type { z } from 'zod';
import { AppError } from './errors.js';

// Throws a 400 with the first problem's message, which each schema writes for the fan to read.
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'The request is invalid.';
    throw new AppError(400, 'VALIDATION_FAILED', message, undefined, { cause: result.error });
  }
  return result.data;
}
