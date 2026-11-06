// Hot seat (NFR-2 to NFR-4): 1,000 virtual users send 10,000 requests for seat 42.
// Exactly one may win; every other answer must be a 409, never a 5xx or a timeout.
//
//   npm run reset && npm run tokens      # a clean stadium and a token per fan
//   k6 run loadtest/hot-seat.js          # against the strategy the API started with
//   k6 run -e TARGET=naive loadtest/hot-seat.js   # the unsafe dev route, expected to fail
//
// Reset the database before every run: seat 42 is gone after the first.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// [{ userId, token }, …] from npm run tokens, loaded once and shared by every virtual user.
const tokens = new SharedArray('tokens', () =>
  JSON.parse(open('./tokens.json')).map((fan) => fan.token),
);

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TARGET = __ENV.TARGET || 'holds';
const VUS = Number(__ENV.VUS || 1000);
const ITERATIONS = Number(__ENV.ITERATIONS || 10000);
const SEAT_ID = 42;
// Each virtual user's first request starts at a random moment within this window. If all 1,000
// open a connection in the same millisecond, Windows client editions refuse most of them: they
// cap pending connections at about 200. Later requests reuse the connection and fire back to back.
const STAGGER_MS = Number(__ENV.STAGGER_MS || 1000);

const won = new Counter('holds_won');
const taken = new Counter('seat_taken');
const busy = new Counter('seat_busy');

// A 409 is a correct answer here, so only other statuses count as failures.
http.setResponseCallback(http.expectedStatuses(201, 409));

export const options = {
  scenarios: {
    hot_seat: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      maxDuration: '3m',
    },
  },
  thresholds: {
    holds_won: ['count==1'], // exactly one fan gets seat 42
    http_req_failed: ['rate<0.001'], // no 5xx, no timeouts
    // NFR-3's laptop ceiling. Every virtual user sends its next request as soon as the last one
    // answers, so latency is about 1,000 / requests per second: 1.19 to 1.48 s across the
    // strategies on an 8-thread laptop (docs/benchmarks.md).
    http_req_duration: ['p(95)<2500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function request(token) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (TARGET === 'naive') {
    return http.post(`${BASE}/dev/buy-naive`, JSON.stringify({ seatId: SEAT_ID }), { headers });
  }
  return http.post(`${BASE}/events/1/holds`, JSON.stringify({ seatIds: [SEAT_ID] }), { headers });
}

export default function () {
  if (__ITER === 0) sleep((Math.random() * STAGGER_MS) / 1000);

  const res = request(tokens[(__VU - 1) % tokens.length]);

  check(res, { '201 or 409': (r) => r.status === 201 || r.status === 409 });
  if (res.status === 201) won.add(1);
  if (res.status === 409) {
    const code = res.json('error.code');
    if (code === 'SEAT_BUSY') busy.add(1);
    else taken.add(1);
  }
}
