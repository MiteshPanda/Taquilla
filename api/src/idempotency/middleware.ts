import type { Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { userIdOf } from '../auth/middleware.js';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { hashRequest } from './hash.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
// Set on a replayed answer, so a client (or a test) can tell it from a fresh one.
export const REPLAYED_HEADER = 'Idempotent-Replayed';
// A key left in progress this long belongs to a request that died, so a new one may take it.
export const STALE_AFTER_SECONDS = 60;

// Visible ASCII, up to 128 characters. The provider key is pay:{orderId}:{key} and holds at
// most 255, which leaves room for 214, so this cap keeps every payment key valid.
const KEY_FORMAT = /^[\x21-\x7e]{1,128}$/;

export interface IdempotencyOptions {
  db: Pick<Database, 'pool'>;
  // The checkout requires a key (FR-PAY-1); holds take one if the client sends it (FR-IDEM-1).
  required: boolean;
}

// How a request stands with its key. The token is the claim's locked_at, read back as text so
// it keeps its microseconds: only the request holding it may save or release the key.
type Claim =
  | { kind: 'claimed'; token: string }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'reused' }
  | { kind: 'in_progress' };

interface KeyRow {
  request_hash: string;
  status: 'in_progress' | 'done';
  response_code: number | null;
  response_body: unknown;
  stale: boolean;
}

interface Scope {
  userId: number;
  key: string;
}

function parseKey(header: string | undefined, required: boolean): string | undefined {
  if (header === undefined) {
    if (!required) return undefined;
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Send an Idempotency-Key header with this request.',
    );
  }
  if (!KEY_FORMAT.test(header)) {
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'The Idempotency-Key header must be 1 to 128 visible ASCII characters, such as a UUID.',
    );
  }
  return header;
}

// Exactly one INSERT wins a new key; everyone else reads what it holds. A loop, because the
// row can change between the two statements: a failed request releases it, or a stale one is
// re-claimed by someone else.
async function claim(pool: Pool, { userId, key }: Scope, hash: string): Promise<Claim> {
  for (let look = 0; look < 3; look += 1) {
    const inserted = await pool.query<{ token: string }>(
      `INSERT INTO idempotency_keys (user_id, idem_key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING locked_at::text AS token`,
      [userId, key, hash],
    );
    if (inserted.rows[0]) return { kind: 'claimed', token: inserted.rows[0].token };

    const { rows } = await pool.query<KeyRow>(
      `SELECT request_hash, status, response_code, response_body,
              locked_at < now() - make_interval(secs => $3) AS stale
         FROM idempotency_keys
        WHERE user_id = $1 AND idem_key = $2`,
      [userId, key, STALE_AFTER_SECONDS],
    );
    const existing = rows[0];
    // Released by a failed request since the INSERT; try to claim it again.
    if (!existing) continue;
    if (existing.request_hash !== hash) return { kind: 'reused' };
    if (existing.status === 'done') {
      return {
        kind: 'replay',
        status: existing.response_code ?? 500,
        body: existing.response_body,
      };
    }
    if (!existing.stale) return { kind: 'in_progress' };

    // FR-IDEM-7: the request holding this key died, so this one takes it over.
    const reclaimed = await pool.query<{ token: string }>(
      `UPDATE idempotency_keys SET locked_at = now()
        WHERE user_id = $1 AND idem_key = $2 AND status = 'in_progress'
          AND locked_at < now() - make_interval(secs => $3)
       RETURNING locked_at::text AS token`,
      [userId, key, STALE_AFTER_SECONDS],
    );
    if (reclaimed.rows[0]) return { kind: 'claimed', token: reclaimed.rows[0].token };
  }
  return { kind: 'in_progress' };
}

function errorCode(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const { error } = body;
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

// An answer that asks the client to try again is not the request's outcome, so the key is
// released instead of saved: any 5xx (FR-IDEM-6), and 409 SEAT_BUSY, whose message says the
// same. Saving it would replay "try again" to every retry.
function releasesKey(status: number, body: unknown): boolean {
  return status >= 500 || (status === 409 && errorCode(body) === 'SEAT_BUSY');
}

// Saves or releases the key, but only while this request still holds it. If it went stale and
// another request re-claimed it, that request's answer is the one to keep.
async function settle(
  pool: Pool,
  { userId, key }: Scope,
  token: string,
  status: number,
  body: unknown,
): Promise<boolean> {
  const result = releasesKey(status, body)
    ? await pool.query(
        `DELETE FROM idempotency_keys
          WHERE user_id = $1 AND idem_key = $2 AND status = 'in_progress'
            AND locked_at = $3::timestamptz`,
        [userId, key, token],
      )
    : await pool.query(
        `UPDATE idempotency_keys
            SET status = 'done', response_code = $4, response_body = $5::jsonb
          WHERE user_id = $1 AND idem_key = $2 AND status = 'in_progress'
            AND locked_at = $3::timestamptz`,
        [userId, key, token, status, JSON.stringify(body)],
      );
  return result.rowCount === 1;
}

// Sends the answer only after it is saved, so a client that saw it can always get it again.
// If saving fails, the answer still goes out: the fan's outcome matters more than the replay,
// and the key goes stale after a minute, so a retry can then run the request again.
function saveBeforeSending(req: Request, res: Response, pool: Pool, scope: Scope, token: string) {
  const send = res.json.bind(res);
  res.json = (body: unknown) => {
    res.json = send;
    const status = res.statusCode;
    settle(pool, scope, token, status, body)
      .then((kept) => {
        if (!kept) {
          req.log.warn(
            { idempotencyKey: scope.key },
            'idempotency key was re-claimed by a newer request; this answer is not saved',
          );
        }
      })
      .catch((err: unknown) => {
        req.log.error({ err, idempotencyKey: scope.key }, 'could not save the idempotency key');
      })
      .finally(() => {
        send(body);
      });
    return res;
  };
}

// Makes a POST safe to repeat (FR-IDEM-1 to FR-IDEM-7). Mount it after requireAuth, because
// keys belong to a fan (FR-IDEM-2), and only on routes that answer with res.json.
export function idempotency({ db, required }: IdempotencyOptions): RequestHandler {
  return async (req, res, next) => {
    const key = parseKey(req.get(IDEMPOTENCY_KEY_HEADER), required);
    if (key === undefined) {
      next();
      return;
    }

    const scope = { userId: userIdOf(req), key };
    const path = req.originalUrl.split('?', 1)[0] ?? req.originalUrl;
    const result = await claim(db.pool, scope, hashRequest(req.method, path, req.body));

    switch (result.kind) {
      case 'replay':
        res.setHeader(REPLAYED_HEADER, 'true');
        res.status(result.status).json(result.body);
        return;
      case 'reused':
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request. Use a new key.',
        );
      case 'in_progress':
        throw new AppError(
          409,
          'REQUEST_IN_PROGRESS',
          'This request is still being processed. Try again in a moment with the same key.',
        );
      case 'claimed':
        saveBeforeSending(req, res, db.pool, scope, result.token);
        next();
    }
  };
}
