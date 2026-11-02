import { z } from 'zod';

const corsOrigins = z
  .string()
  .default('http://localhost:5173')
  .transform((value) => value.split(',').map((origin) => origin.trim()))
  .pipe(
    z.array(
      // An origin with a path or trailing slash would never match a browser's Origin header.
      z.string().refine((origin) => URL.parse(origin)?.origin === origin, {
        error: 'must be a bare origin, such as https://example.com',
      }),
    ),
  );

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: corsOrigins,
  DATABASE_URL: z
    .url({ protocol: /^postgres(ql)?$/ })
    .default('postgres://taquilla:taquilla@localhost:5432/taquilla'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JWT_SECRET: z.string().min(32),
  BOOKING_STRATEGY: z.enum(['lock', 'cas', 'serializable']).default('lock'),
  HOLD_SECONDS: z.coerce.number().int().positive().default(300),
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  PAYMENTS_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:4000'),
  DECLINE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  LOST_RESPONSE_RATE: z.coerce.number().min(0).max(1).default(0.02),
  SEED_PASSWORD: z.string().min(8).default('taquilla-dev'),
  RACE_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
});

// A migration job has no use for the API's secrets, so it must not need them to start.
const migrateConfigSchema = configSchema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
});

const resetConfigSchema = configSchema.pick({
  NODE_ENV: true,
  LOG_LEVEL: true,
  DATABASE_URL: true,
  SEED_PASSWORD: true,
});

export type Config = z.infer<typeof configSchema>;
export type MigrateConfig = z.infer<typeof migrateConfigSchema>;
export type ResetConfig = z.infer<typeof resetConfigSchema>;

// A blank line in .env means "not set": the default applies, or a required variable fails.
function withoutBlanks(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
}

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  return configSchema.parse(withoutBlanks(env));
}

export function parseMigrateConfig(env: NodeJS.ProcessEnv): MigrateConfig {
  return migrateConfigSchema.parse(withoutBlanks(env));
}

export function parseResetConfig(env: NodeJS.ProcessEnv): ResetConfig {
  return resetConfigSchema.parse(withoutBlanks(env));
}

export function loadConfig(): Config {
  return loadOrExit(parseConfig);
}

export function loadMigrateConfig(): MigrateConfig {
  return loadOrExit(parseMigrateConfig);
}

export function loadResetConfig(): ResetConfig {
  return loadOrExit(parseResetConfig);
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
