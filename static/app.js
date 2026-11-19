// =========================================================
// Commit Panel: front-end for the 2PC coordinator
// =========================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const icon = (id, cls = "") => `<svg class="ic ${cls}"><use href="#i-${id}"/></svg>`;
const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const fmtDec = (n, d = 2) => n.toFixed(d).replace(".", ",");
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

let slow = false;
const speed = () => (slow ? 2.2 : 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed()));

const NODE = {
  coordinator: { name: "Coordinator", port: ":5000", icon: "hub" },
  "bank-a": { name: "Bank A", port: ":5001", icon: "bank" },
  "bank-b": { name: "Bank B", port: ":5002", icon: "bank" },
};
const GREEN = "#4fdc66", INK = "#0e0e0e";

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 3000);
}

function pulse(el, cls, ms) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

function tween(el, to, fmt, dur = 900) {
  const from = parseFloat(el.dataset.v ?? to);
  el.dataset.v = to;
  if (from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = fmt(from + (to - from) * ease(p));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setBar(bar, black, green) {
  $(".seg.black", bar).style.width = `calc((85% - 4px) * ${black})`;
  $(".seg.green", bar).style.width = `calc((85% - 4px) * ${green})`;
}

// ---------------------------------------------------------
// Protocol canvas
// ---------------------------------------------------------
const canvas = $("#canvas"), fx = $("#fx");
let geo = { W: 800, H: 300, pos: {} };

function layout() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const W = 800, H = Math.round((800 * h) / w), tall = h / w > 0.75;
  const pos = {
    coordinator: { x: W / 2, y: H * (tall ? 0.16 : 0.22) },
    "bank-a": { x: W * (tall ? 0.27 : 0.17), y: H * (tall ? 0.82 : 0.75) },
    "bank-b": { x: W * (tall ? 0.73 : 0.83), y: H * (tall ? 0.82 : 0.75) },
  };
  $("#wires").setAttribute("viewBox", `0 0 ${W} ${H}`);
  const c = pos.coordinator;
  for (const b of ["bank-a", "bank-b"]) {
    const p = pos[b];
    const d = `M${c.x} ${c.y} Q ${p.x} ${c.y} ${p.x} ${p.y}`;
    $(`#wire-${b}`).setAttribute("d", d);
    $(`#on-${b}`).setAttribute("d", d);
  }
  for (const [id, p] of Object.entries(pos)) {
    const n = $(`.node[data-node="${id}"]`);
    n.style.left = (p.x / W) * 100 + "%";
    n.style.top = (p.y / H) * 100 + "%";
  }
  geo = { W, H, pos };
}
new ResizeObserver(layout).observe(canvas);
const pct = (p) => ({ left: (p.x / geo.W) * 100 + "%", top: (p.y / geo.H) * 100 + "%" });

function setNode(id, cls = "", status) {
  const n = $(`.node[data-node="${id}"]`);
  n.className = `node ${cls}`;
  if (status !== undefined) $(".n-status", n).textContent = `${NODE[id].port} · ${status}`;
}

function fxAt(cls, point, color, vars = {}) {
  const el = document.createElement("div");
  el.className = cls;
  Object.assign(el.style, pct(point));
  el.style.setProperty("--rc", color);
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  fx.append(el);
  return el;
}
function ring(id, color) {
  const el = fxAt("ring", geo.pos[id], color);
  setTimeout(() => el.remove(), 800);
  pulse($(`.node[data-node="${id}"]`), "ping", 460);
}
function wave(id, color) {
  const el = fxAt("wave", geo.pos[id], color);
  setTimeout(() => el.remove(), 1050);
}
function burst(id, color, n = 14) {
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.3, d = 70 + Math.random() * 50;
    const el = fxAt("dot-burst", geo.pos[id], i % 2 ? color : INK, { "--dx": Math.cos(a) * d + "px", "--dy": Math.sin(a) * d + "px" });
    setTimeout(() => el.remove(), 850);
  }
}
async function flag(bank, label) {
  const path = $(`#wire-${bank}`);
  const mid = path.getPointAtLength(path.getTotalLength() * 0.5);
  const el = document.createElement("div");
  el.className = "flag";
  el.innerHTML = `${icon("clock")}${esc(label)}`;
  Object.assign(el.style, pct(mid));
  el.style.animationDuration = 1.5 * speed() + "s";
  fx.append(el);
  await sleep(1500);
  el.remove();
}

// kind: "black" | "green" | "white"
function packet(bank, dir, label, kind, dur = 950) {
  const path = $(`#wire-${bank}`), on = $(`#on-${bank}`);
  const L = path.getTotalLength();
  on.style.setProperty("--on", kind === "green" ? GREEN : INK);
  on.classList.toggle("rev", dir === "up");
  on.classList.add("on");
  const el = document.createElement("div");
  el.className = `pkt ${kind}`;
  el.textContent = label;
  fx.append(el);
  return new Promise((resolve) => {
    const t0 = performance.now(), D = dur * speed();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / D), e = ease(p);
      Object.assign(el.style, pct(path.getPointAtLength((dir === "down" ? e : 1 - e) * L)));
      if (p < 1) return requestAnimationFrame(step);
      el.classList.add("out");
      on.classList.remove("on");
      setTimeout(() => el.remove(), 280);
      ring(dir === "down" ? bank : "coordinator", kind === "green" ? GREEN : INK);
      resolve();
    };
    requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------
// Steps + gauge
// ---------------------------------------------------------
const STEPS = ["begin", "prepare", "decision", "phase2", "done"];
const STEP_NAME = { begin: "begin", prepare: "prepare", decision: "decide", phase2: "commit / abort", done: "done" };

function setStep(step, decision) {
  const idx = STEPS.indexOf(step);
  $$("#steps li").forEach((li, i) => {
    li.className = i < idx ? "done" : i === idx ? "active" : "";
    if (i === idx && decision === "COMMIT" && i >= 3) li.classList.add("commit");
  });
  $("#phase2-label").textContent = decision ? (decision === "COMMIT" ? "Commit" : "Abort") : "Commit / Abort";
  if (idx >= 0) setGauge((idx + 1) / STEPS.length, `${idx + 1}<sup>/5</sup>`, STEP_NAME[step]);
}

const gTrack = $("#g-track"), G_LEN = gTrack.getTotalLength();
let gNow = 0, gAnim = 0;
function drawGauge(p) {
  const L = G_LEN, head = Math.min(p * L, 0.12 * L);
  $("#g-prog").style.strokeDasharray = `${Math.max(0, p * L - head)} ${L}`;
  $("#g-head").style.strokeDasharray = `0 ${Math.max(0, p * L - head)} ${head} ${L}`;
  const pt = gTrack.getPointAtLength(p * L);
  $("#g-dot").setAttribute("cx", pt.x);
  $("#g-dot").setAttribute("cy", pt.y);
  $("#g-dot").style.opacity = p > 0.001 ? 1 : 0;
}
function setGauge(p, numHtml, label) {
  $("#g-num").innerHTML = numHtml;
  $("#g-label").textContent = label;
  const from = gNow, t0 = performance.now(), id = ++gAnim;
  const step = (now) => {
    if (id !== gAnim) return;
    const k = Math.min(1, (now - t0) / 700);
    gNow = from + (p - from) * ease(k);
    drawGauge(gNow);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------
// State + rendering
// ---------------------------------------------------------
let state = { participants: {}, transactions: [], log: [], vote_timeout: 2 };
let busy = false;
let route = ["bank-a", "bank-b"];
const holder = (id) => state.participants[id]?.holder || NODE[id]?.name || id;

// Clears everything the page derived from earlier server state. Used by the
// reset button and when the server was reset/restarted from somewhere else.
function clearViews() {
  chat.innerHTML = "";
  rendered.clear();
  viewKey = undefined;
  focusTx = null;
  for (const el of insightEls.values()) el.remove();
  insightEls.clear();
  for (const card of $$(".bank")) delete card.dataset.sig;
}

let lastTop = 0;
async function refresh() {
  let next;
  try {
    next = await api("/api/state");
  } catch {
    renderCluster(false);
    return;
  }
  // Transaction ids only grow, so a smaller newest id means the server was reset or restarted.
  const top = Math.max(0, ...next.transactions.map((t) => parseInt(t.tx_id.slice(1), 10) || 0));
  if (top < lastTop && !busy) clearViews();
  lastTop = top;
  state = next;
  renderCluster(true);
  renderBanks();
  renderChat();
  renderRoute();
  if (busy) return; // don't reveal the outcome before the animation reaches it
  renderStats();
  renderInsights();
  renderIdleGauge();
}

function renderCluster(coordOk) {
  const on = [coordOk, ...["bank-a", "bank-b"].map((k) => coordOk && state.participants[k]?.online)];
  $$("#cluster-dots i").forEach((d, i) => d.classList.toggle("on", !!on[i]));
  $("#cluster-count").textContent = `${on.filter(Boolean).length} / 3`;
  if (busy) return;
  for (const k of ["bank-a", "bank-b"]) {
    const n = $(`.node[data-node="${k}"]`);
    const online = coordOk && state.participants[k]?.online;
    if (!online) setNode(k, "offline", "offline");
    else if (n.classList.contains("offline")) setNode(k, "", "idle");
  }
}

function renderStats() {
  const tx = state.transactions, total = tx.length;
  const c = tx.filter((t) => t.decision === "COMMIT").length;
  tween($("#rate-num"), total ? (c / total) * 100 : 0, (v) => fmtDec(v));
  tween($("#rate-c"), c, fmtInt);
  tween($("#rate-t"), total, fmtInt);
  setBar($("#rate-bar"), total ? (total - c) / total : 0, total ? c / total : 0);

  const a = state.participants["bank-a"], b = state.participants["bank-b"];
  if (a?.online && b?.online) {
    tween($("#money-num"), a.balance + b.balance, fmtInt);
    tween($("#money-a"), a.balance, fmtInt);
    tween($("#money-b"), b.balance, fmtInt);
    $("#money-a-l").textContent = `${a.holder} · Bank A`;
    $("#money-b-l").textContent = `${b.holder} · Bank B`;
    const s = a.balance + b.balance || 1;
    setBar($("#money-bar"), a.balance / s, b.balance / s);
  }
}

function renderIdleGauge() {
  const last = state.transactions[0];
  const votes = last ? Object.values(last.votes) : [];
  $("#g-yes").textContent = votes.filter((v) => v.vote === "YES").length;
  $("#g-no").textContent = votes.filter((v) => v.vote !== "YES").length;
  if (last) setGauge(1, `${fmtInt(last.duration_ms)}<sup>ms</sup>`, `${last.tx_id} · ${last.outcome.toLowerCase()}`);
  else setGauge(0, "—", "idle");
}

// balance history for one bank, rebuilt from the transaction list
function bankSeries(id, current) {
  const txs = [...state.transactions].reverse();
  let bal = current;
  const after = new Array(txs.length);
  for (let i = txs.length - 1; i >= 0; i--) {
    after[i] = bal;
    const t = txs[i];
    if (t.decision === "COMMIT") { if (t.from === id) bal += t.amount; else if (t.to === id) bal -= t.amount; }
  }
  return { start: bal, items: txs.map((t, i) => ({ v: after[i], tx: t.tx_id, c: t.decision === "COMMIT" })) };
}

function renderChart(card, id, p) {
  const svg = $(".bars", card);
  const W = 560, H = 120, N = 56, M = 40, slot = W / N;
  const { start, items } = bankSeries(id, p.balance);
  const shown = items.slice(-M);
  const slots = Array.from({ length: M }, (_, i) => {
    const k = i - (M - shown.length);
    return k >= 0 ? { ...shown[k], kind: shown[k].c ? "b-c" : "b-ab" } : { v: start, kind: "b-pad" };
  });
  const vals = slots.map((s) => s.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const hOf = (v) => (hi === lo ? 0.46 : 0.22 + (0.6 * (v - lo)) / (hi - lo)) * (H - 14);
  let html = "";
  const pts = [];
  slots.forEach((s, i) => {
    const h = hOf(s.v), x = i * slot + slot / 2 - 1.25;
    html += `<rect class="${s.kind}" x="${x}" y="${H - h}" width="2.5" height="${h}"><title>${s.tx ? s.tx + ": " : ""}${fmtInt(s.v)}</title></rect>`;
    pts.push([i * slot + slot / 2, H - h - 8]);
  });
  html += `<rect class="b-mark" x="${M * slot - 1}" y="6" width="2" height="${H - 6}"/>`;
  for (let i = M + 1; i < N; i++) html += `<rect class="b-tick" x="${i * slot + slot / 2 - 0.75}" y="${H - 26}" width="1.5" height="26"/>`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], mx = (x0 + x1) / 2;
    d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
  }
  html += `<path class="b-line" d="${d}"/>`;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = html;
  $(".ax-l", card).textContent = shown.length ? shown[0].tx : "start";
}

function renderBanks() {
  for (const card of $$(".bank")) {
    const id = card.dataset.node, p = state.participants[id];
    if (!p?.online) { card.style.opacity = 0.5; continue; }
    card.style.opacity = 1;
    $(".holder", card).textContent = p.holder;
    const bal = $(".v-bal", card), prev = parseFloat(bal.dataset.v);
    if (!Number.isNaN(prev) && prev !== p.balance) pulse(bal.parentElement, p.balance > prev ? "up" : "down", 1400);
    tween(bal, p.balance, fmtInt);
    tween($(".v-avail", card), p.available, fmtInt);
    const locked = p.balance - p.available, lk = $(".v-lock", card);
    lk.textContent = fmtInt(locked);
    lk.classList.toggle("has", locked > 0);
    $(".v-mode", card).textContent = p.mode === "timeout" ? "Timeout" : p.mode.toUpperCase();
    const sw = $(".seg3", card);
    if (!sw.dataset.pending) sw.dataset.mode = p.mode;
    $$("button", sw).forEach((b) => (b.disabled = busy));
    if (busy) continue;
    const last = state.transactions.find((t) => t.votes[id]);
    $(".v-last", card).textContent = last ? (last.votes[id].status === "OK" ? last.votes[id].vote : last.votes[id].status) : "—";
    const sig = state.transactions.map((t) => t.tx_id).join() + "|" + p.balance;
    if (card.dataset.sig !== sig) { card.dataset.sig = sig; renderChart(card, id, p); }
  }
}

// ---- stacked insight cards ----
function insightParts(t) {
  if (!t) return { icon: "bolt", title: "<b>Ready</b> · no transactions yet", text: "Run a scenario to watch <b>prepare</b> → <b>commit / abort</b>", meta: "" };
  const meta = `${fmtInt(t.duration_ms)}<small>ms</small>`;
  const title = `<b>${t.tx_id}</b> · ${t.decision === "COMMIT" ? "Committed" : "Aborted"}`;
  if (t.decision === "COMMIT")
    return { icon: "check", title, meta, text: `Moved <b>${fmtInt(t.amount)}</b> from ${esc(holder(t.from))} to ${esc(holder(t.to))}` };
  const [n, v] = Object.entries(t.votes).find(([, v]) => v.vote !== "YES") || ["?", {}];
  let text = `${n} voted <b>NO</b>, so no balance changed`;
  if (v.status === "TIMEOUT") text = `${n} stayed silent past the <b>${fmtDec(state.vote_timeout, 1)} s</b> vote timeout`;
  else if (v.status === "UNREACHABLE") text = `${n} was <b>unreachable</b>, nothing changed`;
  else if ((v.reason || "").startsWith("insufficient")) text = `${esc(holder(n))} can't cover <b>${fmtInt(t.amount)}</b>, nothing moved`;
  return { icon: "x", title, meta, text };
}

const insightEls = new Map();
$("#insights").addEventListener("click", (e) => e.currentTarget.classList.toggle("open"));
document.addEventListener("click", (e) => { if (!e.target.closest("#insights")) $("#insights").classList.remove("open"); });
function renderInsights() {
  const box = $("#insights");
  const list = state.transactions.slice(0, 3);
  const keys = list.length ? list.map((t) => t.tx_id) : ["ready"];
  for (const [k, el] of insightEls) {
    if (!keys.includes(k)) {
      el.className = el.className.replace(/\bp\d\b/, "p3");
      setTimeout(() => el.remove(), 750);
      insightEls.delete(k);
    }
  }
  keys.forEach((k, i) => {
    let el = insightEls.get(k);
    if (!el) {
      const t = list[i], part = insightParts(t);
      el = document.createElement("div");
      el.className = `ins ${t && t.decision !== "COMMIT" ? "abort" : ""} enter`;
      el.innerHTML = `<span class="ins-icon">${icon(part.icon, part.icon === "bolt" ? "bolt" : "")}</span>
        <div class="ins-body">
          <div class="ins-eyebrow">${t ? "Transaction outcome" : "Outcome insights"}</div>
          <div class="ins-title">${part.title}</div>
          <p class="ins-text">${part.text}</p>
        </div>
        <div class="ins-meta">${icon("arrow")}<b>${part.meta}</b></div>`;
      box.append(el);
      insightEls.set(k, el);
      void el.offsetWidth;
    }
    el.classList.remove("enter", "p0", "p1", "p2", "p3");
    el.classList.add(`p${i}`);
  });
  let hint = $(".deck-hint", box);
  if (!hint) { hint = document.createElement("span"); hint.className = "deck-hint"; box.append(hint); }
  hint.textContent = list.length > 1 ? `hover or tap to see last ${list.length}` : "";
  $$(".pager i").forEach((d, i) => d.classList.toggle("on", i === state.transactions.length % 3));
}

// ---- transaction-scoped log ----
// The panel shows only the latest transaction. Pulling up at the top of the
// list loads the previous transaction above it, one at a time.
const chat = $("#chat");
let filterNode = "all", filterText = "";
let groups = [], pending = [];
let focusTx = null;          // a pinned transaction, else follow the latest
let viewKey;                 // which transaction the view is anchored on
let shownFrom = 0;           // index (in groups) of the oldest transaction in the DOM
const rendered = new Map();  // tx id -> { section, body, head, keys, last, endEl, summarized }
const PULL = 220;
let pull = 0, pullT;

function matches(node, text) {
  return (filterNode === "all" || node === filterNode) && (!filterText || text.toLowerCase().includes(filterText));
}
function applyFilters() {
  $$("#chat .msg, #chat .summary").forEach((el) => el.classList.toggle("hide", !matches(el.dataset.node, el.dataset.text)));
}

// Split the merged log into one group per transaction. Untagged lines (mode
// changes, resets) belong to the transaction that follows them.
function groupLog(log) {
  const out = [], byTx = new Map();
  // Only transactions whose BEGIN we can see get their own section; stray late
  // lines for an older id (e.g. a node waking up after a reset) are shown untagged.
  const begun = new Set(state.transactions.map((t) => t.tx_id));
  for (const e of log) if (e.kind === "begin" && e.node === "coordinator") begun.add(e.tx);
  let pre = [];
  for (const e of log) {
    if (!e.tx || !begun.has(e.tx)) { pre.push(e); continue; }
    let g = byTx.get(e.tx);
    if (!g) { g = { tx: e.tx, entries: pre }; pre = []; byTx.set(e.tx, g); out.push(g); }
    g.entries.push(e);
  }
  return { groups: out, pending: pre };
}

const txMeta = (id) => state.transactions.find((t) => t.tx_id === id);

function headHtml(g) {
  if (!g.tx) return `<span class="th-id idle">—</span><span class="th-route">Between transactions</span><em>IDLE</em>`;
  const t = isLive(g.tx) ? null : txMeta(g.tx);
  let route = "starting…", badge = `<em class="run">RUNNING</em>`;
  if (t) {
    route = `${esc(holder(t.from))} → ${esc(holder(t.to))} · ${fmtInt(t.amount)}`;
    badge = `<em class="${t.decision === "COMMIT" ? "commit" : "abort"}">${t.outcome}</em>`;
  } else {
    const b = g.entries.find((e) => e.kind === "begin");
    const m = b && /transfer (\d+): debit (\S+), credit (\S+)/.exec(b.msg);
    if (m) route = `${esc(holder(m[2]))} → ${esc(holder(m[3]))} · ${fmtInt(+m[1])}`;
  }
  return `<span class="th-id">${g.tx}</span><span class="th-route">${route}</span>${badge}`;
}

function buildSection(g) {
  const section = document.createElement("section");
  section.className = "tx-group";
  section.dataset.tx = g.tx || "";
  section.innerHTML = `<header class="tx-head"></header><div class="tx-body"></div>`;
  const st = { section, head: $(".tx-head", section), body: $(".tx-body", section), keys: new Set(), last: null, endEl: null, summarized: false };
  rendered.set(g.tx || "__pending", st);
  return st;
}

function fillSection(st, g, animate) {
  let i = 0, added = 0;
  for (const e of g.entries) {
    const key = `${e.ts}|${e.node}|${e.msg}`;
    if (st.keys.has(key) || gated(e)) continue;
    st.keys.add(key);
    const el = document.createElement("div");
    el.className = `msg k-${e.kind}${st.last === e.node ? " cont" : ""}${animate ? " new" : ""}`;
    el.dataset.node = e.node;
    el.dataset.text = `${e.tx || ""} ${e.msg}`;
    if (animate) el.style.animationDelay = i++ * 30 + "ms";
    const d = new Date(e.ts * 1000);
    el.innerHTML = `<span class="avatar ${e.node}">${icon(NODE[e.node]?.icon || "hub")}</span>
      <b class="who">${NODE[e.node]?.name || e.node}</b>
      <p><span class="k"></span>${esc(e.msg)}</p>
      <time>${d.toLocaleTimeString([], { hour12: false })}</time>`;
    st.body.append(el);
    st.last = e.node;
    if (e.kind === "end") st.endEl = el;
    added++;
  }
  if (!st.summarized && st.endEl && !isLive(g.tx) && txMeta(g.tx)) {
    const sum = summaryEl(txMeta(g.tx), animate);
    st.endEl.after(sum);
    st.summarized = true;
    if (sum === st.body.lastElementChild) st.last = null;
    added++;
  }
  st.head.innerHTML = headHtml(g);
  return added;
}

function summaryEl(t, animate = true) {
  const el = document.createElement("div");
  const commit = t.decision === "COMMIT";
  el.className = `summary ${commit ? "commit" : "abort"}${animate ? " new" : ""}`;
  el.dataset.node = "coordinator";
  el.dataset.text = `${t.tx_id} ${t.outcome}`;
  const yes = Object.values(t.votes).filter((v) => v.vote === "YES").length, n = Object.keys(t.votes).length;
  el.innerHTML = `<h4>Votes &amp; decision<em>${t.outcome}</em></h4>
    <ul>${Object.entries(t.votes).map(([k, v]) => `<li class="${v.vote === "YES" ? "yes" : "no"}"><span>${k}</span><b>${v.status === "OK" ? v.vote : v.status} · ${v.ms} ms</b></li>`).join("")}</ul>
    <div class="bar"><span class="seg black"></span><span class="seg green"></span><span class="track"></span><span class="mark"></span><span class="hatch"></span></div>`;
  requestAnimationFrame(() => setBar($(".bar", el), (n - yes) / n, yes / n));
  return el;
}

function hintEl() {
  let h = $("#pull-hint");
  if (!h) {
    h = document.createElement("button");
    h.id = "pull-hint";
    h.type = "button";
    h.className = "pull-hint";
    h.innerHTML = `<span class="ph-bar"><i></i></span><span class="ph-text"></span>`;
    h.addEventListener("click", loadPrevious);
    chat.prepend(h);
  }
  return h;
}
function updateHint() {
  const h = hintEl();
  const prev = groups[shownFrom - 1];
  h.classList.toggle("done", !prev);
  $(".ph-text", h).textContent = prev ? `Pull up to load ${prev.tx}` : groups.length ? "Start of log" : "";
}
function setPull(p) { hintEl().style.setProperty("--p", Math.min(1, p)); }

function loadPrevious() {
  if (shownFrom <= 0) return;
  const g = groups[shownFrom - 1];
  const h0 = chat.scrollHeight, top0 = chat.scrollTop;
  const st = buildSection(g);
  fillSection(st, g, false);
  st.section.classList.add("loaded");
  hintEl().after(st.section);
  shownFrom--;
  pullLock = Date.now() + 900;
  applyFilters();
  updateHint();
  const keep = top0 + (chat.scrollHeight - h0);
  chat.scrollTop = keep;
  chat.scrollTo({ top: Math.max(0, keep - 180), behavior: "smooth" });
}

function renderChat(forceBottom = false) {
  ({ groups, pending } = groupLog(state.log));
  if (!groups.length && !pending.length) {
    if (!$(".chat-empty", chat)) chat.innerHTML = `<div class="chat-empty"><div><b>No messages yet</b>Each transaction's log appears here.</div></div>`;
    rendered.clear();
    viewKey = undefined;
    return;
  }
  $(".chat-empty", chat)?.remove();

  let idx = focusTx ? groups.findIndex((g) => g.tx === focusTx) : groups.length - 1;
  if (focusTx && idx < 0) { focusTx = null; idx = groups.length - 1; }
  const key = String(groups[idx]?.tx ?? "none");
  const near = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  let added = 0, reset = false;

  if (key !== viewKey) {          // a new transaction started (or one was searched): show only it
    viewKey = key;
    reset = true;
    chat.innerHTML = "";
    rendered.clear();
    shownFrom = Math.max(idx, 0);
    if (idx >= 0) {
      const st = buildSection(groups[idx]);
      chat.append(st.section);
    }
  }
  for (let i = shownFrom; i <= idx; i++) {
    const g = groups[i], st = rendered.get(g.tx);
    if (st) added += fillSection(st, g, reset || i === idx);
  }

  const showPending = !focusTx && pending.length;
  let pst = rendered.get("__pending");
  if (showPending) {
    if (!pst) { pst = buildSection({ tx: null, entries: [] }); chat.append(pst.section); }
    added += fillSection(pst, { tx: null, entries: pending }, true);
  } else if (pst) {
    pst.section.remove();
    rendered.delete("__pending");
  }

  updateHint();
  applyFilters();
  if (reset || forceBottom || (added && near)) chat.scrollTop = chat.scrollHeight;
}

let pullLock = 0;   // after a load, wait before another pull can start
chat.addEventListener("wheel", (e) => {
  if (Date.now() < pullLock) return;
  if (e.deltaY < 0 && chat.scrollTop <= 0 && shownFrom > 0) {
    pull += -e.deltaY;
    setPull(pull / PULL);
    if (pull >= PULL) { pull = 0; setPull(0); loadPrevious(); }
    clearTimeout(pullT);
    pullT = setTimeout(() => { pull = 0; setPull(0); }, 600);
  } else if (e.deltaY > 0 && pull) { pull = 0; setPull(0); }
}, { passive: true });

let touchY = null;
chat.addEventListener("touchstart", (e) => { touchY = chat.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
chat.addEventListener("touchmove", (e) => {
  if (touchY === null || shownFrom <= 0) return;
  pull = Math.max(0, e.touches[0].clientY - touchY) * 1.6;
  setPull(pull / PULL);
}, { passive: true });
chat.addEventListener("touchend", () => {
  if (pull >= PULL) loadPrevious();
  pull = 0; touchY = null; setPull(0);
});

function renderRoute() {
  const txt = `${holder(route[0])} → ${holder(route[1])}`;
  $("#route-text").textContent = txt;
}

// ---------------------------------------------------------
// One animated 2PC run
// ---------------------------------------------------------
// ---------------------------------------------------------
// Log <-> animation sync
// While a transaction animates, its log lines stay hidden until the matching
// moment in the protocol animation "releases" them.
// ---------------------------------------------------------
let live = null;   // { known: tx ids that existed before this run, rules: [predicate] }
const isLive = (tx) => !!live && !!tx && !live.known.has(tx);
function gated(e) {
  return isLive(e.tx) && !live.rules.some((r) => r(e));
}
function release(rule) {
  if (!live) return;
  live.rules.push(rule);
  renderChat();
}
const co = (e) => e.node === "coordinator";
const R = {
  begin:      (e) => co(e) && e.kind === "begin",
  phase1:     (e) => co(e) && e.msg.startsWith("PHASE 1"),
  prepAt:     (b) => (e) => e.node === b && (e.msg.startsWith("PREPARE received") || e.msg.startsWith("simulating")),
  voteSent:   (b) => (e) => e.node === b && (e.msg.startsWith("PREPARED") || e.msg.startsWith("voting NO")),
  voteGot:    (b) => (e) => co(e) && e.msg.startsWith(`vote from ${b}`),
  decision:   (e) => co(e) && e.msg.startsWith("DECISION"),
  phase2:     (e) => co(e) && e.msg.startsWith("PHASE 2"),
  decisionAt: (b) => (e) => e.node === b && /^(COMMIT|ABORT)/.test(e.msg),
  ackGot:     (b) => (e) => co(e) && (e.msg.startsWith(`ACK from ${b}`) || e.msg.includes(`from ${b} (`) || e.msg.startsWith(`${b} never`)),
  end:        (e) => co(e) && e.kind === "end",
};

// ---------------------------------------------------------
// One animated 2PC run
// ---------------------------------------------------------
async function runTransaction(amount, from, to, tile) {
  if (busy) return;
  busy = true;
  setBusy(true, tile);
  const names = [from, to];
  $("#protocol").scrollIntoView({ behavior: "smooth", block: "nearest" });
  live = { known: new Set([...state.transactions.map((t) => t.tx_id), ...state.log.filter((e) => e.tx).map((e) => e.tx)]), rules: [] };

  $("#g-yes").textContent = 0;
  $("#g-no").textContent = 0;
  setStep("begin");
  setNode("coordinator", "busy", "BEGIN · logging");
  names.forEach((n) => setNode(n, "", "idle"));
  const request = api("/api/transactions", { method: "POST", body: JSON.stringify({ amount, from, to }) });
  const poll = setInterval(refresh, 250);   // pulls new log lines + locks while we animate
  release(R.begin);
  ring("coordinator", INK);
  await sleep(600);

  // Phase 1
  setStep("prepare");
  setNode("coordinator", "busy", "sending PREPARE");
  release(R.phase1);
  await sleep(250);
  await Promise.all(names.map((n) => packet(n, "down", "PREPARE", "black").then(() => {
    setNode(n, "thinking", "preparing…");
    release(R.prepAt(n));
  })));
  setNode("coordinator", "busy", "waiting for votes");

  let tx;
  try {
    tx = await request;
  } catch (e) {
    clearInterval(poll);
    toast(e.message);
    ["coordinator", ...names].forEach((n) => setNode(n, "", "idle"));
    setStep(null);
    live = null;
    busy = false;
    setBusy(false);
    return refresh();
  }
  await refresh();
  await sleep(450);

  let yes = 0, no = 0;
  await Promise.all(names.map(async (n, i) => {
    const v = tx.votes[n];
    await sleep(i * 350);   // stagger so the two votes read one after another
    if (v.status !== "OK") {
      setNode(n, "timeout", "no reply");
      release(R.voteGot(n));
      await flag(n, v.status);
      $("#g-no").textContent = ++no;
    } else {
      setNode(n, v.vote === "YES" ? "yes" : "no", `voted ${v.vote}`);
      release(R.voteSent(n));
      await sleep(300);
      await packet(n, "up", `VOTE ${v.vote}`, v.vote === "YES" ? "green" : "black");
      release(R.voteGot(n));
      if (v.vote === "YES") $("#g-yes").textContent = ++yes;
      else $("#g-no").textContent = ++no;
    }
  }));

  // Decision
  const commit = tx.decision === "COMMIT";
  await sleep(300);
  setStep("decision", tx.decision);
  setNode("coordinator", commit ? "decide-commit" : "decide-abort", `decision · ${tx.decision}`);
  wave("coordinator", commit ? GREEN : INK);
  release(R.decision);
  await sleep(1100);

  // Phase 2
  setStep("phase2", tx.decision);
  release(R.phase2);
  await sleep(250);
  await Promise.all(names.map((n) => packet(n, "down", tx.decision, commit ? "green" : "black").then(() => {
    setNode(n, commit ? "committed" : "aborted", commit ? "committed" : "rolled back");
    if (commit) burst(n, GREEN);
    else pulse($(`.node[data-node="${n}"]`), "shake", 480);
    release(R.decisionAt(n));
  })));
  refresh();
  await sleep(300);
  await Promise.all(names.map(async (n, i) => {
    await sleep(i * 250);
    if (tx.acks[n].ok) await packet(n, "up", "ACK", "white", 750);
    else await flag(n, "NO ACK");
    release(R.ackGot(n));
  }));

  await sleep(200);
  release(R.end);
  clearInterval(poll);
  setStep("done", tx.decision);
  setNode("coordinator", commit ? "decide-commit" : "decide-abort", `${tx.outcome.toLowerCase()} · ${tx.duration_ms} ms`);
  live = null;
  busy = false;
  setBusy(false);
  await refresh();
}

function setBusy(b, tile) {
  $$(".scen, #run, #reset, #route-pill, .seg3 button").forEach((el) => (el.disabled = b));
  $$(".scen").forEach((t) => t.classList.toggle("running", b && t === tile));
}

async function setMode(node, mode) {
  const sw = $(`.bank[data-node="${node}"] .seg3`);
  sw.dataset.mode = mode;
  sw.dataset.pending = "1";
  try {
    await api(`/api/participants/${node}/mode`, { method: "POST", body: JSON.stringify({ mode }) });
  } finally {
    delete sw.dataset.pending;
  }
}

const SCENARIOS = {
  success: { modes: { "bank-a": "yes", "bank-b": "yes" }, amount: 100 },
  "vote-no": { modes: { "bank-a": "yes", "bank-b": "no" }, amount: 100 },
  funds: { modes: { "bank-a": "yes", "bank-b": "yes" }, amount: 99999 },
  timeout: { modes: { "bank-a": "yes", "bank-b": "timeout" }, amount: 100 },
};

// ---------------------------------------------------------
// Wiring
// ---------------------------------------------------------
$$(".scen").forEach((tile) => tile.addEventListener("click", async () => {
  if (busy) return;
  const s = SCENARIOS[tile.dataset.scenario];
  try {
    await Promise.all(Object.entries(s.modes).map(([n, m]) => setMode(n, m)));
  } catch (e) {
    return toast(e.message);
  }
  await refresh();
  runTransaction(s.amount, "bank-a", "bank-b", tile);
}));

$("#tx-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const amt = parseInt($("#amount").value, 10);
  if (!(amt > 0)) return toast("Enter a positive amount to transfer");
  if (amt > 1e9) return toast("That's a bit much: keep it under 1 000 000 000");
  runTransaction(amt, route[0], route[1]);
});

function swapRoute() {
  if (busy) return;
  route.reverse();
  pulse($("#route-pill"), "flip", 500);
  renderRoute();
}
$("#route-pill").addEventListener("click", swapRoute);

$("#slowmo").addEventListener("click", (e) => {
  slow = !slow;
  e.currentTarget.setAttribute("aria-pressed", slow);
});

$$(".seg3").forEach((sw) => sw.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b || busy) return;
  try {
    await setMode(sw.closest(".bank").dataset.node, b.dataset.mode);
  } catch (err) {
    toast(err.message);
  }
  refresh();
}));

$("#chips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip");
  if (!c) return;
  filterNode = c.dataset.node;
  $$("#chips .chip").forEach((x) => x.classList.toggle("active", x === c));
  applyFilters();
  $("#chat").scrollTop = $("#chat").scrollHeight;
});
$("#log-bottom").addEventListener("click", () => {
  focusTx = null;
  renderChat(true);
});

const resetBtn = $("#reset");
let resetTimer;
function resetLook(stateName, label, iconId) {
  resetBtn.classList.remove("spinning", "done", "failed");
  if (stateName) resetBtn.classList.add(stateName);
  $("#reset-label").textContent = label;
  $("#reset-use").setAttribute("href", `#i-${iconId}`);
}
resetBtn.addEventListener("click", async () => {
  if (busy || resetBtn.classList.contains("spinning")) return;
  clearTimeout(resetTimer);
  resetLook("spinning", "Resetting…", "reset");
  const minSpin = new Promise((r) => setTimeout(r, 800));
  try {
    await Promise.all([api("/api/reset", { method: "POST" }), minSpin]);
  } catch (e) {
    resetLook("failed", "Reset failed", "x");
    resetTimer = setTimeout(() => resetLook(null, "Reset all nodes", "reset"), 1800);
    return toast(e.message);
  }
  clearViews();
  lastTop = 0;
  setStep(null);
  ["coordinator", "bank-a", "bank-b"].forEach((n) => { setNode(n, "", "idle"); ring(n, GREEN); });
  resetLook("done", "All nodes reset", "check");
  resetTimer = setTimeout(() => resetLook(null, "Reset all nodes", "reset"), 1800);
  refresh();
});

// nav: smooth scroll + scroll-spy
const navLinks = $$("#nav a");
const spy = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) navLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id));
}, { rootMargin: "-40% 0px -55% 0px" });
["overview", "protocol", "ledgers", "scenarios"].forEach((id) => spy.observe(document.getElementById(id)));

layout();
drawGauge(0);
setStep(null);
refresh();
setInterval(() => { if (!busy) refresh(); }, 2000);
