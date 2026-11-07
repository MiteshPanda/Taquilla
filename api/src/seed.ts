import type { PoolClient } from 'pg';
import type { Database } from './db.js';

// Takes one hash for every fan, because hashing 1,000 times at this cost would take minutes.
export async function seedStadium(client: PoolClient, passwordHash: string): Promise<void> {
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO events (name, starts_at)
     VALUES ('Chamartín FC vs Castellana United', now() + interval '30 days')
     RETURNING id`,
  );

  // Sorted, so a seat keeps its id across resets: benchmarks and examples rely on seat 42.
  await client.query(
    `INSERT INTO seats (event_id, section, row_label, seat_no, price_paise)
     SELECT $1::int, stand.section, chr(64 + row_no), seat_no, stand.price
       FROM (VALUES (1, 'Lateral Este', 450000), (2, 'Lateral Oeste', 450000),
                    (3, 'Fondo Norte', 250000), (4, 'Fondo Sur', 250000))
              AS stand(position, section, price),
            generate_series(1, 20) AS row_no,   -- rows A to T
            generate_series(1, 25) AS seat_no   -- seats 1 to 25
      ORDER BY stand.position, row_no, seat_no`,
    [rows[0]?.id],
  );

  await client.query(
    `INSERT INTO users (email, password_hash)
     SELECT 'fan' || fan_no || '@taquilla.test', $1::text
       FROM generate_series(1, 1000) AS fan_no`,
    [passwordHash],
  );
}

// Any fixed number works: it only has to be the same for every seeder.
const SEED_LOCK_ID = 7_402_916;

// Seeds the stadium into a database with no match and no fans, and leaves any other database
// alone, so the stack can run it on every start (WP 8.1). Unlike a reset it never deletes
// anything, and a database real people use always has fans in it. Returns whether it seeded.
export async function seedIfEmpty(
  db: Pick<Database, 'withTransaction'>,
  passwordHash: string,
): Promise<boolean> {
  return db.withTransaction(async (client) => {
    // Seeders starting together take turns, so the later ones find the stadium already there.
    // Postgres releases this lock when the transaction ends.
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK_ID]);
    const { rows } = await client.query<{ empty: boolean }>(
      'SELECT NOT EXISTS (SELECT 1 FROM events) AND NOT EXISTS (SELECT 1 FROM users) AS empty',
    );
    if (rows[0]?.empty !== true) return false;
    await seedStadium(client, passwordHash);
    return true;
  });
}
