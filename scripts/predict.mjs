// Predict each experiment before running it. This is a small event
// simulation of the same checkout logic, fed with the arrival schedule
// that k6's ramping-arrival-rate executor produces for each profile.
// It ignores server CPU time, so it shows what the logic alone implies.
//
//   node scripts/predict.mjs > results/predictions.json
const TRIALS = 400;
const PAY_MIN = 0.1;
const PAY_MAX = 0.4;
const DECLINE = 0.05;
const PATIENCE = 15;

const profiles = {
  drop: [
    [300, 10],
    [300, 20],
    [0, 5],
  ],
  low: [
    [30, 10],
    [30, 30],
    [0, 5],
  ],
  peak: [
    [64, 10],
    [64, 30],
    [0, 10],
  ],
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Arrival i happens when the integral of the rate reaches i.
function arrivals(stages) {
  const out = [];
  let t0 = 0;
  let r0 = 0;
  let cum = 0;
  let k = 1;
  for (const [r1, d] of stages) {
    const a = (r1 - r0) / (2 * d);
    const stageTotal = r0 * d + a * d * d;
    while (k <= cum + stageTotal + 1e-9) {
      const c = cum - k;
      const tau = a === 0 ? (k - cum) / r0 : (-r0 + Math.sqrt(r0 * r0 - 4 * a * c)) / (2 * a);
      out.push(t0 + tau);
      k++;
    }
    cum += stageTotal;
    t0 += d;
    r0 = r1;
  }
  return out;
}

class Heap {
  constructor() {
    this.a = [];
  }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t <= a[i].t) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].t < a[m].t) m = l;
        if (r < a.length && a[r].t < a[m].t) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  peek() {
    return this.a[0];
  }
  get size() {
    return this.a.length;
  }
}

const payTime = (rand) => PAY_MIN + rand() * (PAY_MAX - PAY_MIN);

// Experiment 1: naive check, pay, then write.
function naive(arr, stock, rand) {
  let counter = stock;
  let orders = 0;
  const done = new Heap();
  for (const t of arr) {
    while (done.size && done.peek().t <= t) {
      done.pop();
      counter--;
      orders++;
    }
    if (counter <= 0) continue;
    const l = payTime(rand);
    if (rand() >= DECLINE) done.push({ t: t + l });
  }
  orders += done.size;
  return { orders, oversold: Math.max(0, orders - stock), finalStock: stock - orders };
}

// Experiment 1: reserve with a conditional decrement, release on decline.
function reserve(arr, stock, rand) {
  let counter = stock;
  let orders = 0;
  const ev = new Heap();
  for (const t of arr) {
    while (ev.size && ev.peek().t <= t) {
      const e = ev.pop();
      if (e.paid) orders++;
      else counter++;
    }
    if (counter <= 0) continue;
    counter--;
    const l = payTime(rand);
    ev.push({ t: t + l, paid: rand() >= DECLINE });
  }
  while (ev.size) if (ev.pop().paid) orders++;
  return { orders, oversold: Math.max(0, orders - stock) };
}

// Experiment 2a and 2b: everyone goes straight to checkout, payment has
// `c` slots and a FIFO queue. With deadline, a request that could not
// finish before its shopper gives up is skipped instead of charged.
function fifo(arr, c, rand, deadline) {
  const free = new Heap();
  for (let i = 0; i < c; i++) free.push({ t: 0 });
  let purchases = 0;
  let ghosts = 0;
  let timeouts = 0;
  const okLatency = [];
  for (const a of arr) {
    const slot = free.pop();
    const start = Math.max(a, slot.t);
    if (deadline && start + PAY_MAX > a + PATIENCE) {
      timeouts++;
      free.push({ t: start });
      continue;
    }
    const end = start + payTime(rand);
    free.push({ t: end });
    const paid = rand() >= DECLINE;
    if (end - a > PATIENCE) {
      timeouts++;
      if (paid) ghosts++;
    } else if (paid) {
      purchases++;
      okLatency.push(end - a);
    }
  }
  return { purchases, ghosts, timeouts, abandoned: 0, okLatency, timeToPurchase: okLatency };
}

// Experiment 2c: a waiting room admits at most `limit` checkouts at once,
// everyone else is told to retry after ~1 s (jittered) until patience runs out.
function waitingRoom(arr, limit, rand) {
  const ev = new Heap();
  arr.forEach((a) => ev.push({ t: a, kind: 'try', a }));
  let inFlight = 0;
  let purchases = 0;
  let ghosts = 0;
  let timeouts = 0;
  let abandoned = 0;
  let rejected = 0;
  const okLatency = [];
  const timeToPurchase = [];
  while (ev.size) {
    const e = ev.pop();
    if (e.kind === 'done') {
      inFlight--;
      continue;
    }
    if (inFlight < limit) {
      inFlight++;
      const l = payTime(rand);
      const paid = rand() >= DECLINE;
      ev.push({ t: e.t + l, kind: 'done' });
      if (e.t + l - e.a > PATIENCE) {
        timeouts++;
        if (paid) ghosts++;
      } else if (paid) {
        purchases++;
        okLatency.push(l);
        timeToPurchase.push(e.t + l - e.a);
      }
      continue;
    }
    rejected++;
    const wait = 1 * (0.5 + rand());
    if (e.t - e.a + wait > PATIENCE) abandoned++;
    else ev.push({ t: e.t + wait, kind: 'try', a: e.a });
  }
  return { purchases, ghosts, timeouts, abandoned, rejected, okLatency, timeToPurchase };
}

function pct(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
function summarize(runs, keys) {
  const out = {};
  for (const k of keys) {
    const v = runs.map((r) => r[k]).filter((x) => x !== null && x !== undefined);
    out[k] = { mean: +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2), p5: pct(v, 5), p95: pct(v, 95) };
  }
  return out;
}

function trials(fn) {
  const runs = [];
  for (let i = 0; i < TRIALS; i++) runs.push(fn(mulberry32(1000 + i)));
  return runs;
}

const STOCK = 500;
const PAY_SLOTS = 8;
const out = { trials: TRIALS, assumptions: { STOCK, PAY_MIN, PAY_MAX, DECLINE, PATIENCE, PAY_SLOTS } };

for (const p of ['drop', 'low']) {
  const arr = arrivals(profiles[p]);
  out[`${p}-naive`] = { arrivals: arr.length, ...summarize(trials((r) => naive(arr, STOCK, r)), ['orders', 'oversold']) };
  out[`${p}-reserve`] = { arrivals: arr.length, ...summarize(trials((r) => reserve(arr, STOCK, r)), ['orders', 'oversold']) };
}

const peakArr = arrivals(profiles.peak);
const withStats = (r) => ({
  ...r,
  okP95: pct(r.okLatency, 95),
  ttpMedian: pct(r.timeToPurchase, 50),
  ttpP95: pct(r.timeToPurchase, 95),
});
const peakKeys = ['purchases', 'ghosts', 'timeouts', 'abandoned', 'okP95', 'ttpMedian', 'ttpP95'];
out['peak-queue'] = {
  arrivals: peakArr.length,
  ...summarize(trials((r) => withStats(fifo(peakArr, PAY_SLOTS, r, false))), peakKeys),
};
out['peak-deadline'] = {
  arrivals: peakArr.length,
  ...summarize(trials((r) => withStats(fifo(peakArr, PAY_SLOTS, r, true))), peakKeys),
};
out['peak-waitingroom'] = {
  arrivals: peakArr.length,
  ...summarize(trials((r) => withStats(waitingRoom(peakArr, PAY_SLOTS, r))), [...peakKeys, 'rejected']),
};

console.log(JSON.stringify(out, null, 2));
