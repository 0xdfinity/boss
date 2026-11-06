// The end-to-end market demo: two firms, two jobs, one payment, one refund.
//
//   npm run demo
//
// Starts the client server and the worker firm if they are not already up,
// then runs:
//   job A — a writing job the worker can do. The client fetches the result,
//           checks its hash, judges it, and releases the escrow.
//   job B — a research job that requires a browser. The worker has none, says
//           so in writing, and the client refunds. No money moves on a claim.
//
// Leaves nothing running unless you pass --keep. Every settlement prints a
// nearblocks link you can open.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/config/env.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = `http://localhost:${env.port}`;
const keep = process.argv.includes("--keep");
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

async function get(path) {
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${path} → HTTP ${res.status}`);
  return body;
}

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `${path} → HTTP ${res.status}`);
  return payload;
}

async function up(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function start(name, script) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = name.padEnd(6);
  const tag = (d) =>
    String(d)
      .split("\n")
      .map((l) => (l.trim() === "" || l.startsWith("[") ? l : `[${prefix}] ${l}`))
      .join("\n");
  child.stdout.on("data", (d) => process.stdout.write(tag(d)));
  child.stderr.on("data", (d) => process.stderr.write(tag(d)));
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`[${name}] exited ${code}`);
  });
  children.push(child);
  return child;
}

function cleanup() {
  if (keep) return;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // already gone
    }
  }
}

async function waitForJob(id, { timeout = 150_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const job = await get(`/api/market/jobs/${id}`);
    if (job.status === "Submitted" || job.status === "Released" || job.status === "Refunded") return job;
    const left = Math.round((job.deadline * 1000 - Date.now()) / 1000);
    process.stdout.write(`\r  job ${id}: ${job.status} · ${Math.max(left, 0)}s left   `);
    await sleep(3000);
  }
  process.stdout.write("\n");
  throw new Error(`job ${id} was not delivered in time`);
}

async function settle(id) {
  const out = await post(`/api/market/jobs/${id}/settle`);
  return out;
}

function line() {
  console.log("-".repeat(68));
}

async function runJob(label, spec) {
  console.log(`\n${label}`);
  const opened = await post("/api/market/jobs", spec);
  console.log(`  opened job ${opened.jobId} · escrow ${money(opened.depositNear * (env.nearUsdRate || 10))} (${opened.depositNear.toFixed(3)} NEAR)`);
  console.log(`  spec hash ${opened.specHash.slice(0, 16)}…`);
  console.log(`  open tx  ${opened.url}`);

  const delivered = await waitForJob(opened.jobId);
  process.stdout.write("\n");
  console.log(`  worker   ${delivered.worker || "unknown"} delivered · result hash ${String(delivered.resultHash).slice(0, 16)}…`);

  const settled = await settle(opened.jobId);
  const verdict = settled.verdict || {};
  const why = settled.reason || verdict.reasons?.[0] || "passed";
  console.log(`  verdict  ${settled.action} · score ${verdict.score ?? "n/a"} · ${why}`);
  console.log(`  tx       ${settled.url}`);
  return { opened, delivered, settled };
}

async function main() {
  console.log("BOSS market demo — two independent firms, one escrow contract");
  line();

  if (!env.marketContractId) {
    console.error("BOSS_MARKET_CONTRACT_ID is not set. Run: npm run deploy:market");
    process.exit(1);
  }

  if (!(await up(`${base}/health`))) {
    console.log(`starting client server on :${env.port}`);
    start("server", "src/server/index.js");
  } else {
    console.log(`client server already up on :${env.port}`);
  }

  if (!(await up(`${env.workerUrl}/health`))) {
    console.log(`starting worker firm on :${env.workerPort} (${env.workerAccount || "no account"})`);
    start("worker", "scripts/firm_worker.mjs");
  } else {
    console.log(`worker firm already up on :${env.workerPort}`);
  }

  for (let i = 0; i < 30 && !(await up(`${base}/health`)); i++) await sleep(500);
  for (let i = 0; i < 30 && !(await up(`${env.workerUrl}/health`)); i++) await sleep(500);

  if (!(await up(`${base}/health`))) throw new Error("client server did not start");
  if (!(await up(`${env.workerUrl}/health`))) throw new Error("worker did not start");

  const pass = await runJob("job A — writing (should be paid)", {
    capability: "writing",
    brief:
      "Write exactly 5 numbered taglines for a coffee subscription that ships a new single-origin roast every month. " +
      "Then name the strongest one and give a one-sentence reason. Keep it under 120 words.",
    acceptance: [
      "exactly 5 numbered taglines",
      "one named strongest pick with a one-sentence reason",
      "under 120 words",
    ],
    depositUsd: 0.5,
    deadlineSecs: 900,
  });

  const fail = await runJob("job B — research with a required live source (should be refunded)", {
    capability: "research",
    brief:
      "Find one current, verifiable statistic about global coffee consumption and cite the source URL. " +
      "Keep it under 80 words.",
    acceptance: ["includes a source URL", "under 80 words"],
    requires: ["browse"],
    depositUsd: 0.5,
    deadlineSecs: 900,
  });

  line();
  console.log("result");
  console.log(`  job A: ${pass.settled.action} · ${pass.settled.url}`);
  console.log(`  job B: ${fail.settled.action} · ${fail.settled.url}`);

  const snap = await get("/api/market");
  const jobs = snap.jobs ?? "?";
  const released = snap.released ?? "?";
  const refunded = snap.refunded ?? "?";
  console.log(`  market: ${jobs} jobs · ${released} released · ${refunded} refunded${snap.error ? ` (view: ${snap.error})` : ""}`);
  console.log(`  escrow: ${snap.contract}`);
  console.log(
    `  ${fail.settled.action === "refund" ? "the refusal held: money that did not move is the point." : "WARNING: job B was paid — inspect the verdict above."}`
  );

  if (keep) {
    console.log(`\nserver left running at ${base} · ctrl-c to stop this script (children stay up)`);
    return;
  }

  line();
  console.log("done. run `npm start` and `npm run worker`, then open http://127.0.0.1:" + env.port + " for the live UI.");
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((e) => {
    console.error(`\ndemo failed: ${e.message}`);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
