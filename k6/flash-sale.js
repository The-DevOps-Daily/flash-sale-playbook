// One k6 scenario for every run: an open-model flash sale.
// ramping-arrival-rate starts new shoppers on a schedule whether or not
// the server keeps up, which is how a real drop behaves.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3333';
const PROFILE = __ENV.PROFILE || 'drop';
// Each shopper is willing to spend at most this long on checkout, whether
// that is one slow request or several tries through a waiting room.
const PATIENCE_S = Number(__ENV.PATIENCE_S || 15);

const profiles = {
  // A limited drop: everyone arrives at once and the stock sells out.
  drop: {
    stages: [
      { target: 300, duration: '10s' },
      { target: 300, duration: '20s' },
      { target: 0, duration: '5s' },
    ],
    vus: 200,
  },
  // The same drop at a tenth of the traffic.
  low: {
    stages: [
      { target: 30, duration: '10s' },
      { target: 30, duration: '30s' },
      { target: 0, duration: '5s' },
    ],
    vus: 50,
  },
  // A sustained peak above what checkout can process; stock never runs out.
  peak: {
    stages: [
      { target: 64, duration: '10s' },
      { target: 64, duration: '30s' },
      { target: 0, duration: '10s' },
    ],
    vus: 1200,
  },
  // A few seconds, for checking the harness itself.
  smoke: { stages: [{ target: 20, duration: '3s' }], vus: 50 },
};
const profile = profiles[PROFILE];
if (!profile) throw new Error(`unknown PROFILE=${PROFILE}`);

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      // Every VU exists before the sale starts. Creating VUs on demand
      // mid-test made k6 skip shoppers it could not start in time.
      preAllocatedVUs: profile.vus,
      maxVUs: profile.vus,
      stages: profile.stages,
    },
  },
  thresholds: {
    // A run that could not start every shopper on schedule measured a
    // lighter load than planned, so it fails.
    dropped_iterations: ['count==0'],
    // The checks that matter for a sale, not just latency.
    oversold_units: ['count==0'],
    orders_to_clients_that_left: ['count==0'],
    'http_req_duration{name:checkout}': ['p(95)<2000'],
  },
  teardownTimeout: '120s',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// Sold out, declined and "please wait" are answers, not failures.
// http_req_failed then counts only timeouts and real errors.
http.setResponseCallback(http.expectedStatuses(200, 402, 409, 503));

const purchases = new Counter('purchases');
const soldOut = new Counter('sold_out');
const declined = new Counter('declined');
const queuedResponses = new Counter('waiting_room_responses');
const timeouts = new Counter('client_timeouts');
const otherErrors = new Counter('other_errors');
const abandoned = new Counter('abandoned_in_waiting_room');
const deadlineSkipped = new Counter('skipped_past_deadline');
const oversold = new Counter('oversold_units');
const ghostOrders = new Counter('orders_to_clients_that_left');
const checkoutOk = new Trend('checkout_ok_ms', true);
const timeToPurchase = new Trend('time_to_purchase_ms', true);

export default function () {
  const shopper = `s${exec.scenario.iterationInTest}`;
  const start = Date.now();
  for (;;) {
    const remainingMs = PATIENCE_S * 1000 - (Date.now() - start);
    const deadline = start + PATIENCE_S * 1000;
    const res = http.post(`${BASE}/checkout?shopper=${shopper}&deadline=${deadline}`, null, {
      timeout: `${Math.max(remainingMs, 1)}ms`,
      tags: { name: 'checkout' },
    });
    if (res.status === 200) {
      purchases.add(1);
      checkoutOk.add(res.timings.duration);
      timeToPurchase.add(Date.now() - start);
      return;
    }
    if (res.status === 409) return soldOut.add(1);
    if (res.status === 402) return declined.add(1);
    if (res.status === 504) return deadlineSkipped.add(1);
    if (res.status === 503) {
      queuedResponses.add(1);
      // Jitter so that waiting shoppers do not retry in lockstep.
      const wait = Number(res.headers['Retry-After'] || 1) * (0.5 + Math.random());
      if (Date.now() - start + wait * 1000 > PATIENCE_S * 1000) return abandoned.add(1);
      sleep(wait);
      continue;
    }
    if (res.status === 0 && res.error_code === 1050) return timeouts.add(1);
    return otherErrors.add(1);
  }
}

// After the sale, ask the server what it actually sold. A load test that
// only looks at response codes cannot see an oversell.
export function teardown() {
  // Requests the client gave up on keep running server-side, so wait for
  // the server to drain before counting.
  const params = { tags: { name: 'stats' } };
  let s = http.get(`${BASE}/stats`, params).json();
  for (let i = 0; i < 90 && s.checkoutsInFlight > 0; i++) {
    sleep(1);
    s = http.get(`${BASE}/stats`, params).json();
  }
  oversold.add(s.oversold);
  ghostOrders.add(s.ordersToClientsThatHadLeft);
  check(s, {
    'no unit sold twice': (x) => x.oversold === 0,
    'every order reached a waiting client': (x) => x.ordersToClientsThatHadLeft === 0,
    'server drained': (x) => x.checkoutsInFlight === 0,
  });
  console.log(`server stats: ${JSON.stringify(s)}`);
}
