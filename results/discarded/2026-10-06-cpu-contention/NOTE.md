# Discarded runs: CPU contention from other work on the Pi

Two peak runs made with the final code (hash `ee3cfacd089bd589`) overlapped with a burst of unrelated work on the same Raspberry Pi. They are kept here as evidence and are not used for any number in the post or the main README. Both labels were re-run straight afterwards, once the 1-minute load average was back under 2.5; the re-runs are `results/peak-waitingroom-2` and `results/peak-deadline-3`.

| run | load average before, after | what went wrong |
|---|---|---|
| peak-waitingroom-2 | 3.61, 8.93 | k6 was starved of CPU. Shoppers that should give up after 15 s took up to 29 s, all 1,200 VUs ended up busy, and k6 skipped 253 of 2,559 scheduled shoppers (`dropped_iterations`). The run also shows 347 client timeouts, against 14 in the clean waiting-room runs. The `dropped_iterations` threshold failed it. |
| peak-deadline-3 | 4.30, 2.90 | k6 started 2,557 of 2,559 scheduled shoppers and the server saw 2,557 requests, but k6 reported no dropped iterations, so nothing failed the run. `scripts/summarize.mjs` now compares the shoppers started across runs of the same profile to catch this. |

For reference, the discarded peak-deadline-3 recorded 1,834 purchases and 635 skips at the deadline; the re-run recorded 1,834 and 636. `run-log.txt` is the console output of the batch that produced both discarded runs.
