import { z } from 'zod';

export const DEFAULT_API_URL = 'http://localhost:3000';
// SEED_PASSWORD's default, which every seeded fan has.
export const DEFAULT_DEMO_PASSWORD = 'taquilla-dev';

const configSchema = z.object({
  // Vite bakes this into the build, so a new address means a new build.
  VITE_API_URL: z
    .url({ protocol: /^https?$/ })
    .default(DEFAULT_API_URL)
    // The client adds each path to it, so a query or fragment would end up in the wrong place.
    .refine((value) => !/[?#]/.test(value), { error: 'must have no query or fragment' })
    .transform((value) => value.replace(/\/+$/, '')),
  // The seeded fans' password (SEED_PASSWORD), for "Log in as demo fan". It ends up in the page
  // for anyone to read, which is fine only because those accounts exist to be shared.
  VITE_DEMO_PASSWORD: z.string().min(8).default(DEFAULT_DEMO_PASSWORD),
});

export interface WebConfig {
  // The API's address with no trailing slash, such as http://localhost:3000.
  apiUrl: string;
  demoPassword: string;
}

export function parseWebConfig(env: Record<string, unknown>): WebConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid web configuration:\n${z.prettifyError(result.error)}`);
  }
  return { apiUrl: result.data.VITE_API_URL, demoPassword: result.data.VITE_DEMO_PASSWORD };
}
