// The taquilla_test database from docker-compose.yml. Start it with: docker compose up -d postgres
export const TEST_DATABASE_URL = 'postgres://taquilla:taquilla@localhost:5432/taquilla_test';

// A connection confined to one schema, so a test can start empty without touching the real tables.
export function schemaConnectionString(schema: string): string {
  return `${TEST_DATABASE_URL}?options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

// Nothing listens on this port, so a connection is refused at once, as when the database is down.
export const DOWN_DATABASE_URL = 'postgres://taquilla:taquilla@127.0.0.1:1/taquilla_test';
