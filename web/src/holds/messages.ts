import { MAX_HOLD_SEATS } from '../seats/seats.js';

// What the page says about picks, holds and payments, in one place so tests check the same words.

export interface Notice {
  // An alert interrupts a screen reader; a status waits its turn.
  role: 'alert' | 'status';
  text: string;
}

export const FULL = `You can hold up to ${MAX_HOLD_SEATS} seats at once.`;
export const UNEXPECTED = 'Something went wrong. Please try again.';

export const RELEASED = 'Released. Those seats are free again.';
export const ALREADY_ENDED = 'That hold had already ended, so its seats are free again.';
export const EXPIRED =
  'Your hold expired, so its seats are free again. Pick seats to hold them again.';

// The payment step (FR-WEB-3). The API's own messages for these speak to developers, naming
// the Idempotency-Key and seat ids, so the page says them its own way.
export const PAYING = 'Paying… Keep this tab open.';
export const TEST_PAYMENT = 'This is a test payment: no real money moves.';
export const DECLINED = 'Your payment was declined, so nothing was charged. You can try again.';
export const UNAVAILABLE =
  "The payment provider isn't answering. Try again in a moment; you won't be charged twice.";
export const STILL_GOING =
  "Your payment is still going through. Try again in a moment; you won't be charged twice.";
export const UNCONFIRMED =
  "We couldn't confirm your payment. Try again; you won't be charged twice.";
export const HOLD_RAN_OUT =
  "Your hold ran out before you paid, so you weren't charged. Pick seats to hold them again.";
export const SEATS_LOST_REFUNDED =
  'Your seats were taken while you were paying, so your payment was refunded. Pick seats again.';
export const HOLD_GONE = "That hold has ended, so you weren't charged. Pick seats again.";
