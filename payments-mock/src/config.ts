import { z } from 'zod';

// The mock shares .env with the API, so its port has its own name: PORT is the API's.
const variables = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default('postgres://taquilla:taquilla@localhost:5432/taquilla'),
  PAYMENTS_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  // Fault injection (FR-MOCK-5). Each one only ever hits a key's first attempt.
  DECLINE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  LOST_RESPONSE_RATE: z.coerce.number().min(0).max(1).default(0.02),
  LATENCY_MIN_MS: z.coerce.number().int().min(0).max(60_000).default(100),
  LATENCY_MAX_MS: z.coerce.number().int().min(0).max(60_000).default(800),
});

const configSchema = variables.refine((config) => config.LATENCY_MIN_MS <= config.LATENCY_MAX_MS, {
  error: 'must not be below LATENCY_MIN_MS',
  path: ['LATENCY_MAX_MS'],
});

// Creating the schema needs only the database.
const migrateConfigSchema = variables.pick({ LOG_LEVEL: true, DATABASE_URL: true });

export type Config = z.infer<typeof configSchema>;
export type MigrateConfig = z.infer<typeof migrateConfigSchema>;

// A blank line in .env means "not set", so the default applies.
function withoutBlanks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return configSchema.parse(withoutBlanks(env));
}

export function parseMigrateConfig(env: NodeJS.ProcessEnv): MigrateConfig {
  return migrateConfigSchema.parse(withoutBlanks(env));
}

export function loadConfig(): Config {
  return loadOrExit(parseConfig);
}

export function loadMigrateConfig(): MigrateConfig {
  return loadOrExit(parseMigrateConfig);
}

function loadOrExit<T>(parse: (env: NodeJS.ProcessEnv) => T): T {
  try {
    return parse(process.env);
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error(`Invalid environment variables:\n${z.prettifyError(err)}`);
      process.exit(1);
    }
    throw err;
  }
}
