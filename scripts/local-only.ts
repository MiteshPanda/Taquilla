import { Client } from 'pg';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface LocalTarget {
  connectionString: string;
  nodeEnv: string;
}

// Throws unless this runs outside production against a database on this machine. For scripts that
// wipe data or mint logins, where pointing at the wrong database would be a disaster.
export function assertLocalDevelopment(
  { connectionString, nodeEnv }: LocalTarget,
  action: string,
): void {
  if (nodeEnv === 'production') {
    throw new Error(`Refusing to ${action}: NODE_ENV is production.`);
  }
  // Ask pg rather than parse the URL, because a ?host= setting overrides the URL's host part.
  const { host } = new Client({ connectionString });
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to ${action}: the database host ${host} is not local.`);
  }
}
