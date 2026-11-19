#!/usr/bin/env bash
# Command-line demo: runs one successful and three aborted transactions against
# the REST coordinator (start ./run.sh first), then prints the coordinator log.
set -euo pipefail
C=${COORDINATOR:-http://localhost:5000}

post() { curl -s -X POST "$C$1" -H 'Content-Type: application/json' -d "$2"; }
mode() { post "/api/participants/$1/mode" "{\"mode\":\"$2\"}" >/dev/null; }
tx() {
  echo "== $1"
  post /api/transactions "{\"amount\":$2,\"from\":\"bank-a\",\"to\":\"bank-b\"}" |
    python3 -c 'import json,sys; t=json.load(sys.stdin); print("  ", t["tx_id"], t["outcome"], {n:(v["status"] if v["status"]!="OK" else v["vote"]) for n,v in t["votes"].items()})'
}

post /api/reset '{}' >/dev/null

mode bank-a yes; mode bank-b yes;     tx "SUCCESS: both vote YES"        100
mode bank-b no;                       tx "ABORT: bank-b votes NO"         100
mode bank-b yes;                      tx "ABORT: insufficient funds"      99999
mode bank-b timeout;                  tx "ABORT: bank-b times out"        100
mode bank-b yes

echo
echo "== Coordinator log"
curl -s "$C/api/log" | python3 -c 'import json,sys,time
for e in json.load(sys.stdin):
    print(time.strftime("%H:%M:%S", time.localtime(e["ts"])), ("[%s]" % (e["tx"] or "-")).ljust(7), e["msg"])'
