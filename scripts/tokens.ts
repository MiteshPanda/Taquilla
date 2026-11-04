import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { signToken } from '../api/src/auth/tokens.js';
import { createDatabase } from '../api/src/db.js';
import { assertLocalDevelopment } from './local-only.js';
import type { LocalTarget } from './local-only.js';

// Gitignored (FR-DEV-4): the file is a login for every seeded fan.
export const TOKENS_FILE = fileURLToPath(new URL('../loadtest/tokens.json', import.meta.url));

// Only the fans `npm run reset` seeds, never an account someone signed up with.
const SEEDED_FAN = '^fan[0-9]+@taquilla\\.test$';

export interface FanToken {
  userId: number;
  token: string;
}

export interface TokenOptions extends LocalTarget {
  jwtSecret: string;
  expiresInSeconds: number;
  logger: Logger;
  outFile?: string;
}

// Signs one JWT per seeded fan, so each k6 virtual user can act as a different fan without
// logging in. Returns how many it wrote, and where.
export async function writeTokens({
  connectionString,
  nodeEnv,
  jwtSecret,
  expiresInSeconds,
  logger,
  outFile = TOKENS_FILE,
}: TokenOptions): Promise<{ count: number; outFile: string }> {
  assertLocalDevelopment({ connectionString, nodeEnv }, 'write tokens');

  const db = createDatabase({ connectionString, logger, max: 1 });
  let fans: { id: number }[];
  try {
    ({ rows: fans } = await db.pool.query<{ id: number }>(
      'SELECT id FROM users WHERE email ~ $1 ORDER BY id',
      [SEEDED_FAN],
    ));
  } finally {
    await db.close();
  }
  if (fans.length === 0) {
    throw new Error('No seeded fans found. Run npm run reset first.');
  }

  const tokens: FanToken[] = fans.map(({ id }) => ({
    userId: id,
    token: signToken(id, jwtSecret, expiresInSeconds),
  }));

  // Written beside the target, then renamed over it, so a crash never leaves half a file.
  await mkdir(path.dirname(outFile), { recursive: true });
  const partial = `${outFile}.partial`;
  await writeFile(partial, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  await rename(partial, outFile);
  return { count: tokens.length, outFile };
}
