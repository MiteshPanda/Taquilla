import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { findCharge, insertCharge, refundCharge } from './charges.js';
import type { Charge, Queryable } from './charges.js';
import { MockError } from './errors.js';
import type { Faults } from './faults.js';

// The largest Postgres INT, the amount column's type.
const MAX_INT = 2_147_483_647;

// Visible ASCII only: a key is logged and sits in the refund URL, so it can't hold spaces or controls.
const chargeKey = z.string().regex(/^[\x21-\x7e]{1,255}$/);

const chargeBody = z.strictObject(
  {
    orderId: z.uuid({ error: 'orderId must be a UUID.' }),
    amountPaise: z
      .number({ error: 'amountPaise must be a whole number of paise.' })
      .int({ error: 'amountPaise must be a whole number of paise.' })
      .positive({ error: 'amountPaise must be greater than zero.' })
      .max(MAX_INT, { error: 'amountPaise is too large.' }),
  },
  { error: 'The body must hold only orderId and amountPaise.' },
);

type ChargeBody = z.output<typeof chargeBody>;

function parseKey(header: string | undefined): string {
  if (header === undefined) {
    throw new MockError(400, 'VALIDATION_FAILED', 'The Idempotency-Key header is required.');
  }
  if (!chargeKey.safeParse(header).success) {
    throw new MockError(
      400,
      'VALIDATION_FAILED',
      'The Idempotency-Key header must be 1 to 255 visible ASCII characters.',
    );
  }
  return header;
}

function parseBody(body: unknown): ChargeBody {
  const result = chargeBody.safeParse(body);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'The request is invalid.';
    throw new MockError(400, 'VALIDATION_FAILED', message, { cause: result.error });
  }
  return result.data;
}

// A repeated key gets its original charge back (FR-MOCK-2), unless it now describes another one.
function replay(res: Response, charge: Charge, body: ChargeBody): void {
  if (charge.orderId !== body.orderId || charge.amountPaise !== body.amountPaise) {
    throw new MockError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This key belongs to a charge with a different order or amount.',
    );
  }
  res.log.debug({ chargeId: charge.id, key: charge.key }, 'charge replayed');
  res.status(200).json(charge);
}

export interface ChargesRouterOptions {
  db: Queryable;
  faults: Faults;
}

export function createChargesRouter({ db, faults }: ChargesRouterOptions): Router {
  const router = Router();

  // 201 with a new charge, succeeded or declined; 200 with the original one for a repeated key.
  router.post('/charges', async (req, res) => {
    const key = parseKey(req.get('Idempotency-Key'));
    const body = parseBody(req.body);

    // A retry skips every fault, so the client's retries always get through (FR-MOCK-5).
    const existing = await findCharge(db, key);
    if (existing) {
      replay(res, existing, body);
      return;
    }

    await faults.delay();
    const status = faults.decline() ? 'declined' : 'succeeded';
    const charge = await insertCharge(db, { key, ...body, status });
    if (!charge) {
      // Another first attempt with this key recorded its charge while this one waited.
      const winner = await findCharge(db, key);
      if (!winner) throw new Error(`Charge ${key} conflicted on insert but can't be found.`);
      replay(res, winner, body);
      return;
    }

    res.log.info(
      {
        chargeId: charge.id,
        key,
        orderId: charge.orderId,
        amountPaise: charge.amountPaise,
        status,
      },
      'charge recorded',
    );

    if (faults.loseResponse()) {
      // The charge is already committed, so the client can't tell this from a network failure.
      // Its retry with the same key finds the charge and gets it back.
      res.log.warn(
        { chargeId: charge.id, key },
        'response dropped on purpose (LOST_RESPONSE_RATE)',
      );
      req.socket.destroy();
      return;
    }

    res.status(201).json(charge);
  });

  // Safe to call twice: a refunded charge is returned as it is (FR-MOCK-4).
  router.post('/charges/:key/refund', async (req, res) => {
    const noCharge = new MockError(404, 'NOT_FOUND', 'No charge has this key.');
    // A key the charge route would refuse can't have a charge.
    const parsed = chargeKey.safeParse(req.params.key);
    if (!parsed.success) throw noCharge;
    const key = parsed.data;

    const refunded = await refundCharge(db, key);
    if (refunded) {
      res.log.info({ chargeId: refunded.id, key }, 'charge refunded');
      res.json(refunded);
      return;
    }

    const charge = await findCharge(db, key);
    if (!charge) throw noCharge;
    if (charge.status === 'declined') {
      throw new MockError(
        409,
        'CHARGE_DECLINED',
        'This charge was declined, so there is nothing to refund.',
      );
    }
    res.json(charge);
  });

  return router;
}
