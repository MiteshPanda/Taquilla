import type { PoolClient } from 'pg';

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
