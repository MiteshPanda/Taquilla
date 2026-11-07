import { useCallback, useRef, useState } from 'react';
import type { ApiClient, Hold, Order, Seat } from '../api/client.js';
import { ApiError } from '../api/errors.js';
import { payHold } from '../checkout/pay.js';
import type { PayOptions } from '../checkout/pay.js';
import { describeSeats, formatPrice } from '../seats/seats.js';
import { Countdown } from './Countdown.js';
import {
  ALREADY_ENDED,
  DECLINED,
  EXPIRED,
  HOLD_GONE,
  HOLD_RAN_OUT,
  PAYING,
  RELEASED,
  SEATS_LOST_REFUNDED,
  STILL_GOING,
  TEST_PAYMENT,
  UNAVAILABLE,
  UNCONFIRMED,
  UNEXPECTED,
} from './messages.js';
import type { Notice } from './messages.js';

// Once a payment attempt reaches Reserve, the API keeps the seats for at least 10 minutes from
// then (FR-PAY-5), whatever the hold had left.
export const RESERVE_MS = 10 * 60_000;

type Step = 'hold' | 'pay' | 'paying' | 'paid';

// No answer at all, or one the API would give differently next time.
function unconfirmed(err: ApiError): boolean {
  return err.status === 0 || err.status >= 500 || err.code === 'BAD_RESPONSE';
}

export interface HoldPanelProps {
  api: ApiClient;
  token: string;
  hold: Hold;
  // The hold's seats, from the map.
  seats: readonly Seat[];
  newKey: () => string;
  refresh: () => void;
  // The hold is over: expired, released, gone, or paid and put away. The notice, if any, is what
  // the fan is told next.
  onEnd: (notice: Notice | null) => void;
  wait?: PayOptions['wait'];
}

// One hold, from the countdown to the paid tickets: release it, or open the payment step and pay.
export function HoldPanel({
  api,
  token,
  hold,
  seats,
  newKey,
  refresh,
  onEnd,
  wait,
}: HoldPanelProps) {
  const [step, setStep] = useState<Step>('hold');
  const [expiresAt, setExpiresAt] = useState(hold.expiresAt);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [releasing, setReleasing] = useState(false);
  // FR-WEB-3: one key per payment attempt, made when the payment step first opens, kept for every
  // retry (a lost answer, a 503, a 409 REQUEST_IN_PROGRESS), and replaced only after a decline.
  const payKey = useRef<string | null>(null);
  // Set the moment Pay is pressed, so a second click before the page redraws sends nothing.
  const paying = useRef(false);

  const onExpire = useCallback(() => {
    refresh();
    onEnd({ role: 'status', text: EXPIRED });
  }, [refresh, onEnd]);

  function openPayment() {
    payKey.current ??= newKey();
    setNotice(null);
    setStep('pay');
  }

  // A decline or an outage proves Reserve ran, so the seats are the fan's for a while longer.
  function keptByReserve() {
    setExpiresAt((current) =>
      new Date(Math.max(Date.parse(current), Date.now() + RESERVE_MS)).toISOString(),
    );
  }

  function stay(next: Notice) {
    setNotice(next);
    setStep('pay');
  }

  async function pay() {
    if (paying.current) return;
    paying.current = true;
    payKey.current ??= newKey();
    const key = payKey.current;
    setNotice(null);
    setStep('paying');
    try {
      const paid = await payHold(api, hold.holdId, token, key, { wait });
      setOrder(paid);
      setStep('paid');
    } catch (err) {
      if (!(err instanceof ApiError)) {
        stay({ role: 'alert', text: UNEXPECTED });
        return;
      }
      switch (err.code) {
        case 'PAYMENT_DECLINED':
          // The one case for a new key: that attempt is over, and the next is a new one.
          payKey.current = newKey();
          keptByReserve();
          stay({ role: 'alert', text: DECLINED });
          break;
        case 'PAYMENT_UNAVAILABLE':
          keptByReserve();
          stay({ role: 'alert', text: UNAVAILABLE });
          break;
        case 'REQUEST_IN_PROGRESS':
          stay({ role: 'status', text: STILL_GOING });
          break;
        case 'HOLD_EXPIRED':
          onEnd({ role: 'alert', text: HOLD_RAN_OUT });
          break;
        case 'SEAT_LOST_REFUNDED':
          onEnd({ role: 'alert', text: SEATS_LOST_REFUNDED });
          break;
        case 'NOT_FOUND':
          onEnd({ role: 'alert', text: HOLD_GONE });
          break;
        case 'IDEMPOTENCY_KEY_REUSED':
          payKey.current = newKey();
          stay({ role: 'alert', text: err.message });
          break;
        default:
          stay({ role: 'alert', text: unconfirmed(err) ? UNCONFIRMED : err.message });
      }
    } finally {
      paying.current = false;
      refresh();
    }
  }

  async function release() {
    setReleasing(true);
    setNotice(null);
    try {
      await api.releaseHold(hold.holdId, token);
      onEnd({ role: 'status', text: RELEASED });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        onEnd({ role: 'status', text: ALREADY_ENDED });
      } else {
        setNotice({ role: 'alert', text: err instanceof ApiError ? err.message : UNEXPECTED });
        setReleasing(false);
      }
    } finally {
      refresh();
    }
  }

  if (step === 'paid' && order !== null) {
    return (
      <>
        <p className="paid" role="status">
          Paid {formatPrice(order.amountPaise)}. Your tickets:
        </p>
        <ul className="tickets">
          {order.tickets.map((ticket) => (
            <li key={ticket.id} className="ticket">
              <span className="ticket-stand">{ticket.section}</span>{' '}
              <span className="ticket-seat">
                Row {ticket.row}, seat {ticket.number}
              </span>{' '}
              <span className="ticket-price">{formatPrice(ticket.pricePaise)}</span>
            </li>
          ))}
        </ul>
        <p className="order-id">Order {order.orderId}</p>
        <div className="actions">
          <button type="button" onClick={() => onEnd(null)}>
            Pick more seats
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {notice !== null && (
        <p className={`hold-notice hold-notice-${notice.role}`} role={notice.role}>
          {notice.text}
        </p>
      )}
      <div className="stub-line">
        <p className="stub-seats">You're holding {describeSeats(seats)}</p>
        <p className="stub-figure">{formatPrice(hold.amountPaise)}</p>
      </div>
      {step === 'paying' ? (
        <p className="paying" role="status">
          {PAYING}
        </p>
      ) : (
        <Countdown expiresAt={expiresAt} onExpire={onExpire} />
      )}
      {step === 'hold' ? (
        <div className="actions">
          <button type="button" onClick={openPayment}>
            Check out
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void release()}
            disabled={releasing}
          >
            {releasing ? 'Releasing…' : 'Release'}
          </button>
        </div>
      ) : (
        <div className="payment" role="group" aria-label="Payment">
          <p className="test-payment">{TEST_PAYMENT}</p>
          <div className="actions">
            <button type="button" onClick={() => void pay()} disabled={step === 'paying'}>
              {step === 'paying' ? 'Paying…' : `Pay ${formatPrice(hold.amountPaise)}`}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setStep('hold')}
              disabled={step === 'paying'}
            >
              Back
            </button>
          </div>
        </div>
      )}
    </>
  );
}
