import bcrypt from 'bcryptjs';

// Signup and the seed both hash at this cost, so every account takes as long to verify.
export const BCRYPT_COST = 12;
// bcrypt ignores everything after 72 bytes, so a longer password would match a shorter one.
export const MAX_PASSWORD_BYTES = 72;

// A cost-12 hash of a random string nobody knows. Login checks it when the email is unknown, so
// that answer takes as long as a wrong password and doesn't reveal which emails have accounts.
export const DUMMY_HASH = '$2b$12$dRqM3B8W53N2Gz80gOm1Ruui7Rcn12pmEmB5Cg.Km1DQm34YBytGy';

export function passwordBytes(password: string): number {
  return Buffer.byteLength(password, 'utf8');
}

export function hashPassword(password: string): Promise<string> {
  if (passwordBytes(password) > MAX_PASSWORD_BYTES) {
    throw new Error(`A password longer than ${MAX_PASSWORD_BYTES} bytes can't be hashed safely.`);
  }
  return bcrypt.hash(password, BCRYPT_COST);
}

// Always runs exactly one bcrypt comparison, whether or not there is a real hash to compare with.
export async function verifyPassword(password: string, hash: string | undefined): Promise<boolean> {
  const matches = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return matches && hash !== undefined && passwordBytes(password) <= MAX_PASSWORD_BYTES;
}
