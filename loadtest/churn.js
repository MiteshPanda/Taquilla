// Churn (FR-EXP-2, INV-4): fans hold seats and walk away while others keep trying, so seats are
// only ever bought after an abandoned hold expires. All of it happens in the Lateral Este stand,
// seats 1 to 500:
//
// 1. grab: 250 fans hold the whole stand at the start, two seats each, and never pay.
// 2. churn: 150 fans keep holding whatever has lapsed, and walk away again.
// 3. buy: 300 fans keep asking for two adjacent seats, wait a moment after every 409, and pay
//    once they get them.
//
// Since every seat is held before any buyer arrives, every seat sold is an expired hold resold.
// Run the API with short holds and the sweeper beside it:
//
//   npm run reset && npm run tokens
//   HOLD_SECONDS=10 npm run dev      # plus npm run payments and npm run sweeper
//   k6 run loadtest/churn.js
//   npm run audit                    # now, and again 45 s later: the sweeper must clear the rest
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const tokens = new SharedArray('tokens', () =>
  JSON.parse(open('./tokens.json')).map((fan) => fan.token),
);

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const DURATION = __ENV.DURATION || '80s';
const STAGGER_MS = Number(__ENV.STAGGER_MS || 1000);
// The API must run with holds this short or shorter, or nothing lapses during the run.
const MAX_HOLD_SECONDS = 60;
const PAY_ATTEMPTS = 3;
const SAME_KEY_RETRIES = 5;
const RUN = Date.now().toString(36);

// Lateral Este: seats 1 to 500, 20 rows of 25.
const STAND = { first: 1, rows: 20, seatsPerRow: 25, size: 500 };
const GRABBERS = STAND.size / 2;

const abandoned = new Counter('seats_abandoned');
const taken = new Counter('hold_attempts_taken');
const resold = new Counter('seats_resold');
const ordersPaid = new Counter('orders_paid');
const declines = new Counter('payments_declined');
const refused = new Counter('checkouts_refused');
const sameKeyRetries = new Counter('same_key_retries');

http.setResponseCallback(http.expectedStatuses(200, 201, 402, 409));

export const options = {
  scenarios: {
    grab: {
      executor: 'per-vu-iterations',
      exec: 'grab',
      vus: GRABBERS,
      iterations: 1,
      maxDuration: '30s',
    },
    churn: {
      executor: 'constant-vus',
      exec: 'churn',
      vus: 150,
      duration: DURATION,
      startTime: '3s',
    },
    buy: {
      executor: 'constant-vus',
      exec: 'buy',
      vus: 300,
      duration: DURATION,
      startTime: '3s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    checks: ['rate==1'],
    seats_resold: ['count>0'], // the plan's "expired seats get resold"
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function randomInt(below) {
  return Math.floor(Math.random() * below);
}

function headersFor() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens[(__VU - 1) % tokens.length]}`,
  };
}

function adjacentPair() {
  const first =
    STAND.first + randomInt(STAND.rows) * STAND.seatsPerRow + randomInt(STAND.seatsPerRow - 1);
  return [first, first + 1];
}

function holdSeats(seatIds, headers) {
  const res = http.post(`${BASE}/events/1/holds`, JSON.stringify({ seatIds }), {
    headers,
    tags: { step: 'hold' },
  });
  check(res, { 'hold: 201 or 409': (r) => r.status === 201 || r.status === 409 });
  if (res.status === 409) taken.add(1);
  return res;
}

function errorCode(res) {
  try {
    return res.json('error.code');
  } catch {
    return undefined;
  }
}

function payOnce(holdId, headers, key) {
  let res;
  for (let retry = 0; retry <= SAME_KEY_RETRIES; retry += 1) {
    res = http.post(`${BASE}/holds/${holdId}/checkout`, null, {
      headers: { ...headers, 'Idempotency-Key': key },
      tags: { step: 'checkout' },
    });
    if (res.status !== 503 && errorCode(res) !== 'REQUEST_IN_PROGRESS') break;
    sameKeyRetries.add(1);
    sleep(0.5);
  }
  return res;
}

// Two seats each, side by side, so 250 fans hold the whole stand. Then they leave.
export function grab() {
  sleep((Math.random() * STAGGER_MS) / 1000);
  const first = STAND.first + 2 * ((__VU - 1) % GRABBERS);
  const res = holdSeats([first, first + 1], headersFor());
  if (res.status !== 201) return;
  abandoned.add(2);
  check(res, {
    [`the API holds seats for at most ${MAX_HOLD_SECONDS} s (HOLD_SECONDS)`]: (r) =>
      Date.parse(r.json('expiresAt')) - Date.now() < MAX_HOLD_SECONDS * 1000,
  });
}

// Takes whatever has lapsed, then walks away again.
export function churn() {
  if (__ITER === 0) sleep((Math.random() * STAGGER_MS) / 1000);
  const res = holdSeats(adjacentPair(), headersFor());
  if (res.status === 201) abandoned.add(2);
  sleep(1 + Math.random());
}

// Keeps trying until it gets two seats, then pays for them.
export function buy() {
  if (__ITER === 0) sleep((Math.random() * STAGGER_MS) / 1000);
  const headers = headersFor();
  const held = holdSeats(adjacentPair(), headers);
  if (held.status !== 201) {
    sleep(1 + Math.random());
    return;
  }

  const holdId = held.json('holdId');
  for (let attempt = 0; attempt < PAY_ATTEMPTS; attempt += 1) {
    const res = payOnce(holdId, headers, `churn-${RUN}-${__VU}-${__ITER}-${attempt}`);
    check(res, {
      'checkout: 200, 402 or 409': (r) => r.status === 200 || r.status === 402 || r.status === 409,
    });
    if (res.status === 200) {
      ordersPaid.add(1);
      resold.add(res.json('tickets').length);
      return;
    }
    if (res.status !== 402) {
      refused.add(1);
      return;
    }
    declines.add(1);
  }
}

// How the stand ended up, from the public seat map.
export function teardown() {
  const res = http.get(`${BASE}/events/1/seats`);
  const states = {};
  for (const seat of res.json('seats')) {
    if (seat.id >= STAND.first && seat.id < STAND.first + STAND.size) {
      states[seat.state] = (states[seat.state] || 0) + 1;
    }
  }
  console.log(`Lateral Este after the run: ${JSON.stringify(states)}`);
}
