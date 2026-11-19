#!/usr/bin/env python3
"""
Two-Phase Commit coordinator (REST) + web dashboard.

  Phase 1 (voting):   send PREPARE to every participant, collect YES/NO votes.
                      A missing reply within VOTE_TIMEOUT counts as NO.
  Decision:           COMMIT only if *all* voted YES, otherwise ABORT.
                      The decision is written to the coordinator log (fsync)
                      BEFORE phase 2 starts - this is the point of no return.
  Phase 2 (decision): send COMMIT/ABORT to every participant, collect ACKs.

REST API
  POST /api/transactions              {amount, from, to}  -> run one 2PC transfer
  GET  /api/transactions                                  -> history
  GET  /api/log                                           -> coordinator log
  GET  /api/state                                         -> everything the UI needs
  POST /api/participants/<name>/mode  {mode}              -> yes | no | timeout
  POST /api/reset                                         -> reset all nodes
"""
import argparse
import itertools
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
LOG_DIR = os.path.join(BASE_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

VOTE_TIMEOUT = float(os.environ.get("VOTE_TIMEOUT", "2.0"))   # seconds
MAX_AMOUNT = 10**12
MAX_HISTORY = 500
ACK_RETRIES = 3


def parse_participants(spec):
    out = {}
    for item in spec.split(","):
        name, url = item.split("=", 1)
        out[name.strip()] = url.strip().rstrip("/")
    return out


PARTICIPANTS = parse_participants(os.environ.get(
    "PARTICIPANTS", "bank-a=http://127.0.0.1:5001,bank-b=http://127.0.0.1:5002"))

app = Flask(__name__, static_folder=None)
log_lock = threading.Lock()
tx_lock = threading.Lock()          # one transaction at a time keeps the demo readable
log_entries, transactions = [], []
counter = itertools.count(1)


def log(tx_id, msg, kind="info"):
    ts = time.time()
    entry = {"ts": ts, "node": "coordinator", "tx": tx_id, "msg": msg, "kind": kind}
    stamp = time.strftime("%H:%M:%S", time.localtime(ts)) + f".{int(ts % 1 * 1000):03d}"
    line = f"{stamp} [coordinator] [{tx_id or '-'}] {msg}"
    with log_lock:
        log_entries.append(entry)
        del log_entries[:-300]
        with open(os.path.join(LOG_DIR, "coordinator.log"), "a") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())    # make the record durable (matters for the DECISION line)
    print(line, flush=True)


def call(name, path, body, timeout):
    """POST to a participant. Returns (json | None, error | None, elapsed_ms)."""
    t0 = time.time()
    try:
        r = requests.post(PARTICIPANTS[name] + path, json=body, timeout=timeout)
        r.raise_for_status()
        return r.json(), None, (time.time() - t0) * 1000
    except requests.Timeout:
        return None, "TIMEOUT", (time.time() - t0) * 1000
    except requests.RequestException:
        return None, "UNREACHABLE", (time.time() - t0) * 1000


def run_2pc(amount, src, dst):
    tx_id = f"T{next(counter):03d}"
    started = time.time()
    ops = {src: {"op": "debit", "amount": amount}, dst: {"op": "credit", "amount": amount}}

    log(tx_id, f"BEGIN transfer {amount}: debit {src}, credit {dst}", "begin")

    # ---------------- Phase 1: PREPARE / vote ----------------
    log(tx_id, f"PHASE 1: PREPARE -> {', '.join(ops)} (timeout {VOTE_TIMEOUT}s)", "phase")
    votes = {}
    with ThreadPoolExecutor(len(ops)) as pool:
        futures = {n: pool.submit(call, n, "/prepare", {"tx_id": tx_id, **op}, VOTE_TIMEOUT)
                   for n, op in ops.items()}
        for name, fut in futures.items():
            res, err, ms = fut.result()
            if err:
                vote, reason = "NO", ("no vote within timeout" if err == "TIMEOUT" else "participant unreachable")
            else:
                vote, reason = res["vote"], res.get("reason", "")
            votes[name] = {"vote": vote, "reason": reason, "status": err or "OK", "ms": round(ms)}
            shown = err if err else vote
            log(tx_id, f"vote from {name}: {shown}" + (f" ({reason})" if reason else ""),
                "vote-yes" if vote == "YES" else "vote-no")

    # ---------------- Decision (point of no return) ----------------
    decision = "COMMIT" if all(v["vote"] == "YES" for v in votes.values()) else "ABORT"
    log(tx_id, f"DECISION = {decision}  (forced to log before phase 2)",
        "commit" if decision == "COMMIT" else "abort")

    # ---------------- Phase 2: COMMIT/ABORT + ACK ----------------
    log(tx_id, f"PHASE 2: {decision} -> {', '.join(ops)}", "phase")
    path = "/commit" if decision == "COMMIT" else "/abort"

    def deliver(name):
        for attempt in range(1, ACK_RETRIES + 1):
            res, err, ms = call(name, path, {"tx_id": tx_id}, 3)
            if not err:
                return {"ok": True, "attempts": attempt, "ms": round(ms)}
            log(tx_id, f"no ACK from {name} ({err}), retry {attempt}/{ACK_RETRIES}", "warn")
            time.sleep(0.3)
        return {"ok": False, "attempts": ACK_RETRIES, "ms": None}

    with ThreadPoolExecutor(len(ops)) as pool:
        acks = dict(zip(ops, pool.map(deliver, ops)))
    for name, a in acks.items():
        if a["ok"]:
            log(tx_id, f"ACK from {name}", "recv")
        else:
            log(tx_id, f"{name} never ACKed - must re-send {decision} when it recovers", "warn")

    outcome = "COMMITTED" if decision == "COMMIT" else "ABORTED"
    duration = round((time.time() - started) * 1000)
    log(tx_id, f"END {outcome} in {duration} ms", "end")

    tx = {"tx_id": tx_id, "amount": amount, "from": src, "to": dst, "votes": votes,
          "decision": decision, "outcome": outcome, "acks": acks,
          "started": started, "duration_ms": duration}
    transactions.append(tx)
    del transactions[:-MAX_HISTORY]
    return tx


# ---------------------------- REST API ----------------------------

@app.post("/api/transactions")
def create_transaction():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error="expected a JSON object: {amount, from, to}"), 400
    amount = body.get("amount")
    if isinstance(amount, float) and amount.is_integer():
        amount = int(amount)
    if not isinstance(amount, int) or isinstance(amount, bool):
        return jsonify(error="amount must be a whole number"), 400
    if abs(amount) > MAX_AMOUNT:
        return jsonify(error=f"amount must be at most {MAX_AMOUNT:,}"), 400
    # Zero or negative amounts are allowed on purpose: participants vote NO on them, which shows an abort.
    src, dst = body.get("from", "bank-a"), body.get("to", "bank-b")
    if src not in PARTICIPANTS or dst not in PARTICIPANTS or src == dst:
        return jsonify(error=f"from/to must be two different participants of {list(PARTICIPANTS)}"), 400
    with tx_lock:
        return jsonify(run_2pc(amount, src, dst))


@app.get("/api/transactions")
def list_transactions():
    return jsonify(transactions[::-1])


@app.get("/api/log")
def get_log():
    return jsonify(log_entries)


@app.get("/api/state")
def get_state():
    def fetch(name):
        try:
            r = requests.get(PARTICIPANTS[name] + "/state", timeout=1)
            return {**r.json(), "online": True}
        except requests.RequestException:
            return {"name": name, "online": False, "log": []}

    with ThreadPoolExecutor(len(PARTICIPANTS)) as pool:
        parts = dict(zip(PARTICIPANTS, pool.map(fetch, PARTICIPANTS)))

    merged = list(log_entries)
    for p in parts.values():
        merged.extend(p.pop("log", []))
    merged.sort(key=lambda e: e["ts"])

    return jsonify(participants=parts, transactions=transactions[::-1][:25],
                   log=merged[-250:], vote_timeout=VOTE_TIMEOUT)


@app.post("/api/participants/<name>/mode")
def set_mode(name):
    if name not in PARTICIPANTS:
        return jsonify(error="unknown participant"), 404
    try:
        r = requests.post(PARTICIPANTS[name] + "/config", json=request.get_json(silent=True) or {}, timeout=2)
        return jsonify(r.json()), r.status_code
    except ValueError:
        return jsonify(error=f"{name} sent an invalid reply"), 502
    except requests.RequestException:
        return jsonify(error=f"{name} unreachable"), 502


@app.post("/api/reset")
def reset():
    # Transaction ids keep counting across resets so they stay unique: a participant
    # that was stalled during the reset may still log a late line for an old id.
    with tx_lock:
        for url in PARTICIPANTS.values():
            try:
                requests.post(url + "/reset", timeout=2)
            except requests.RequestException:
                pass
        log_entries.clear()
        transactions.clear()
        log(None, "coordinator reset", "info")
    return jsonify(ok=True)


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="2PC coordinator")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5000)
    a = ap.parse_args()
    log(None, f"coordinator up on :{a.port}; participants = {PARTICIPANTS}", "info")
    app.run(host=a.host, port=a.port, threaded=True)
