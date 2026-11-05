import type { Database } from '../db.js';
import { AppError } from '../errors.js';

export interface ReleaseRequest {
  holdId: string;
  userId: number;
}

// Frees a fan's hold early (FR-HOLD-8). Safe to repeat: a second release finds nothing left to
// free and changes nothing.
export function releaseHold(
  db: Pick<Database, 'withTransaction'>,
  { holdId, userId }: ReleaseRequest,
): Promise<void> {
  return db.withTransaction(async (client) => {
    // Someone else's hold answers exactly like one that doesn't exist, so ids can't be probed
    // (FR-AUTH-3).
    const { rowCount } = await client.query('SELECT 1 FROM holds WHERE id = $1 AND user_id = $2', [
      holdId,
      userId,
    ]);
    if (rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'This hold does not exist.');
    }

    // Seats first, in ascending id order, then the hold: the same order checkout uses, so the
    // two can never deadlock (ADR 3).
    await client.query('SELECT 1 FROM seats WHERE hold_id = $1 ORDER BY id FOR UPDATE', [holdId]);

    // Only seats this hold still has. One whose hold lapsed may already belong to another fan,
    // and a sold seat no longer points at any hold.
    await client.query(
      `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
        WHERE hold_id = $1 AND status = 'held'`,
      [holdId],
    );

    // A converted hold has been paid for, so it stays converted.
    await client.query(`UPDATE holds SET status = 'released' WHERE id = $1 AND status = 'active'`, [
      holdId,
    ]);
  });
}
