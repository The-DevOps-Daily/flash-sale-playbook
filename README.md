# flash-sale-playbook

```bash
# Node.js 22.13+ and k6 on PATH; no other dependencies.
# results/ holds the published runs, so write yours somewhere new:
RESULTS_DIR=my-results scripts/run-all.sh
```

A small flash-sale checkout service and one k6 scenario that measure two things: whether checking stock before payment oversells at modest traffic, and what a waiting room in front of checkout changes when buyers arrive faster than payment can process them. Companion repo for the DevOps Daily post [How Shopify Survives Black Friday: The Flash-Sale Playbook](https://devops-daily.com/posts/how-shopify-survives-black-friday-flash-sale-playbook).

The full set of runs takes about 25 minutes. Each load test is under two minutes. Run it on a quiet machine: k6 and the server share the CPU, and a starved k6 skips shoppers.

## What each file does

| File | What it does |
|---|---|
| `server.mjs` | The checkout service: one Node.js process, one SQLite database (`node:sqlite`, in `/dev/shm` when available), one product. `MODE=naive` checks stock, takes payment, then decrements. `MODE=reserve` decrements with `UPDATE ... WHERE stock > 0` before payment and releases on decline. A payment stand-in takes 100 to 400 ms (uniform, seeded) and declines 5%. `PAY_CONCURRENCY` limits it to N authorizations at once, `DEADLINE=1` skips the charge when less than `PAY_MAX_MS` is left before the deadline the client sends, `ADMIT_LIMIT` turns on a waiting room (503 + `Retry-After` above N checkouts in progress). |
| `k6/flash-sale.js` | The only k6 scenario: `ramping-arrival-rate` (open model) with every VU created before the sale. Profiles `drop`, `low`, `peak`, `smoke`. After the sale, `teardown()` asks the server what it sold and reports `oversold_units` and `orders_to_clients_that_left` as metrics, so thresholds fail the run on correctness. A `dropped_iterations` threshold fails any run where k6 could not start every shopper on schedule. |
| `scripts/run.sh` | Runs one labelled experiment: starts the server with the given settings, runs k6, saves `k6-output.txt`, `k6-summary.json`, `server-stats.json`, `orders.csv` and a `run.json` stamp (hash of `server.mjs` and the k6 script, settings, host, load average, k6 and Node versions) under `$RESULTS_DIR/<label>/`. Refuses to overwrite an existing label. k6 exit 99 (a threshold failed) is an expected result for some variants; any other non-zero exit fails the script. |
| `scripts/run-all.sh` | Every recorded run, in order. Variants are interleaved to spread background load across them. |
| `scripts/predict.mjs` | An event simulation of the same checkout logic, 400 trials per variant, ignoring server CPU time. Its arrival schedule is an idealized copy of k6's with one extra arrival at the very end (8,250 / 1,125 / 2,560 against k6's 8,249 / 1,124 / 2,559). It was run before the recorded runs: the `predictions.json` written at the start of the first batch, in `results/discarded/2026-10-05-on-demand-vus/`, is identical to `results/predictions.json`. |
| `scripts/summarize.mjs` | Builds `summary.md` from the run folders. Refuses to mix runs of one profile made with different code, and exits non-zero if any run dropped iterations, started fewer shoppers than scheduled or than other runs of its profile, or counted before the server drained. |

## Results

Raspberry Pi 4 (4 cores), shared with other work; k6 2.3.0 and the server on the same machine. Absolute numbers are small; the comparisons are what matter. Full tables: [`results/summary.md`](results/summary.md).

**Experiment 1, a 500-unit drop** (`drop`: 0 to 300 shoppers/s over 10 s, hold 20 s, down over 5 s; 8,249 shoppers)

| Checkout | Runs | Orders | Oversold | Predicted oversold (mean, 5th to 95th pct) |
|---|---|---|---|---|
| naive: check, pay, then decrement | seeds 1, 2, 3 | 544, 541, 547 | 44, 41, 47 | 42.5 (37 to 48) |
| reserve: conditional decrement, then pay | seeds 1, 2, 3 | 500, 500, 500 | 0, 0, 0 | 0 |
| naive at a tenth of the traffic (`low`) | seed 1 | 508 | 8 | 6.6 (4 to 9) |
| reserve at a tenth of the traffic (`low`) | seed 1 | 500 | 0 | 0 |

The oversell is roughly arrival rate × mean payment time × approval rate at the moment the counter reaches zero (about 185/s × 0.25 s × 0.95 ≈ 44 here, 6.2 s into the sale). Every naive run fails the `oversold_units` threshold (k6 exit 99); every reserve run passes.

**Experiment 2, twice the payment capacity** (`peak`: payment has 8 slots, about 32 checkouts/s; 0 to 64 shoppers/s over 10 s, hold 30 s, down over 10 s; 2,559 shoppers who each give up after 15 s; three runs per variant)

| | queue | deadline | waiting room |
|---|---|---|---|
| purchases confirmed to the shopper | 1,028 to 1,071 | 1,794 to 1,834 | 1,603 to 1,642 |
| charged after the shopper had given up | 1,375 to 1,408 | 0 | 10 to 14 |
| successful checkout request p95 | 14.2 to 14.3 s | 14.9 s | 387 to 395 ms |
| time to purchase, median | 6.4 to 6.7 s | 12.5 to 13.1 s | 4.3 to 5.0 s |
| shopper saw a timeout | 1,437 to 1,481 (most were charged anyway, row above) | 0 | 14 to 18 |
| shopper was refused at the deadline | 0 | 636 to 670 | 0 |
| shopper gave up after "please wait" | 0 | 0 | 826 to 847 |
| shopper saw a decline | 50 to 61 | 89 to 96 | 77 to 91 |
| most checkouts in progress at once | 1,122 to 1,142 | 948 to 949 | 8 |

All three variants complete about 30 orders a second during the overload; payment is the limit. The difference is who those orders go to. Every recorded order count falls inside the predictor's 5th to 95th percentile range; a few latency figures fall just outside it. The waiting room's lower total builds up mostly in the seconds after arrivals stop, and comes from this polling policy: random admission, giving up as soon as the next random wait would cross 15 s, and slots that sit idle until a retry arrives. See the post.

Peak seeds 2 and 3 were run straight after the first full pass, with the same code hash. `server.mjs` and the k6 script have not changed since; later edits touched only `run.sh`, `run-all.sh` and `summarize.mjs`, which do not affect measurements.

`results/discarded/` holds runs that were thrown away, each folder with a `NOTE.md`: the first full batch, where k6 created VUs on demand and skipped up to a fifth of the scheduled shoppers in the peak runs, and two peak runs that did not deliver their full schedule during a burst of unrelated CPU load on the Pi and were re-run. Runs were discarded for incomplete delivery, not for load: `peak-queue-3` ran under a load average of 8.93, delivered every shopper and was kept.

## What this does not show

SQLite serializes writes, so the single-row conditional `UPDATE` never competes for a row lock the way it would in MySQL or Postgres; Shopify moved to one row per unit with `SKIP LOCKED`, from a bounded pool of 1,000 rows per item and location, for that reason. Node.js holds a waiting connection cheaply, so the cost of queuing requests in a thread-per-request server is understated. The waiting room is a random-retry lottery, not a fair, arrival-ordered queue. The post covers these in more detail.

## License

MIT
