// An independent agent process. It is not part of BOSS: it registers over HTTP,
// quotes a price, wins work on price, and gets paid on-chain when its output
// passes the judge.
//
//   node scripts/external_agent.js -port 8791 -boss http://127.0.0.1:8787
//
// It critiques prose with deterministic heuristics (no model, no API key), so it
// can run on a laptop while BOSS runs on another machine — which is the point.

import { createServer } from "node:http";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`-${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const PORT = Number(flag("port", 8791));
const BOSS = flag("boss", "http://127.0.0.1:8787");
const PRICE = Number(flag("price", 0.35)); // undercuts the in-house critic at $0.45
const ACCOUNT = flag("account", ""); // a NEAR account to be paid in, if BOSS is on-chain
const ID = flag("id", "verity.critique");

const FILLER = ["very", "really", "quite", "actually", "basically", "literally", "leverage", "synergy", "seamless", "robust", "world-class"];

function sentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(" ").length > 3);
}

function critique(draft, brief = "") {
  const text = String(draft || "");
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = sentences(text);
  const numbers = (text.match(/\d/g) || []).length;
  const filler = FILLER.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  const longest = [...lines].sort((a, b) => b.length - a.length).slice(0, 3);

  const clarity = Math.max(1, Math.min(5, 5 - Math.floor((longest[0]?.split(" ").length || 0) / 18)));
  const specificity = Math.max(1, Math.min(5, 1 + Math.min(4, Math.floor(numbers / 2))));
  const usefulness = Math.max(1, Math.min(5, 5 - filler.length));

  const fixes = longest.map((line, i) => {
    const lead = line.split(" ").slice(0, 9).join(" ");
    const fix =
      i === 0
        ? "cut it in two and lead with the verb"
        : i === 1
          ? "replace the vague noun with a number or a name"
          : "delete it or merge it into the line above";
    return `Weak line: "${lead}…" — ${fix}.`;
  });

  const fillerNote = filler.length
    ? `Remove filler: ${filler.join(", ")}.`
    : "No filler words found.";

  // Shape check against the brief, which is where most drafts actually fail.
  const wanted = brief.match(/\b(\d+)\s+(?:distinct\s+|short\s+|different\s+|new\s+)?(taglines|slogans|options|names|ideas|headlines|bullets|lines|variations)\b/i);
  const numbered = text.split(/\r?\n/).filter((l) => /^\s*(?:\d+[.)]|[-*•])\s+\S/.test(l)).length;
  const wantsPick = /pick the strongest|choose the (?:best|strongest)|best option|strongest (?:one|option|tagline)/i.test(brief);

  const shape = [];
  if (wanted && numbered < Number(wanted[1])) {
    shape.push(`Missing: the brief asks for ${wanted[1]} ${wanted[2]}, the draft lists ${numbered}.`);
  }
  if (wantsPick && !/\b(strongest|best|pick|winner|recommend)\b/i.test(text)) {
    shape.push("Missing: the brief asks you to name the single strongest option, and the draft does not.");
  }

  const closing = wanted
    ? "Fix: keep the numbered list, give every line the same length and tone, and keep the single pick at the end."
    : "Fix: keep the strongest line as the opening and make every claim checkable.";

  return [
    `Score ${clarity}/5 on clarity, ${specificity}/5 on specificity, ${usefulness}/5 on usefulness.`,
    `${words.length} words, ${lines.length} sentences, ${numbers} digits. ${fillerNote}`,
    ...shape,
    ...fixes,
    closing,
  ].join(" ");
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ agent: ID, ok: true, price: PRICE, capability: "critique" }));
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end("method not allowed");
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {}
    const deliverable = critique(payload.context?.prior || "", payload.brief || "");
    console.log(`[${ID}] served ${payload.stage || "?"} for "${String(payload.brief || "").slice(0, 60)}"`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ deliverable, agent: ID }));
  });
});

server.listen(PORT, async () => {
  console.log(`[${ID}] listening on http://localhost:${PORT} · $${PRICE} per critique`);
  try {
    const res = await fetch(`${BOSS}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: ID,
        name: "Verity",
        capability: "critique",
        price: PRICE,
        reputation: 72,
        stake: 0.5,
        account: ACCOUNT || undefined,
        endpoint: `http://localhost:${PORT}/`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    console.log(`[${ID}] registered with BOSS ($${PRICE}, undercuts the in-house critic)`, data.error || "");
  } catch (e) {
    console.log(`[${ID}] could not reach BOSS at ${BOSS}: ${e.message}`);
  }
});

process.on("SIGINT", () => {
  console.log(`\n[${ID}] stopped`);
  server.close();
  process.exit(0);
});
