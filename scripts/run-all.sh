#!/usr/bin/env bash
# Every recorded run in results/, in the order they were made.
# Naive and fixed runs are interleaved so that background load on the
# machine is spread across both. About 25 minutes in total.
#
# The published runs live in results/. To make your own, pick a new folder:
#   RESULTS_DIR=my-results scripts/run-all.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export RESULTS_DIR=${RESULTS_DIR:-results}
mkdir -p "$RESULTS_DIR"

node scripts/predict.mjs >"$RESULTS_DIR/predictions.json"

# Experiment 1: a 500-unit drop. Same scenario, two checkout paths.
for i in 1 2 3; do
  scripts/run.sh "drop-naive-$i" drop MODE=naive SEED="$i"
  scripts/run.sh "drop-reserve-$i" drop MODE=reserve SEED="$i"
done
scripts/run.sh low-naive-1 low MODE=naive SEED=1
scripts/run.sh low-reserve-1 low MODE=reserve SEED=1

# Experiment 2: a sustained peak at twice what payment can process.
for i in 1 2 3; do
  peak=(MODE=reserve STOCK=1000000 PAY_CONCURRENCY=8 SEED="$i" PATIENCE_S=15)
  scripts/run.sh "peak-queue-$i" peak "${peak[@]}"
  scripts/run.sh "peak-deadline-$i" peak "${peak[@]}" DEADLINE=1
  scripts/run.sh "peak-waitingroom-$i" peak "${peak[@]}" ADMIT_LIMIT=8
done

node scripts/summarize.mjs
