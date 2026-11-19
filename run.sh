#!/usr/bin/env bash
# Starts the two mock participants and the coordinator. Ctrl+C stops all three.
set -euo pipefail
cd "$(dirname "$0")"

PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python

mkdir -p logs
pids=()
cleanup() { echo; echo "Stopping..."; kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup INT TERM EXIT

$PY participant.py --name bank-a --port 5001 --holder Alice --balance 500 & pids+=($!)
$PY participant.py --name bank-b --port 5002 --holder Bob   --balance 200 & pids+=($!)
sleep 1
$PY coordinator.py --port 5000 & pids+=($!)

sleep 1
echo
echo "  2PC lab running  ->  http://localhost:5000   (Ctrl+C to stop)"
echo
wait
