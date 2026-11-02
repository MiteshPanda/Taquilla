// The taquilla_test database from docker-compose.yml. Start it with: docker compose up -d postgres
export const TEST_DATABASE_URL = 'postgres://taquilla:taquilla@localhost:5432/taquilla_test';

// Nothing listens on this port, so a connection is refused at once, as when the database is down.
export const DOWN_DATABASE_URL = 'postgres://taquilla:taquilla@127.0.0.1:1/taquilla_test';
