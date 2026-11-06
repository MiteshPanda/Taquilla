import { z } from 'zod';

export const DEFAULT_API_URL = 'http://localhost:3000';

const configSchema = z.object({
  // Vite bakes this into the build, so a new address means a new build.
  VITE_API_URL: z
    .url({ protocol: /^https?$/ })
    .default(DEFAULT_API_URL)
    // The client adds each path to it, so a query or fragment would end up in the wrong place.
    .refine((value) => !/[?#]/.test(value), { error: 'must have no query or fragment' })
    .transform((value) => value.replace(/\/+$/, '')),
});

export interface WebConfig {
  // The API's address with no trailing slash, such as http://localhost:3000.
  apiUrl: string;
}

export function parseWebConfig(env: Record<string, unknown>): WebConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid web configuration:\n${z.prettifyError(result.error)}`);
  }
  return { apiUrl: result.data.VITE_API_URL };
}
