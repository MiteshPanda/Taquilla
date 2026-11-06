// Double click (INV-2): every fan holds two seats of their own, then sends the same checkout twice
// at once with one Idempotency-Key, as a double-clicked Pay button does. Whichever click gets
// 409 REQUEST_IN_PROGRESS retries with the same key until the first one's answer is saved, so
// both clicks must end with the same answer. The audit afterwards must find no order charged twice.
//
//   npm run reset && npm run tokens
//   k6 run loadtest/double-click.js      # needs the API and the payment mock running
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
const STAGGER_MS = Number(__ENV.STAGGER_MS || 1000);
// A decline is followed by a new attempt with a new key, double-clicked again (FR-WEB-3).
const PAY_ATTEMPTS = 2;
// How long a click keeps retrying 409 REQUEST_IN_PROGRESS or a 503 with the same key.
const SAME_KEY_RETRIES = 60;
const RUN = Date.now().toString(36);

const ordersPaid = new Counter('orders_paid');
const declines = new Counter('payments_declined');
const waitedForFirst = new Counter('clicks_told_in_progress');
const replayed = new Counter('clicks_answered_by_replay');
const mismatches = new Counter('clicks_with_different_answers');

http.setResponseCallback(http.expectedStatuses(200, 201, 402, 409));

export const options = {
  scenarios: {
    double_click: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '5m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    checks: ['rate==1'],
    clicks_with_different_answers: ['count==0'],
    orders_paid: ['count>0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// The same JSON whatever the order of its keys: a replayed answer comes back from a jsonb column,
// which doesn't keep the order the first answer was written in.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function errorCode(res) {
  try {
    return res.json('error.code');
  } catch {
    return undefined;
  }
}

function checkoutRequest(holdId, headers, key) {
  return {
    method: 'POST',
    url: `${BASE}/holds/${holdId}/checkout`,
    body: null,
    params: { headers: { ...headers, 'Idempotency-Key': key }, tags: { step: 'checkout' } },
  };
}

// Follows one click to its final answer: a 409 REQUEST_IN_PROGRESS or a 503 means send the same
// request again, with the same key, in a moment.
function settle(first, request) {
  let res = first;
  for (let retry = 0; retry < SAME_KEY_RETRIES; retry += 1) {
    const inProgress = res.status === 409 && errorCode(res) === 'REQUEST_IN_PROGRESS';
    if (!inProgress && res.status !== 503) return res;
    if (inProgress && retry === 0) waitedForFirst.add(1);
    sleep(0.25);
    res = http.post(request.url, request.body, request.params);
  }
  return res;
}

export default function () {
  sleep((Math.random() * STAGGER_MS) / 1000);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokens[(__VU - 1) % tokens.length]}`,
  };

  // Two seats per fan, none shared, so the only contention is the fan against their own clicks.
  const firstSeat = ((2 * (__VU - 1)) % 2000) + 1;
  const held = http.post(
    `${BASE}/events/1/holds`,
    JSON.stringify({ seatIds: [firstSeat, firstSeat + 1] }),
    { headers, tags: { step: 'hold' } },
  );
  check(held, { 'hold: 201': (r) => r.status === 201 });
  if (held.status !== 201) return;
  const holdId = held.json('holdId');

  for (let attempt = 0; attempt < PAY_ATTEMPTS; attempt += 1) {
    const request = checkoutRequest(holdId, headers, `click-${RUN}-${__VU}-${attempt}`);
    const [a, b] = http.batch([request, request]).map((res) => settle(res, request));
    if (
      a.headers['Idempotent-Replayed'] === 'true' ||
      b.headers['Idempotent-Replayed'] === 'true'
    ) {
      replayed.add(1);
    }

    const same = a.status === b.status && canonical(a.json()) === canonical(b.json());
    if (!same) mismatches.add(1);
    check(a, {
      'both clicks end with the same answer': () => same,
      'checkout: 200 or 402': (r) => r.status === 200 || r.status === 402,
    });
    if (a.status === 402) {
      declines.add(1);
      continue;
    }
    if (a.status === 200) ordersPaid.add(1);
    return;
  }
}
