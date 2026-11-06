// BOSS web UI — Glyph-style light shell, wired to the firm engine.
// One composer, one thread. The interesting part is what the stream shows:
// who was hired, what the judge scored, what the treasury actually paid.
import { startSwarm } from "./swarm.js";

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
try {
  const res = await fetch("/health");
  const health = await res.json();
  const models = health.live?.models || [];
  const chain = health.live?.chain || {};
  const live = models.length > 0;
  spentPill.dataset.live = live ? "live" : "mirror";
  spentPill.title = [
    models.length ? `models: ${models.join(" → ")}` : "no model key — set GROQ_API_KEY",
    chain.mode === "near" ? `treasury: ${chain.contract} on ${chain.network}` : "treasury: local mirror",
  ].join(" · ");
} catch {
  spentPill.title = "offline";
}

// ---------- composer ----------
taskEl.addEventListener("input", syncSend);
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
  syncSend();
  taskEl.focus();
});

document.querySelector("#examples").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-task]");
  if (!btn) return;
  taskEl.value = btn.dataset.task;
  syncSend();
  taskEl.focus();
});

document.querySelector("#cta").addEventListener("click", () => {
  taskEl.value = DEFAULT_TASK;
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
        "Write exactly 5 numbered taglines for a coffee subscription that ships a new single-origin roast every month. " +
        "Then name the strongest one and give a one-sentence reason. Keep it under 120 words.",
      acceptance: ["exactly 5 numbered taglines", "one named strongest pick with a one-sentence reason", "under 120 words"],
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
    mlog(`job B — research · requires a browser · worker has none`, "dim");
    const b = await postJob({
      capability: "research",
      brief:
        "Find one current, verifiable statistic about global coffee consumption and cite the source URL. Keep it under 80 words.",
      acceptance: ["includes a source URL", "under 80 words"],
      requires: ["browse"],
      depositUsd: 0.5,
      deadlineSecs: 900,
    });
    mlog(`job ${b.jobId} open · escrow ${b.depositNear.toFixed(3)} NEAR · spec ${b.specHash.slice(0, 12)}…`);
    const deliveredB = await waitForDelivery(b.jobId);
    mlog(`worker declined · result hash ${String(deliveredB.resultHash).slice(0, 12)}…`, "dim");
    const settledB = await settleJob(b.jobId);
    mlog(`job ${b.jobId} — ${settledB.action.toUpperCase()} · ${settledB.verdict?.reasons?.[0] || settledB.reason || "rejected"}`, settledB.action === "refund" ? "good" : "bad", settledB.url);

    mlog("", "");
    await loadMarket();
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
    marketDemo.textContent = "run a live job on testnet";
  }
}

marketBtn.addEventListener("click", async () => {
  marketOverlay.hidden = false;
  await loadMarket();
});
closeMarket.addEventListener("click", () => (marketOverlay.hidden = true));
marketOverlay.addEventListener("click", (e) => {
  if (e.target === marketOverlay) marketOverlay.hidden = true;
});
marketRefresh.addEventListener("click", loadMarket);
marketDemo.addEventListener("click", runMarketDemo);

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
          `${ev.stage} accepted · ${Math.round((ev.confidence || 0) * 100)}/100 · ${ev.mode}${ev.reasons?.[0] ? ` · ${ev.reasons[0]}` : ""}`,
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
