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
  spentPill.dataset.live = live ? "live" : "demo";
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
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") overlay.hidden = true;
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
