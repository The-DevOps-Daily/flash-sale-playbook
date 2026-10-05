#!/usr/bin/env bash
# Run one labelled experiment: start the server with the given settings,
# drive it with k6, save everything under results/<label>/.
#
#   scripts/run.sh <label> <profile> [VAR=value ...]
#   scripts/run.sh drop-naive-1 drop MODE=naive SEED=1
set -euo pipefail

label=${1:?label}
profile=${2:?profile}
shift 2

root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/results/$label"
if [[ -e "$out" ]]; then
  echo "refusing to overwrite $out; pick a new label or delete it" >&2
  exit 1
fi
mkdir -p "$out"

port=${PORT:-3333}
k6bin=${K6:-k6}
code_hash=$(cat "$root/server.mjs" "$root/k6/flash-sale.js" | sha256sum | cut -c1-16)

# Server settings: defaults first, then whatever was passed on the command line.
server_env=(PORT="$port" MODE=naive STOCK=500 PAY_MIN_MS=100 PAY_MAX_MS=400 DECLINE_RATE=0.05 SEED=42)
k6_env=()
for kv in "$@"; do
  case "$kv" in
    PATIENCE_S=*) k6_env+=(-e "$kv") ;;
    *) server_env+=("$kv") ;;
  esac
done

load_before=$(cut -d' ' -f1-3 /proc/loadavg)
env -i PATH="$PATH" "${server_env[@]}" node "$root/server.mjs" >"$out/server.log" 2>&1 &
server_pid=$!
trap 'kill $server_pid 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:$port/health" >/dev/null && break
  sleep 0.1
done

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
set +e
"$k6bin" run --no-color -q \
  -e PROFILE="$profile" -e BASE_URL="http://127.0.0.1:$port" "${k6_env[@]}" \
  --summary-export "$out/k6-summary.json" \
  "$root/k6/flash-sale.js" >"$out/k6-output.txt" 2>&1
k6_exit=$?
set -e

curl -sf "http://127.0.0.1:$port/stats" >"$out/server-stats.json"
curl -sf "http://127.0.0.1:$port/orders.csv" >"$out/orders.csv"
kill $server_pid
wait $server_pid 2>/dev/null || true
load_after=$(cut -d' ' -f1-3 /proc/loadavg)

OUT="$out" node -e '
const [label, profile, started, codeHash, k6Exit, lb, la, k6v, env, k6env] = process.argv.slice(1);
const fs = require("fs"), os = require("os");
fs.writeFileSync(process.env.OUT + "/run.json", JSON.stringify({
  label, profile, started, codeHash, k6Exit: Number(k6Exit),
  serverEnv: Object.fromEntries(env.split(" ").map((kv) => kv.split("="))), k6Env: k6env ? k6env.split(" ").filter((x) => x !== "-e") : [],
  host: { model: fs.existsSync("/proc/device-tree/model") ? fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "") : os.cpus()[0].model,
          cpus: os.cpus().length, loadBefore: lb, loadAfter: la },
  node: process.version, k6: k6v,
}, null, 2) + "\n");
' "$label" "$profile" "$started" "$code_hash" "$k6_exit" "$load_before" "$load_after" \
  "$("$k6bin" version | head -1)" "${server_env[*]}" "${k6_env[*]:-}"
echo "$label: k6 exit $k6_exit, results in results/$label"
