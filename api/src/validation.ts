import { z } from 'zod';
import { AppError } from './errors.js';

// The largest Postgres INT. A bigger id is refused here instead of failing inside a query.
export const MAX_INT = 2_147_483_647;

// A route parameter that names a row by its INT id.
export const databaseId = z
  .string()
  .regex(/^[1-9]\d{0,9}$/)
  .transform(Number)
  .refine((id) => id <= MAX_INT);

// Throws a 400 with the first problem's message, which each schema writes for the fan to read.
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'The request is invalid.';
    throw new AppError(400, 'VALIDATION_FAILED', message, undefined, { cause: result.error });
  }
  return result.data;
}
