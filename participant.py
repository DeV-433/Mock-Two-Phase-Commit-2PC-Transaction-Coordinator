#!/usr/bin/env python3
"""
Mock 2PC participant ("resource manager").

Each participant is a tiny bank that holds ONE account. During a transfer the
coordinator asks it to either debit or credit that account.

REST API
  POST /prepare   {tx_id, op: "debit"|"credit", amount}  -> {vote: "YES"|"NO", reason}
  POST /commit    {tx_id}                                -> {ack: true}
  POST /abort     {tx_id}                                -> {ack: true}
  GET  /state                                            -> balances, locks, mode, log
  POST /config    {mode: "yes"|"no"|"timeout"}           -> change how it votes
  POST /reset                                            -> restore initial balance

Modes (used to demonstrate the abort cases)
  yes      normal behaviour: vote YES if the operation is valid
  no       always vote NO   (e.g. a constraint/validation failure)
  timeout  sleep longer than the coordinator's vote timeout before answering
"""
import argparse
import os
import threading
import time

from flask import Flask, jsonify, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

parser = argparse.ArgumentParser(description="Mock 2PC participant")
parser.add_argument("--name", required=True, help="participant id, e.g. bank-a")
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--holder", default="Alice", help="account holder name")
parser.add_argument("--balance", type=int, default=500, help="initial balance")
parser.add_argument("--delay", type=float, default=3.5,
                    help="seconds to stall in 'timeout' mode (must exceed coordinator timeout)")
args = parser.parse_args()

app = Flask(__name__)
lock = threading.Lock()

state = {}            # mutable participant state, guarded by `lock`
log_entries = []      # in-memory copy of the log (also written to logs/<name>.log)


def reset_state():
    state["epoch"] = state.get("epoch", 0) + 1   # bumps on every reset; stale work from before is discarded
    state.update(
        balance=args.balance,
        reserved=0,        # money locked by prepared-but-undecided debits
        pending={},        # tx_id -> {op, amount}   (the "prepared" set)
        aborted=set(),     # tx_ids we have been told to abort
        mode=state.get("mode", "yes"),
    )


reset_state()


def log(tx_id, msg, kind="info"):
    ts = time.time()
    entry = {"ts": ts, "node": args.name, "tx": tx_id, "msg": msg, "kind": kind}
    log_entries.append(entry)
    del log_entries[:-200]
    stamp = time.strftime("%H:%M:%S", time.localtime(ts)) + f".{int(ts % 1 * 1000):03d}"
    line = f"{stamp} [{args.name}] [{tx_id or '-'}] {msg}"
    with open(os.path.join(LOG_DIR, f"{args.name}.log"), "a") as f:
        f.write(line + "\n")
    print(line, flush=True)


def read_body(*fields):
    """JSON body with the required fields, or None if it is malformed."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or any(f not in body for f in fields):
        return None
    return body


@app.post("/prepare")
def prepare():
    body = read_body("tx_id", "op", "amount")
    if body is None or body["op"] not in ("debit", "credit") or not isinstance(body["amount"], int) \
            or isinstance(body["amount"], bool):
        return jsonify(error="expected {tx_id, op: debit|credit, amount: int}"), 400
    tx_id, op, amount = str(body["tx_id"]), body["op"], body["amount"]
    log(tx_id, f"PREPARE received: {op} {amount}", "recv")

    with lock:
        epoch = state["epoch"]
        if tx_id in state["pending"]:          # duplicate PREPARE: we already promised, don't lock twice
            log(tx_id, "duplicate PREPARE: already prepared; voting YES again", "vote-yes")
            return jsonify(vote="YES", reason="")

    if state["mode"] == "timeout":
        log(tx_id, f"simulating a hung node: stalling {args.delay}s before voting", "warn")
        time.sleep(args.delay)

    with lock:
        # The coordinator may have given up on us and aborted while we stalled.
        if tx_id in state["aborted"]:
            log(tx_id, "woke up, but tx was already ABORTED by coordinator -> discard", "vote-no")
            return jsonify(vote="NO", reason="too late, already aborted")
        # The node was reset while we stalled: this request belongs to a previous run.
        if state["epoch"] != epoch:
            log(tx_id, "woke up after a reset: request is stale -> discard", "vote-no")
            return jsonify(vote="NO", reason="stale request from before a reset")

        available = state["balance"] - state["reserved"]
        if state["mode"] == "no":
            vote, reason = "NO", "participant configured to refuse"
        elif amount <= 0:
            vote, reason = "NO", "invalid amount"
        elif op == "debit" and available < amount:
            vote, reason = "NO", f"insufficient funds (available {available})"
        else:
            # Durably remember the promise, and lock the resources we need.
            state["pending"][tx_id] = {"op": op, "amount": amount}
            if op == "debit":
                state["reserved"] += amount
            vote, reason = "YES", ""

    if vote == "YES":
        log(tx_id, f"PREPARED: locked {op} {amount}; voting YES", "vote-yes")
    else:
        log(tx_id, f"voting NO: {reason}", "vote-no")
    return jsonify(vote=vote, reason=reason)


@app.post("/commit")
def commit():
    body = read_body("tx_id")
    if body is None:
        return jsonify(error="expected {tx_id}"), 400
    tx_id = str(body["tx_id"])
    with lock:
        p = state["pending"].pop(tx_id, None)
        if p:
            if p["op"] == "debit":
                state["reserved"] -= p["amount"]
                state["balance"] -= p["amount"]
            else:
                state["balance"] += p["amount"]
            balance = state["balance"]
    if p:
        log(tx_id, f"COMMIT applied: {p['op']} {p['amount']} -> balance {balance}; ACK", "commit")
    else:
        log(tx_id, "COMMIT for unknown/finished tx (idempotent); ACK", "info")
    return jsonify(ack=True)


@app.post("/abort")
def abort():
    body = read_body("tx_id")
    if body is None:
        return jsonify(error="expected {tx_id}"), 400
    tx_id = str(body["tx_id"])
    with lock:
        state["aborted"].add(tx_id)
        p = state["pending"].pop(tx_id, None)
        if p and p["op"] == "debit":
            state["reserved"] -= p["amount"]
    if p:
        log(tx_id, f"ABORT: released lock on {p['op']} {p['amount']}; ACK", "abort")
    else:
        log(tx_id, "ABORT: nothing was prepared, nothing to undo; ACK", "abort")
    return jsonify(ack=True)


@app.get("/state")
def get_state():
    with lock:
        return jsonify(
            name=args.name,
            holder=args.holder,
            balance=state["balance"],
            available=state["balance"] - state["reserved"],
            pending=[{"tx_id": k, **v} for k, v in state["pending"].items()],
            mode=state["mode"],
            log=log_entries[-100:],
        )


@app.post("/config")
def config():
    mode = (request.get_json(silent=True) or {}).get("mode")
    if mode not in ("yes", "no", "timeout"):
        return jsonify(error="mode must be yes | no | timeout"), 400
    state["mode"] = mode
    log(None, f"vote mode set to '{mode}'", "info")
    return jsonify(mode=mode)


@app.post("/reset")
def reset():
    with lock:
        state["mode"] = "yes"
        reset_state()
        log_entries.clear()
    log(None, f"reset: balance {args.balance}, mode 'yes'", "info")
    return jsonify(ok=True)


if __name__ == "__main__":
    log(None, f"participant {args.name} ({args.holder}) up on :{args.port}, balance {args.balance}", "info")
    app.run(host=args.host, port=args.port, threaded=True)
