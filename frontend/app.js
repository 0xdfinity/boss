// BOSS web UI — Glyph-style light shell, wired to the firm engine.
// One composer, one thread. The interesting part is what the stream shows:
// who was hired, what the judge scored, what the treasury actually paid.
import { startSwarm } from "./swarm.js";
import {
  bridgePopup,
  connect as connectWallet,
  disconnect as forgetWallet,
  loadWallet,
  resume as resumeWallet,
  runAsClient,
} from "./wallet.js";
import { formatNear } from "./near-lite.js";

// The wallet popup lands back on this page; if it does, hand the account id to
// the tab that opened it and close before any UI is built.
bridgePopup();

const body = document.body;
const thread = document.querySelector("#thread");
const form = document.querySelector("#composer");
const taskEl = document.querySelector("#task");
const sendBtn = document.querySelector("#send");
const moreBtn = document.querySelector("#more");
const agentsBar = document.querySelector("#agents");
const chips = [...document.querySelectorAll(".chip")];
const spentText = document.querySelector("#spentText");
const spentPill = document.querySelector("#spentPill");
const overlay = document.querySelector("#howOverlay");
const howBtn = document.querySelector("#howBtn");
const closeHow = document.querySelector("#closeHow");
const examples = [...document.querySelectorAll("#examples button")];
const BUDGET = 20;

startSwarm(document.querySelector("#swarm"));

const EXAMPLES = examples.map((b) => b.dataset.task);
const DEFAULT_TASK = EXAMPLES[0];
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

function add(text, kind = "boss", who = "") {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  if (who) {
    const tag = document.createElement("span");
    tag.className = "who";
    tag.textContent = who;
    el.append(tag);
  }
  el.append(document.createTextNode(text));
  thread.append(el);
  thread.scrollTop = thread.scrollHeight;
  return el;
}

function addArtifact(text, meta) {
  const el = document.createElement("div");
  el.className = "msg artifact";
  const head = document.createElement("div");
  head.className = "artifact-head";
  head.innerHTML = "<span>deliverable</span>";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "copied";
      setTimeout(() => (copy.textContent = "copy"), 1200);
    } catch {
      copy.textContent = "select it";
    }
  });
  head.append(copy);
  const pre = document.createElement("pre");
  pre.textContent = text;
  const foot = document.createElement("div");
  foot.className = "artifact-foot";
  foot.textContent = meta;
  el.append(head, pre, foot);
  thread.append(el);
  thread.scrollTop = thread.scrollHeight;
}

function setAgent(name, state) {
  const chip = chips.find((c) => c.dataset.agent === name);
  if (chip) chip.className = `chip ${state}`;
}

function resetAgents() {
  for (const c of chips) c.className = "chip";
}

function setSpent(spent) {
  spentText.textContent = `spent ${money(spent)} / ${money(BUDGET)}`;
}

const syncSend = () => {
  sendBtn.disabled = taskEl.value.trim().length === 0;
};

// ---------- boot copy ----------
add(
  "I run a small firm: I plan the job, hire agents, check the work, and pay only what passes.",
  "boss"
);
add("Send a brief. The model proposes, the contract decides. $2.00 per agent, $20.00 a day.", "note");
setSpent(0);

// ---------- health ----------
let marketContract = "";
let nearUsdRate = 10;
async function readHealth() {
  const res = await fetch("/health");
  const health = await res.json();
  const models = health.live?.models || [];
  const chain = health.live?.chain || {};
  const live = models.length > 0;
  spentPill.dataset.live = live ? "live" : "mirror";
  spentPill.title = [
    models.length ? `models: ${models.join(" → ")}` : "no model key — the firm refuses the first stage",
    chain.mode === "near" ? `treasury: ${chain.contract} on ${chain.network}` : "treasury: local mirror",
  ].join(" · ");
}

// Render's free plan sleeps after 15 idle minutes and can take about a minute to
// answer the first request. Retry before calling the firm offline.
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    await readHealth();
    break;
  } catch {
    if (attempt === 5) {
      spentPill.title = "offline";
      break;
    }
    if (attempt === 0) spentPill.title = "waking the firm...";
    await new Promise((r) => setTimeout(r, 5000 + attempt * 5000));
  }
}

// ---------- composer ----------
// Size the box to what is actually painted. The placeholder is drawn like
// content but is not part of scrollHeight, so an empty composer whose
// placeholder wraps (a phone) would otherwise be cut off.
function growTask() {
  const had = taskEl.value;
  if (!had) taskEl.value = taskEl.placeholder;
  taskEl.style.height = "auto";
  const height = taskEl.scrollHeight;
  if (!had) taskEl.value = "";
  taskEl.style.height = `${Math.max(height, 49)}px`;
}

growTask();
window.addEventListener("resize", growTask);

taskEl.addEventListener("input", () => {
  growTask();
  syncSend();
});
taskEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
syncSend();

let exampleIndex = -1;
moreBtn.addEventListener("click", () => {
  exampleIndex = (exampleIndex + 1) % EXAMPLES.length;
  taskEl.value = EXAMPLES[exampleIndex];
  growTask();
  syncSend();
  taskEl.focus();
});

document.querySelector("#examples").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-task]");
  if (!btn) return;
  taskEl.value = btn.dataset.task;
  growTask();
  syncSend();
  taskEl.focus();
});

document.querySelector("#cta").addEventListener("click", () => {
  taskEl.value = DEFAULT_TASK;
  growTask();
  syncSend();
  form.requestSubmit();
});

// ---------- overlay ----------
howBtn.addEventListener("click", () => (overlay.hidden = false));
closeHow.addEventListener("click", () => (overlay.hidden = true));
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) overlay.hidden = true;
});

// ---------- market ----------
const marketOverlay = document.querySelector("#marketOverlay");
const marketBtn = document.querySelector("#marketBtn");
const closeMarket = document.querySelector("#closeMarket");
const marketLog = document.querySelector("#marketLog");
const marketDemo = document.querySelector("#marketDemo");
const marketRefresh = document.querySelector("#marketRefresh");
const mktContract = document.querySelector("#mktContract");
const mktWorker = document.querySelector("#mktWorker");
const mktSettled = document.querySelector("#mktSettled");
let marketRunning = false;

function mlog(text, kind = "", href = "") {
  marketLog.querySelector(".market-idle")?.remove();
  const p = document.createElement("p");
  p.className = `mline ${kind}`.trim();
  p.textContent = text;
  if (href) {
    p.append(" ");
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "tx ↗";
    p.append(a);
  }
  marketLog.append(p);
  marketLog.scrollTop = marketLog.scrollHeight;
}

async function loadMarket() {
  try {
    const res = await fetch("/api/market");
    const m = await res.json();
    mktContract.textContent = m.contract || "not configured";
    marketContract = m.contract || "";
    nearUsdRate = Number(m.rate) > 0 ? Number(m.rate) : 10;
    mktWorker.textContent = m.worker?.online
      ? `${m.worker.account} · ${(m.worker.capabilities || []).join(", ")}`
      : "offline — run npm run worker";
    mktSettled.textContent = `${m.released || 0} released · ${m.refunded || 0} refunded · ${m.jobs || 0} jobs`;
    return m;
  } catch (e) {
    mktContract.textContent = "server unreachable";
    return { error: String(e.message || e) };
  }
}

async function postJob(spec) {
  const res = await fetch("/api/market/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `server ${res.status}`);
  return body;
}

async function waitForDelivery(id, timeoutMs = 180_000) {
  const started = Date.now();
  let status = "";
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`/api/market/jobs/${id}`);
    if (res.ok) {
      const job = await res.json();
      status = job.status;
      if (["Submitted", "Released", "Refunded"].includes(job.status)) return job;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`job ${id} was not delivered in time (${status || "no status"})`);
}

async function settleJob(id) {
  const res = await fetch(`/api/market/jobs/${id}/settle`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `server ${res.status}`);
  return body;
}

async function runMarketDemo() {
  if (marketRunning) return;
  marketRunning = true;
  marketDemo.disabled = true;
  marketDemo.textContent = "running…";
  marketLog.replaceChildren();
  try {
    const m = await loadMarket();
    if (!m.contract) throw new Error("the market is not configured on this server");
    if (!m.worker?.online) throw new Error("the second firm is offline — run: npm run worker");

    mlog(`job A — writing · client ${m.account} · worker ${m.worker.account}`, "dim");
    const a = await postJob({
      capability: "writing",
      brief:
        "Write 5 numbered checks a client runs before releasing a boss_market escrow. " +
        "Cover, in order: (1) deadline is still in the future, (2) the SHA-256 of the bytes at result_url equals result_hash, " +
        "(3) fetching result_url returns HTTP 200, (4) released is false, (5) refunded is false. " +
        "One sentence each, naming the field and the failure condition. Under 120 words.",
      acceptance: ["exactly 5 numbered checks", "each check names a field and a failure condition", "under 120 words"],
      depositUsd: 0.5,
      deadlineSecs: 900,
    });
    mlog(`job ${a.jobId} open · escrow ${a.depositNear.toFixed(3)} NEAR · spec ${a.specHash.slice(0, 12)}…`);
    const deliveredA = await waitForDelivery(a.jobId);
    mlog(`worker delivered · result hash ${String(deliveredA.resultHash).slice(0, 12)}…`, "dim");
    const settledA = await settleJob(a.jobId);
    const scoreA = settledA.verdict?.score ?? "?";
    mlog(`job ${a.jobId} — ${settledA.action.toUpperCase()} · ${scoreA}/100 · ${settledA.verdict?.reasons?.[0] || "passed"}`, settledA.action === "release" ? "good" : "bad", settledA.url);

    mlog("", "");
    mlog(`job B — research · reads the chain · worker has no RPC tool`, "dim");
    const b = await postJob({
      capability: "research",
      brief:
        "Read the live NEAR balance of the client's treasury account from the chain and report it with the block height. " +
        "Under 60 words.",
      acceptance: ["a balance and a block height", "under 60 words"],
      requires: ["rpc"],
      depositUsd: 0.5,
      deadlineSecs: 900,
    });
    mlog(`job ${b.jobId} open · escrow ${b.depositNear.toFixed(3)} NEAR · spec ${b.specHash.slice(0, 12)}…`);
    const deliveredB = await waitForDelivery(b.jobId);
    mlog(`worker declined · result hash ${String(deliveredB.resultHash).slice(0, 12)}…`, "dim");
    const settledB = await settleJob(b.jobId);
    mlog(`job ${b.jobId} — ${settledB.action.toUpperCase()} · ${settledB.verdict?.reasons?.[0] || settledB.reason || "rejected"}`, settledB.action === "refund" ? "good" : "bad", settledB.url);

    mlog("", "");
    await Promise.all([loadMarket(), paintLimits()]);
    mlog(
      settledB.action === "refund"
        ? "the refusal held: the escrow went back. money that did not move is the proof."
        : "job B was paid — read the verdict above.",
      settledB.action === "refund" ? "good" : "bad"
    );
  } catch (e) {
    mlog(`stopped: ${e.message}`, "bad");
  } finally {
    marketRunning = false;
    marketDemo.disabled = false;
    marketDemo.textContent = "run a demo job (no wallet)";
  }
}

marketBtn.addEventListener("click", async () => {
  marketOverlay.hidden = false;
  await loadMarket();
  await paintLimits();
});
closeMarket.addEventListener("click", () => (marketOverlay.hidden = true));
marketOverlay.addEventListener("click", (e) => {
  if (e.target === marketOverlay) marketOverlay.hidden = true;
});
marketRefresh.addEventListener("click", loadMarket);
marketDemo.addEventListener("click", runMarketDemo);

// ---------- wallet: the client is whoever holds the key ----------
const walletBtn = document.querySelector("#walletBtn");
const walletConnect = document.querySelector("#walletConnect");
const walletState = document.querySelector("#walletState");
const marketOwn = document.querySelector("#marketOwn");
let wallet = null;
let walletBusy = false;

function paintWallet() {
  if (wallet) {
    walletBtn.textContent = wallet.accountId.replace(/\.testnet$/, "");
    walletBtn.classList.add("on");
    walletBtn.title = `connected · ${wallet.accountId} · ${formatNear(wallet.balance || 0)} NEAR`;
    walletConnect.textContent = "disconnect";
    walletState.textContent = `${wallet.accountId} · ${formatNear(wallet.balance || 0)} NEAR`;
    marketOwn.disabled = false;
  } else {
    walletBtn.textContent = "connect wallet";
    walletBtn.classList.remove("on");
    walletBtn.title = "connect a testnet wallet as the client";
    walletConnect.textContent = "connect a testnet wallet";
    walletState.textContent = "not connected";
    marketOwn.disabled = true;
  }
}

async function refreshWallet() {
  const stored = loadWallet();
  if (!stored) {
    wallet = null;
    return paintWallet();
  }
  try {
    const resumed = await resumeWallet(stored);
    wallet = resumed;
    if (wallet) wallet.balance = await wallet.near.balance();
  } catch {
    wallet = null;
  }
  paintWallet();
}

async function connectNow() {
  if (walletBusy) return;
  if (!marketContract) {
    mlog("the market is not configured on this server", "bad");
    return;
  }
  walletBusy = true;
  walletConnect.disabled = true;
  walletConnect.textContent = "waiting for the wallet…";
  try {
    wallet = await connectWallet(marketContract);
    paintWallet();
    mlog(`connected as ${wallet.accountId} · ${formatNear(wallet.balance)} NEAR · key scoped to the market contract`, "good");
  } catch (e) {
    mlog(`wallet: ${e.message}`, "bad");
    paintWallet();
  } finally {
    walletBusy = false;
    walletConnect.disabled = false;
  }
}

walletBtn.addEventListener("click", async () => {
  marketOverlay.hidden = false;
  await loadMarket();
  if (!wallet) connectNow();
});

walletConnect.addEventListener("click", async () => {
  if (wallet) {
    forgetWallet();
    wallet = null;
    paintWallet();
    mlog("wallet disconnected — the key is gone from this browser", "dim");
    return;
  }
  await connectNow();
});

async function runOwnJob() {
  if (!wallet || walletBusy) return;
  walletBusy = true;
  marketOwn.disabled = true;
  marketOwn.textContent = "signing…";
  marketLog.replaceChildren();
  const brief =
    (taskEl.value || "").trim() ||
    "Write 5 numbered checks a client runs before releasing a boss_market escrow. " +
      "Cover, in order: (1) deadline is still in the future, (2) the SHA-256 of the bytes at result_url equals result_hash, " +
      "(3) fetching result_url returns HTTP 200, (4) released is false, (5) refunded is false. " +
      "One sentence each, naming the field and the failure condition. Under 120 words.";

  try {
    mlog(`you are the client · ${wallet.accountId}`, "dim");
    const out = await runAsClient({
      wallet,
      brief,
      capability: "writing",
      acceptance: ["answers every part of the brief", "under 200 words"],
      rate: nearUsdRate,
      onLog: mlog,
    });
    await Promise.all([loadMarket(), paintLimits()]);
    mlog(
      out.action === "release"
        ? "paid from your escrow to the worker — your key signed it, not ours."
        : "your escrow came back. money that did not move is the proof.",
      "good"
    );
    if (out.deliverable) {
      const pre = document.createElement("pre");
      pre.className = "market-deliverable";
      pre.textContent = out.deliverable.slice(0, 1400);
      marketLog.append(pre);
      marketLog.scrollTop = marketLog.scrollHeight;
    }
  } catch (e) {
    mlog(`stopped: ${e.message}`, "bad");
  } finally {
    walletBusy = false;
    marketOwn.disabled = false;
    marketOwn.textContent = "run as your firm";
  }
}

marketOwn.addEventListener("click", runOwnJob);
refreshWallet();

// ---------- what is left of the public allowance ----------
const limitsLine = document.querySelector("#limitsLine");

async function paintLimits() {
  try {
    const res = await fetch("/api/limits");
    const l = await res.json();
    if (!res.ok) throw new Error(l.error || `server ${res.status}`);
    limitsLine.textContent =
      `${l.perIp.left} of ${l.perIp.cap} demo jobs left for this address today · ` +
      `${l.global.used}/${l.global.cap} across the site · max ${money(l.maxBudget)} per job`;
    limitsLine.dataset.state = l.perIp.left === 0 ? "none" : "ok";
  } catch {
    limitsLine.textContent = "";
  }
}
paintLimits();

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    overlay.hidden = true;
    marketOverlay.hidden = true;
  }
});

// ---------- job ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const brief = taskEl.value.trim();
  if (!brief) return;

  body.classList.add("chatting");
  agentsBar.hidden = false;
  resetAgents();
  setAgent("scout", "active");
  setSpent(0);
  sendBtn.disabled = true;

  add(brief, "user");
  taskEl.value = "";
  growTask();
  syncSend();

  let paid = 0;
  let refused = 0;

  try {
    const res = await fetch(`/api/mission/stream?task=${encodeURIComponent(brief)}&budget=${BUDGET}`);
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `server ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        render(event);
      }
    }
  } catch (err) {
    add(`The firm stopped: ${err.message}. Nothing else left the treasury.`, "bad");
  } finally {
    sendBtn.disabled = false;
    paintLimits();
  }

  function render(ev) {
    switch (ev.type) {
      case "mission.start":
        add(`budget ${money(ev.budget)} — firm dispatched`, "note");
        break;

      case "firm.plan": {
        setAgent("scout", "done");
        const names = ev.stages.map((s) => s.kind).join(" → ");
        add(`plan: ${names}`, "note", "◈ scout");
        break;
      }

      case "stage.start":
        setAgent("scout", "done");
        setAgent("verifier", "active");
        add(`${ev.agent} hired for ${ev.stage} · ${money(ev.price)}`, "note", "◈ scout");
        break;

      case "swarm.spawn":
        break;

      case "verifier.attested":
        setAgent("verifier", "done");
        add(
          `${ev.stage} accepted · ${Math.round((ev.confidence || 0) * 100)}/100 · ${
            ev.producer ? `made by ${ev.producer} · ` : ""
          }judged by ${ev.mode}${ev.reasons?.[0] ? ` · ${ev.reasons[0]}` : ""}`,
          "note",
          "⬡ judge"
        );
        break;

      case "proof.rejected":
        refused += 1;
        setAgent("verifier", "blocked");
        add(`${ev.agent} refused: ${ev.reason} — not paid`, "bad", "⬡ judge");
        break;

      case "stage.rejected":
        refused += 1;
        add(`${ev.agent || ev.stage}: ${ev.reason}`, "bad", "⬡ judge");
        break;

      case "payment.rejected":
        add(`treasury blocked payment to ${ev.agent || ev.task}: ${ev.reason}`, "bad", "◎ treasury");
        break;

      case "payer.settled": {
        paid += 1;
        setAgent("payer", "done");
        const link = ev.tx
          ? ` · tx ${ev.tx.slice(0, 10)}…`
          : ev.mode === "mirror"
            ? " · local mirror"
            : "";
        add(`${money(ev.amount)} → ${ev.worker}${link}`, "note", "◎ treasury");
        break;
      }

      case "mission.spent":
        setSpent(ev.spent);
        break;

      case "firm.verdict":
        add(`client verdict: ${ev.ok ? "accepted" : "rejected"} · ${ev.score}/100`, ev.ok ? "note" : "bad", "⬡ judge");
        break;

      case "mission.complete": {
        setSpent(ev.spent);
        setAgent("scout", "done");
        setAgent("verifier", "done");
        setAgent("payer", "done");
        if (ev.artifact) {
          addArtifact(
            ev.artifact,
            `${paid} agents paid · ${money(ev.spent)} of ${money(ev.budget)} · ${Math.round((ev.ms || 0) / 100) / 10}s`
          );
        }
        add(
          `done. ${ev.paid} paid, ${ev.rejected} refused, ${money(ev.spent)} left the treasury of ${money(ev.budget)}.`,
          "boss"
        );
        break;
      }

      case "mission.error":
        add(`stopped: ${ev.error}`, "bad");
        break;

      default:
        break;
    }
  }
});

syncSend();
