// Sellout (NFR-1, INV-1 to INV-3): 1,000 virtual users run 10,000 hold-then-checkout journeys
// over the 2,000 seats, 70% of them aimed at the Lateral stands, until the stadium is sold out.
// The run passes on its thresholds; the verdict on correctness is the audit straight after.
//
//   npm run reset && npm run tokens      # a clean stadium and a token per fan
//   k6 run loadtest/sellout.js           # needs the API and the payment mock running
//   npm run audit                        # must exit with code 0
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const tokens = new SharedArray('tokens', () =>
  JSON.parse(open('./tokens.json')).map((fan) => fan.token),
);

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const VUS = Number(__ENV.VUS || 1000);
const JOURNEYS = Number(__ENV.JOURNEYS || 10000);
// See hot-seat.js: spreads each virtual user's first connection over this window.
const STAGGER_MS = Number(__ENV.STAGGER_MS || 1000);
// A fan who finds their seats taken picks again, a few times, before giving up.
const HOLD_TRIES = 3;
// A decline is followed by a new attempt with a new key, as the page does (FR-WEB-3).
const PAY_ATTEMPTS = 3;
// A 503 is retried with the same key: the provider key is the same, so it can't charge twice.
const SAME_KEY_RETRIES = 5;
// Keys only need to be unique per fan, so this tells apart runs on a database that wasn't reset.
const RUN = Date.now().toString(36);

// Seat ids run stand by stand and row by row: 25 seats a row, 20 rows a stand. Ids 1 to 1,000 are
// Lateral Este and Oeste, 1,001 to 2,000 Fondo Norte and Sur.
const SEATS_PER_ROW = 25;
const LATERAL = { first: 1, rows: 40 };
const FONDO = { first: 1001, rows: 40 };
const LATERAL_SHARE = 0.7;
// How many seats a fan wants: mostly pairs.
const PARTY_SIZES = [1, 1, 2, 2, 2, 2, 2, 3, 4, 4];

const holdsWon = new Counter('holds_won');
const seatsTaken = new Counter('hold_attempts_taken');
// SEAT_BUSY: a lock wait timed out or a serializable transaction ran out of retries.
const seatsBusy = new Counter('hold_attempts_busy');
const leftWithoutSeats = new Counter('journeys_without_seats');
const ordersPaid = new Counter('orders_paid');
const seatsSold = new Counter('seats_sold');
const declines = new Counter('payments_declined');
const sameKeyRetries = new Counter('same_key_retries');
const lostAtCheckout = new Counter('checkouts_refused');

// 409 (seat taken, payment in progress, hold expired) and 402 (declined) are answers the API is
// meant to give under contention. Anything else, a 5xx or a timeout above all, is a failure.
http.setResponseCallback(http.expectedStatuses(200, 201, 402, 409));

export const options = {
  scenarios: {
    sellout: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: JOURNEYS,
      maxDuration: '10m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'], // NFR-4: under 0.1% unexpected failures
    checks: ['rate==1'], // every answer is one the API documents
    orders_paid: ['count>0'],
    // Ceilings, not targets: a checkout includes the provider's 100–800 ms on purpose. They make
    // k6 report each step's latency on its own.
    'http_req_duration{step:hold}': ['p(95)<10000'],
    'http_req_duration{step:checkout}': ['p(95)<20000'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function randomInt(below) {
  return Math.floor(Math.random() * below);
}

// Adjacent seats in one row, in the Lateral stands 70% of the time.
function pickSeats() {
  const stand = Math.random() < LATERAL_SHARE ? LATERAL : FONDO;
  const size = PARTY_SIZES[randomInt(PARTY_SIZES.length)];
  const first =
    stand.first + randomInt(stand.rows) * SEATS_PER_ROW + randomInt(SEATS_PER_ROW - size + 1);
  return Array.from({ length: size }, (_, i) => first + i);
}

function errorCode(res) {
  try {
    return res.json('error.code');
  } catch {
    return undefined;
  }
}

function hold(headers) {
  for (let attempt = 0; attempt < HOLD_TRIES; attempt += 1) {
    const res = http.post(`${BASE}/events/1/holds`, JSON.stringify({ seatIds: pickSeats() }), {
      headers,
      tags: { step: 'hold' },
    });
    check(res, { 'hold: 201 or 409': (r) => r.status === 201 || r.status === 409 });
    if (res.status === 201) return res.json('holdId');
    if (res.status === 409) {
      if (errorCode(res) === 'SEAT_BUSY') seatsBusy.add(1);
      else seatsTaken.add(1);
    }
  }
  return undefined;
}

// One payment attempt under one key, retried with that key while the answer says "try again".
function payOnce(holdId, headers, key) {
  let res;
  for (let retry = 0; retry <= SAME_KEY_RETRIES; retry += 1) {
    res = http.post(`${BASE}/holds/${holdId}/checkout`, null, {
      headers: { ...headers, 'Idempotency-Key': key },
      tags: { step: 'checkout' },
    });
    const again = res.status === 503 || errorCode(res) === 'REQUEST_IN_PROGRESS';
    if (!again) break;
    sameKeyRetries.add(1);
    sleep(0.5);
  }
  return res;
}

export default function () {
  if (__ITER === 0) sleep((Math.random() * STAGGER_MS) / 1000);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens[(__VU - 1) % tokens.length]}`,
  };

  const holdId = hold(headers);
  if (holdId === undefined) {
    leftWithoutSeats.add(1);
    return;
  }
  holdsWon.add(1);

  for (let attempt = 0; attempt < PAY_ATTEMPTS; attempt += 1) {
    const res = payOnce(holdId, headers, `sellout-${RUN}-${__VU}-${__ITER}-${attempt}`);
    check(res, {
      'checkout: 200, 402 or 409': (r) => r.status === 200 || r.status === 402 || r.status === 409,
    });
    if (res.status === 200) {
      ordersPaid.add(1);
      seatsSold.add(res.json('tickets').length);
      return;
    }
    if (res.status !== 402) {
      lostAtCheckout.add(1);
      return;
    }
    declines.add(1);
  }
}
