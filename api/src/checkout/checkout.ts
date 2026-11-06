import type { Logger } from 'pino';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { describeSeats } from '../holds/shared.js';
import { confirm, markDeclined, markRefunded, ticketsOf } from './confirm.js';
import type { PaymentRef, Ticket } from './confirm.js';
import type { Order } from './order.js';
import type { PaymentClient } from './payment-client.js';
import { reserve } from './reserve.js';

export interface CheckoutDeps {
  db: Pick<Database, 'pool' | 'withTransaction'>;
  payments: PaymentClient;
}

export interface CheckoutRequest {
  holdId: string;
  userId: number;
  clientKey: string;
  logger: Logger;
  requestId?: string;
}

// The 200 answer: a paid order and its tickets.
export interface PaidOrder {
  orderId: string;
  holdId: string;
  status: 'paid';
  amountPaise: number;
  tickets: Ticket[];
}

function paidOrder(order: Order, tickets: Ticket[]): PaidOrder {
  return {
    orderId: order.id,
    holdId: order.holdId,
    status: 'paid',
    amountPaise: order.amountPaise,
    tickets,
  };
}

function unavailable(): AppError {
  return new AppError(
    503,
    'PAYMENT_UNAVAILABLE',
    "The payment provider isn't answering. Try again in a moment with the same Idempotency-Key; you won't be charged twice.",
  );
}

function seatsLostRefunded(lost: number[]): AppError {
  const subject = lost.length > 0 ? describeSeats(lost) : 'Your seats';
  const verb = lost.length === 1 ? 'was' : 'were';
  return new AppError(
    409,
    'SEAT_LOST_REFUNDED',
    `${subject} ${verb} taken while you were paying, so the charge was refunded. Pick your seats again.`,
    lost.length > 0 ? { seatIds: lost } : undefined,
  );
}

// POST /holds/:id/checkout (FR-PAY-3): Reserve in one transaction, Charge with no transaction
// open, Confirm in one transaction. A lock is never held across the provider call.
export async function checkout(
  { db, payments }: CheckoutDeps,
  { holdId, userId, clientKey, logger, requestId }: CheckoutRequest,
): Promise<PaidOrder> {
  const reserved = await reserve(db, { holdId, userId, clientKey });
  if (reserved.kind === 'paid') {
    return paidOrder(reserved.order, await ticketsOf(db.pool, reserved.order.id));
  }
  const payment: PaymentRef = { order: reserved.order, paymentKey: reserved.paymentKey };
  const { order, paymentKey } = payment;

  const charged = await payments.charge(
    { key: paymentKey, orderId: order.id, amountPaise: order.amountPaise },
    { logger, requestId },
  );
  switch (charged.status) {
    // The order stays paying under this key, so a retry with the same key resumes (FR-PAY-12).
    case 'unavailable':
      throw unavailable();
    case 'declined':
      await markDeclined(db, payment);
      logger.info({ orderId: order.id }, 'payment declined');
      throw new AppError(
        402,
        'PAYMENT_DECLINED',
        'Your payment was declined. Try again with a new Idempotency-Key, or use another card.',
      );
    // An earlier attempt with this key refunded the charge, then crashed before recording it.
    case 'refunded':
      await markRefunded(db, payment);
      throw seatsLostRefunded([]);
    case 'succeeded':
      break;
  }

  const confirmed = await confirm(db, payment);
  if (confirmed.kind === 'paid') {
    logger.info(
      { orderId: order.id, amountPaise: order.amountPaise, tickets: confirmed.tickets.length },
      'order paid',
    );
    return paidOrder(confirmed.order, confirmed.tickets);
  }

  // The seats went while the provider was charging (FR-PAY-9): give the money back.
  logger.warn({ orderId: order.id, lost: confirmed.lost }, 'seats lost after charging, refunding');
  const refund = await payments.refund(paymentKey, { logger, requestId });
  // Still paying: a retry with the same key gets the charge back, finds the seats lost again
  // and repeats the refund, which the provider makes safe to repeat.
  if (refund.status === 'unavailable') throw unavailable();
  await markRefunded(db, payment);
  throw seatsLostRefunded(confirmed.lost);
}
