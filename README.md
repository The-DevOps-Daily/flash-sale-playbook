# flash-sale-playbook

```bash
# Node.js 22.13+ and k6 on PATH; no other dependencies
scripts/run-all.sh
```

A small flash-sale checkout service and one k6 scenario that measure two things: whether checking stock before payment oversells at modest traffic, and what a waiting room in front of checkout changes when buyers arrive faster than payment can process them. Companion repo for the DevOps Daily post [How Shopify Survives Black Friday: The Flash-Sale Playbook](https://devops-daily.com/posts/how-shopify-survives-black-friday-flash-sale-playbook).

The full set of runs takes about 25 minutes and writes everything to `results/`. Each load test is under two minutes.

## What each file does

| File | What it does |
|---|---|
| `server.mjs` | The checkout service: one Node.js process, one SQLite database (`node:sqlite`, in `/dev/shm` when available), one product. `MODE=naive` checks stock, takes payment, then decrements. `MODE=reserve` decrements with `UPDATE ... WHERE stock > 0` before payment and releases on decline. A payment stand-in takes 100 to 400 ms (uniform, seeded) and declines 5%. `PAY_CONCURRENCY` limits it to N authorizations at once, `DEADLINE=1` skips a charge that could not finish before the shopper gives up, `ADMIT_LIMIT` turns on a waiting room (503 + `Retry-After` above N checkouts in progress). |
| `k6/flash-sale.js` | The only k6 scenario: `ramping-arrival-rate` (open model) with every VU created before the sale. Profiles `drop`, `low`, `peak`, `smoke`. After the sale, `teardown()` asks the server what it sold and reports `oversold_units` and `orders_to_clients_that_left` as metrics, so thresholds fail the run on correctness. A `dropped_iterations` threshold fails any run where k6 could not start every shopper on schedule. |
| `scripts/run.sh` | Runs one labelled experiment: starts the server with the given settings, runs k6, saves `k6-output.txt`, `k6-summary.json`, `server-stats.json`, `orders.csv` and a `run.json` stamp (code hash, settings, host, load average, k6 and Node versions). Refuses to overwrite an existing label. |
| `scripts/run-all.sh` | Every recorded run, in order. Naive and fixed variants are interleaved so background load hits both alike. |
| `scripts/predict.mjs` | An event simulation of the same checkout logic with k6's exact arrival schedule, 400 trials per variant. Written and run before the experiments; `results/predictions.json` is its output. |
| `scripts/summarize.mjs` | Builds `results/summary.md` from the run folders. Refuses to mix runs of one profile made with different code, and lists dropped iterations, runs that started fewer shoppers than other runs of the same profile, and undrained servers as problems. |

## Results

Raspberry Pi 4 (4 cores), shared with other work; k6 2.3.0 and the server on the same machine. Absolute numbers are small; the comparisons are what matter. Full tables: [`results/summary.md`](results/summary.md).

**Experiment 1, a 500-unit drop** (`drop`: 0 to 300 shoppers/s over 10 s, hold 20 s, down over 5 s; 8,249 shoppers)

| Checkout | Runs | Orders | Oversold | Predicted oversold (mean, 5th to 95th pct) |
|---|---|---|---|---|
| naive: check, pay, then decrement | seeds 1, 2, 3 | 544, 541, 547 | 44, 41, 47 | 42.5 (37 to 48) |
| reserve: conditional decrement, then pay | seeds 1, 2, 3 | 500, 500, 500 | 0, 0, 0 | 0 |
| naive at a tenth of the traffic (`low`) | seed 1 | 508 | 8 | 6.6 (4 to 9) |
| reserve at a tenth of the traffic (`low`) | seed 1 | 500 | 0 | 0 |

The oversell is roughly arrival rate × mean payment time × approval rate at the moment the counter reaches zero (about 177/s × 0.25 s × 0.95 here). Every naive run fails the `oversold_units` threshold (k6 exit 99); every reserve run passes.

**Experiment 2, twice the payment capacity** (`peak`: payment has 8 slots, about 32 checkouts/s; 0 to 64 shoppers/s over 10 s, hold 30 s, down over 10 s; 2,559 shoppers who each give up after 15 s; three runs per variant)

| | queue | deadline | waiting room |
|---|---|---|---|
| purchases confirmed to the shopper | 1,028 to 1,071 | 1,794 to 1,834 | 1,603 to 1,642 |
| charged after the shopper had given up | 1,375 to 1,408 | 0 | 10 to 14 |
| successful checkout request p95 | 14.2 to 14.3 s | 14.9 s | 387 to 395 ms |
| time to purchase, median | 6.4 to 6.7 s | 12.5 to 13.1 s | 4.3 to 5.0 s |
| gave up without buying | 1,437 to 1,481 timed out | 636 to 670 skipped at deadline | 826 to 847 gave up waiting |
| most checkouts in progress at once | 1,122 to 1,142 | 948 to 949 | 8 |

All three variants complete about 30 orders a second during the overload; payment is the limit. The difference is who those orders go to. The waiting room's lower total comes mostly from the seconds after arrivals stop, when random retries lose the shoppers who had waited longest; see the post.

Peak seeds 2 and 3 were run straight after the first full pass, with the same code hash.

`results/discarded/` holds runs that were thrown away, each folder with a `NOTE.md`: the first full batch, where k6 created VUs on demand and skipped up to a fifth of the scheduled shoppers in the peak runs, and two peak runs that overlapped with unrelated CPU load on the Pi and were re-run.

## What this does not show

SQLite serializes writes, so the single-row conditional `UPDATE` never competes for a row lock the way it would in MySQL or Postgres; Shopify moved to one row per unit with `SKIP LOCKED` for that reason. Node.js holds a waiting connection cheaply, so the cost of queuing requests in a thread-per-request server is understated. The waiting room is a random-retry lottery, not a fair, arrival-ordered queue. The post covers these in more detail.

## License

MIT
