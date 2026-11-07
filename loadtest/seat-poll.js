// Seat-map polling (FR-WEB-4, WP 7.3): 1,000 virtual users keep a seat map fresh as the web page
// does. Each loads the full map once, then polls the seat states every 2 to 3 seconds.
//
//   k6 run loadtest/seat-poll.js                  # poll /seats/states, as the page does
//   k6 run -e POLL=map loadtest/seat-poll.js      # poll the full map instead, to compare
//   k6 run -e THINK=0 -e VUS=50 loadtest/seat-poll.js   # no pauses: the most it can serve
//
// Both routes are public, so no tokens are needed. The fans arrive over the first 10 seconds,
// as they would, rather than all loading the full map in the same instant.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const POLL = __ENV.POLL || 'states';
const VUS = Number(__ENV.VUS || 1000);
const DURATION = __ENV.DURATION || '60s';
const ARRIVAL_S = Number(__ENV.ARRIVAL_S || 10);
const THINK = __ENV.THINK !== '0';

const pollUrl = POLL === 'map' ? `${BASE}/events/1/seats` : `${BASE}/events/1/seats/states`;

export const options = {
  scenarios: {
    poll: { executor: 'constant-vus', vus: VUS, duration: DURATION, gracefulStop: '10s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    // The page polls every 2 to 3 seconds, so an answer has to arrive well inside that.
    'http_req_duration{kind:poll}': ['p(95)<500'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  if (__ITER === 0) {
    if (THINK) sleep(Math.random() * ARRIVAL_S);
    const map = http.get(`${BASE}/events/1/seats`, { tags: { kind: 'load' } });
    check(map, { 'the map loads': (res) => res.status === 200 });
  }

  const res = http.get(pollUrl, { tags: { kind: 'poll' } });
  check(res, { 'the poll answers 200': (r) => r.status === 200 });

  if (THINK) sleep(2 + Math.random());
}
