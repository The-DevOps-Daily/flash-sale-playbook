# Discarded batch: VUs created on demand

This is the first full run of `scripts/run-all.sh` (code hash `f3103013b7fc2d36`). It is kept as evidence, not used for any number in the post or the main README.

## What was wrong

The k6 scenario started with `preAllocatedVUs: 50` and let k6 create more VUs mid-test, up to `maxVUs`. When every VU was busy, k6 had to initialise a new one before it could start the next shopper, and shoppers it could not start on time were skipped and counted as `dropped_iterations`:

| run | shoppers scheduled by k6 | shoppers started | dropped |
|---|---|---|---|
| drop-naive-2 | 8,249 | 8,248 | 1 |
| peak-queue-1 | 2,559 | 2,018 | 541 |
| peak-deadline-1 | 2,559 | 2,017 | 542 |
| peak-waitingroom-1 | 2,559 | 2,119 | 440 |

In the peak runs k6 never got past 587 VUs (489 in the waiting-room run), so between a sixth and a fifth of the scheduled arrivals never happened. Those runs measured a lighter and different load for each variant, which makes them useless for comparing variants. `summary.md` in this folder lists the problems; `scripts/summarize.mjs` flagged them automatically.

## What replaced it

The scenario now creates every VU before the sale starts (`preAllocatedVUs` equals `maxVUs`), and a `dropped_iterations: ['count==0']` threshold makes k6 fail any run that misses its arrival schedule. Everything was then re-run from scratch with one code version; those runs are the folders directly under `results/`.

The drop runs here lost at most one shopper out of 8,249, but they were made with different code, so they are archived with the rest.
