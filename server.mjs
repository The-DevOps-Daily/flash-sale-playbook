// A small flash-sale checkout service. One process, one SQLite database,
// one product. Configuration comes from environment variables so that the
// run script can start the exact same code in each mode.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const cfg = {
  port: Number(process.env.PORT || 3333),
  mode: process.env.MODE || 'naive', // naive | reserve
  stock: Number(process.env.STOCK || 500),
  payMinMs: Number(process.env.PAY_MIN_MS || 100),
  payMaxMs: Number(process.env.PAY_MAX_MS || 400),
  declineRate: Number(process.env.DECLINE_RATE || 0.05),
  // Simulated payment provider: at most this many authorizations at once,
  // the rest wait in a FIFO queue. 0 means no limit.
  payConcurrency: Number(process.env.PAY_CONCURRENCY || 0),
  // Waiting room in front of checkout: at most this many checkouts in
  // progress, the rest get 503 + Retry-After. 0 means no waiting room.
  admitLimit: Number(process.env.ADMIT_LIMIT || 0),
  // Deadline propagation: the client sends the time it will give up, and
  // the server skips the charge if the payment could not finish in time.
  deadline: process.env.DEADLINE === '1',
  seed: Number(process.env.SEED || 42),
  dbPath:
    process.env.DB_PATH ||
    path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), 'flash-sale.db'),
};

if (!['naive', 'reserve'].includes(cfg.mode)) {
  console.error(`unknown MODE=${cfg.mode}`);
  process.exit(1);
}

// mulberry32: small seeded PRNG for payment latency and declines.
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(cfg.seed);

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(cfg.dbPath + suffix, { force: true });
const db = new DatabaseSync(cfg.dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE inventory (sku TEXT PRIMARY KEY, stock INTEGER NOT NULL);
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    shopper TEXT NOT NULL,
    sku TEXT NOT NULL,
    created_ms REAL NOT NULL,
    latency_ms REAL NOT NULL,
    client_gone INTEGER NOT NULL DEFAULT 0
  );
`);
const SKU = 'drop-1';
db.prepare('INSERT INTO inventory (sku, stock) VALUES (?, ?)').run(SKU, cfg.stock);

const q = {
  readStock: db.prepare('SELECT stock FROM inventory WHERE sku = ?'),
  decrement: db.prepare('UPDATE inventory SET stock = stock - 1 WHERE sku = ?'),
  reserve: db.prepare('UPDATE inventory SET stock = stock - 1 WHERE sku = ? AND stock > 0'),
  release: db.prepare('UPDATE inventory SET stock = stock + 1 WHERE sku = ?'),
  insertOrder: db.prepare(
    'INSERT INTO orders (shopper, sku, created_ms, latency_ms, client_gone) VALUES (?, ?, ?, ?, ?)',
  ),
  orderCount: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(client_gone), 0) AS gone FROM orders'),
  distinctShoppers: db.prepare('SELECT COUNT(DISTINCT shopper) AS n FROM orders'),
};

const counters = {
  requests: 0,
  soldOut: 0,
  declined: 0,
  waitingRoomRejected: 0,
  clientGoneBeforeReply: 0,
  droppedBeforeCharge: 0,
  firstRequestMs: null,
  maxPayQueue: 0,
  maxCheckoutsInFlight: 0,
};
const t0 = performance.now();

// Payment provider stand-in: a FIFO semaphore plus a random service time.
let payInFlight = 0;
const payWaiters = [];
async function acquirePaySlot() {
  if (!cfg.payConcurrency || payInFlight < cfg.payConcurrency) {
    payInFlight++;
    return;
  }
  await new Promise((resolve) => {
    payWaiters.push(resolve);
    counters.maxPayQueue = Math.max(counters.maxPayQueue, payWaiters.length);
  });
}
function releasePaySlot() {
  const next = payWaiters.shift();
  if (next) next(); // hand the slot over directly, so new arrivals cannot barge
  else payInFlight--;
}
async function authorizePayment(isGone, deadlineMs) {
  await acquirePaySlot();
  try {
    if (cfg.deadline && (isGone() || Date.now() + cfg.payMaxMs > deadlineMs)) {
      counters.droppedBeforeCharge++;
      return 'gone';
    }
    const ms = cfg.payMinMs + rand() * (cfg.payMaxMs - cfg.payMinMs);
    await new Promise((r) => setTimeout(r, ms));
    return rand() >= cfg.declineRate ? 'paid' : 'declined';
  } finally {
    releasePaySlot();
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function recordOrder(shopper, started, clientGone) {
  q.insertOrder.run(shopper, SKU, performance.now() - t0, performance.now() - started, clientGone ? 1 : 0);
}

// The naive checkout: check, take payment, then write. The read and the
// write are separated by an await, so other requests run in between.
async function checkoutNaive(shopper, started, isGone, deadlineMs) {
  const { stock } = q.readStock.get(SKU);
  if (stock <= 0) return { status: 409, body: { error: 'sold_out' } };
  const payment = await authorizePayment(isGone, deadlineMs);
  if (payment === 'gone') return { status: 504, body: { error: 'deadline' } };
  if (payment === 'declined') return { status: 402, body: { error: 'declined' } };
  db.exec('BEGIN IMMEDIATE');
  q.decrement.run(SKU);
  recordOrder(shopper, started, isGone());
  db.exec('COMMIT');
  return { status: 200, body: { ok: true } };
}

// The playbook checkout: reserve the unit with one conditional UPDATE
// before payment, give it back if payment fails.
async function checkoutReserve(shopper, started, isGone, deadlineMs) {
  const { changes } = q.reserve.run(SKU);
  if (changes === 0) return { status: 409, body: { error: 'sold_out' } };
  const payment = await authorizePayment(isGone, deadlineMs);
  if (payment !== 'paid') {
    q.release.run(SKU);
    if (payment === 'gone') return { status: 504, body: { error: 'deadline' } };
    return { status: 402, body: { error: 'declined' } };
  }
  recordOrder(shopper, started, isGone());
  return { status: 200, body: { ok: true } };
}

let checkoutsInFlight = 0;

async function handleCheckout(req, res, url) {
  counters.requests++;
  const started = performance.now();
  if (counters.firstRequestMs === null) counters.firstRequestMs = started - t0;
  const shopper = url.searchParams.get('shopper') || 'anon';
  const deadlineMs = Number(url.searchParams.get('deadline') || Infinity);

  if (cfg.admitLimit && checkoutsInFlight >= cfg.admitLimit) {
    counters.waitingRoomRejected++;
    return send(res, 503, { queued: true }, { 'retry-after': '1' });
  }

  let gone = false;
  res.on('close', () => {
    if (!res.writableFinished) gone = true;
  });

  checkoutsInFlight++;
  counters.maxCheckoutsInFlight = Math.max(counters.maxCheckoutsInFlight, checkoutsInFlight);
  try {
    const fn = cfg.mode === 'reserve' ? checkoutReserve : checkoutNaive;
    const result = await fn(shopper, started, () => gone, deadlineMs);
    if (result.status === 409) counters.soldOut++;
    if (result.status === 402) counters.declined++;
    if (gone) {
      counters.clientGoneBeforeReply++;
      return;
    }
    send(res, result.status, result.body);
  } finally {
    checkoutsInFlight--;
  }
}

function stats() {
  const { stock } = q.readStock.get(SKU);
  const { n, gone } = q.orderCount.get();
  return {
    config: { ...cfg, dbPath: undefined },
    stockInitial: cfg.stock,
    stockNow: stock,
    orders: n,
    ordersToClientsThatHadLeft: gone,
    distinctShoppersWithOrders: q.distinctShoppers.get().n,
    oversold: Math.max(0, n - cfg.stock),
    checkoutsInFlight,
    payInFlight,
    payQueue: payWaiters.length,
    ...counters,
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/checkout') {
    handleCheckout(req, res, url).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'internal' });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/stats') return send(res, 200, stats());
  if (req.method === 'GET' && url.pathname === '/orders.csv') {
    const rows = db.prepare('SELECT id, created_ms, latency_ms, client_gone FROM orders ORDER BY id').all();
    res.writeHead(200, { 'content-type': 'text/csv' });
    res.end(
      'id,created_ms,latency_ms,client_gone\n' +
        rows.map((r) => `${r.id},${r.created_ms.toFixed(1)},${r.latency_ms.toFixed(1)},${r.client_gone}`).join('\n') +
        '\n',
    );
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  send(res, 404, { error: 'not_found' });
});
server.keepAliveTimeout = 65_000;
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(
    `flash-sale ${cfg.mode} on :${cfg.port} stock=${cfg.stock} admit=${cfg.admitLimit} pay=${cfg.payConcurrency} deadline=${cfg.deadline}`,
  );
});
