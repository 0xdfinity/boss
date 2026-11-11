// BOSS API server (Node, zero dependencies) — serves the web UI + firm API.
//
// Public surface:
//   POST /api/mission            run a job, return the full result
//   GET  /api/mission/stream     run a job, stream events (the chat UI)
//   POST /api/firm/work          BOSS as a worker: another agent hires it
//   GET  /api/firm/jobs          list jobs
//   POST /api/firm/jobs          queue a job for BOSS
//   GET  /api/firm/jobs/:id      job status + result
//   GET  /api/agents             the agent registry
//   POST /api/agents             register an outside agent (id, capability, price, endpoint, stake)
//   GET  /api/treasury           chain mode + treasury snapshot
//   GET  /health                 liveness + what is live

import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { runJob } from "../firm/run.js";
import { listAgents, registerAgent } from "../firm/agents.js";
import { treasury } from "../chain/treasury.js";
import { market, specHash, decorate } from "../chain/market.js";
import { judgeDelivery } from "../firm/accept.js";
import { providersInOrder, modelStatus } from "../ai/model.js";
import { BOSS_POLICY } from "../security/policies.js";
import { env } from "../config/env.js";
import { limits, clientIp } from "./limits.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const webRoot = join(root, "frontend");
const specDir = join(root, "data", "specs");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res, code, body, headers = {}) {
  res.writeHead(code, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** The second firm can run inside this container (BOSS_EMBED_WORKER=1). Its
 * listener stays on loopback; only the deliverable path is reachable from
 * outside, so a result URL from the worker resolves on the public origin.
 */
const EMBED_WORKER = process.env.BOSS_EMBED_WORKER === "1";
// The worker keeps its own port, not the platform's PORT, so it can share the
// container with the firm.
const WORKER_PORT = Number(process.env.BOSS_WORKER_PORT || 8795);
if (EMBED_WORKER) {
  env.workerPort = WORKER_PORT;
  env.workerUrl = `http://127.0.0.1:${WORKER_PORT}`;
}

/**
 * Forward /result/<id> to the embedded worker byte-for-byte. The client checks
 * the SHA-256 of these bytes, so the body must not be re-encoded.
 */
async function proxyWorkerResult(res, pathname) {
  try {
    const upstream = await fetch(`http://127.0.0.1:${WORKER_PORT}${pathname}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "content-length": body.length,
    });
    res.end(body);
  } catch (e) {
    json(res, 502, { error: `the second firm is not answering (${String(e.message || e).slice(0, 120)})` });
  }
}

/** 429 with the same shape every guarded route uses. */
function tooMany(res, gate) {
  return json(
    res,
    429,
    { error: gate.reason, code: gate.code, retryAfter: gate.retryAfter },
    { "retry-after": String(gate.retryAfter) }
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 2e6) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const jobs = new Map();

// cross-firm market helpers
function specPath(hash) {
  return join(specDir, `${hash}.json`);
}

function saveSpec(specText) {
  const hash = specHash(specText);
  mkdirSync(specDir, { recursive: true });
  writeFileSync(specPath(hash), specText, "utf8");
  return hash;
}

function loadSpec(hash) {
  if (!/^[a-f0-9]{64}$/.test(String(hash || ""))) return null;
  if (!existsSync(specPath(hash))) return null;
  try {
    return JSON.parse(readFileSync(specPath(hash), "utf8"));
  } catch {
    return null;
  }
}

function recentSpecs(limit = 12) {
  if (!existsSync(specDir)) return [];
  return readdirSync(specDir)
    .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
    .map((f) => ({ file: f, mtime: statSync(join(specDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ file }) => {
      const hash = file.replace(/\.json$/, "");
      const spec = loadSpec(hash);
      return spec ? { hash, ...spec } : null;
    })
    .filter(Boolean);
}

/**
 * Read a submitted job, check the bytes against the on-chain hash, and judge
 * them. Writes nothing: the caller decides who signs the settlement, which is
 * what lets a browser client settle with its own key.
 */
async function inspectJob(id) {
  const job = decorate(await market.getJob(id));
  if (job.status !== "Submitted") {
    return { action: null, job, reason: `job is ${job.status}, not Submitted` };
  }

  // No spec on this server means the acceptance checks cannot be applied.
  // Paying anyway would be paying on the worker's word, so refund instead.
  const spec = loadSpec(job.specHash);
  if (!spec) {
    return {
      action: "refund",
      reason: "this server does not hold the spec for that job, so the work cannot be checked",
      job,
    };
  }

  let text;
  try {
    const fetched = await fetch(job.resultUrl, { signal: AbortSignal.timeout(20_000) });
    if (!fetched.ok) throw new Error(`HTTP ${fetched.status}`);
    text = await fetched.text();
  } catch (e) {
    return {
      action: "refund",
      reason: `result unreachable (${String(e.message || e).slice(0, 120)}) — a delivery nobody can read cannot be paid`,
      job,
    };
  }

  const gotHash = specHash(text);
  if (gotHash !== job.resultHash) {
    return {
      action: "refund",
      reason: "the bytes served do not match the hash the worker put on chain",
      expected: job.resultHash,
      got: gotHash,
      job,
    };
  }

  const verdict = await judgeDelivery(spec, text);
  return { action: verdict.ok ? "release" : "refund", verdict, deliverable: text.slice(0, 6000), job };
}

async function probeWorker() {
  const url = env.workerUrl;
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { online: false, url };
    const health = await res.json();
    return { online: true, url, ...health };
  } catch {
    return { online: false, url };
  }
}

function marketReady(res) {
  if (market.live) return true;
  json(res, 503, {
    error: "the market is not configured on this server",
    fix: "set BOSS_MARKET_CONTRACT_ID and a funded NEAR key on the server",
  });
  return false;
}

function createJob({ brief, budget = 20, client = "you" }) {
  const id = randomUUID().slice(0, 8);
  const job = { id, brief, budget, client, status: "running", createdAt: new Date().toISOString(), events: [] };
  jobs.set(id, job);
  return job;
}

async function executeJob(job) {
  try {
    job.result = await runJob({
      brief: job.brief,
      budget: job.budget,
      client: job.client,
      onEvent: (e) => job.events.push(e),
    });
    job.status = job.result.error ? "failed" : "done";
  } catch (e) {
    job.status = "failed";
    job.error = String(e.message || e);
  }
  job.finishedAt = new Date().toISOString();
  return job;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  // The embedded second firm listens on loopback; expose only its deliverable
  // path, and only for a numeric job id.
  if (EMBED_WORKER && /^\/result\/\d+$/.test(url.pathname)) {
    return proxyWorkerResult(res, url.pathname);
  }

  if (url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      service: "boss",
      policy: BOSS_POLICY,
      live: {
        models: providersInOrder().map((p) => p.name),
        // Configured is not the same as answering. `null ok` = not tried yet.
        modelStatus: modelStatus(),
        treasury: env.treasuryContractId || "not-deployed",
        market: env.marketContractId || "not-deployed",
        worker: env.workerAccount || "not-configured",
        // Configured is not running: the embedded child can die on its own.
        workerEmbedded: EMBED_WORKER,
        workerChildAlive: EMBED_WORKER ? workerChild !== null : null,
        chain: { mode: treasury.mode, contract: treasury.contractId || null, network: treasury.network },
      },
      agents: listAgents().length,
    });
  }

  // public demo limits
  // The UI shows these before someone presses send, and they are the numbers
  // that keep a hosted instance from draining the operator's key and wallet.
  if (url.pathname === "/api/limits" && req.method === "GET") {
    return json(res, 200, { ok: true, ...limits.snapshot(clientIp(req)) });
  }

  // run a job, streamed (the chat UI)
  if (url.pathname === "/api/mission/stream" && req.method === "GET") {
    const brief = (url.searchParams.get("task") || "").trim();
    const budget = limits.clampBudget(url.searchParams.get("budget"));
    if (!brief) return json(res, 400, { error: "task required" });
    if (brief.length > 1200) return json(res, 400, { error: "brief is too long (1200 characters max)" });

    const gate = limits.begin(clientIp(req));
    if (!gate.ok) return tooMany(res, gate);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
    });

    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      const result = await runJob({ brief, budget, paceMs: 40, onEvent: send });
      send({ type: "job.result", ...result });
      send({ type: "limits", ...limits.snapshot(clientIp(req)) });
    } catch (e) {
      send({ type: "mission.error", error: String(e.message || e) });
    } finally {
      gate.release();
    }
    return res.end();
  }

  // run a job, one shot
  if (url.pathname === "/api/mission" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "body must be JSON" });
    }
    const text = String(body.brief || body.task || "").trim();
    if (!text) return json(res, 400, { error: "brief required" });
    if (text.length > 1200) return json(res, 400, { error: "brief is too long (1200 characters max)" });

    // A rejected request must not cost the caller one of its daily jobs.
    const gate = limits.begin(clientIp(req));
    if (!gate.ok) return tooMany(res, gate);
    try {
      const events = [];
      const result = await runJob({
        brief: text,
        budget: limits.clampBudget(body.budget),
        onEvent: (e) => events.push(e),
      });
      return json(res, 200, { ...result, events, limits: limits.snapshot(clientIp(req)) });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    } finally {
      gate.release();
    }
  }

  // BOSS as a worker: another company or agent hires it
  if (url.pathname === "/api/firm/work" && req.method === "POST") {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "body must be JSON" });
    }
    const brief = String(body.brief || body.task || "").trim();
    if (!brief) return json(res, 400, { error: "brief required" });
    if (brief.length > 1200) return json(res, 400, { error: "brief is too long (1200 characters max)" });

    const gate = limits.begin(clientIp(req));
    if (!gate.ok) return tooMany(res, gate);
    try {
      const budget = limits.clampBudget(body.budget, 5);
      const client = String(body.client || "anonymous-agent").slice(0, 64);

      const job = createJob({ brief, budget, client });
      await executeJob(job);

      if (job.error) return json(res, 500, { error: job.error, jobId: job.id });
      const r = job.result;
      return json(res, 200, {
        jobId: job.id,
        client,
        brief,
        deliverable: r.artifact,
        accepted: r.verdict?.ok ?? false,
        score: r.verdict?.score ?? null,
        invoice: { amount: r.spent, currency: "USD", settled: r.payments.length, mode: treasury.mode },
        payments: r.payments,
        stages: r.stages?.map((s) => ({ kind: s.kind, agent: s.agent, price: s.price })),
        ms: r.ms,
      });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    } finally {
      gate.release();
    }
  }

  // job queue
  if (url.pathname === "/api/firm/jobs" && req.method === "GET") {
    return json(res, 200, {
      jobs: [...jobs.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((j) => ({ id: j.id, brief: j.brief, status: j.status, createdAt: j.createdAt, spent: j.result?.spent })),
    });
  }

  if (url.pathname === "/api/firm/jobs" && req.method === "POST") {
    const gate = limits.begin(clientIp(req));
    if (!gate.ok) return tooMany(res, gate);
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const brief = String(body.brief || body.task || "").trim();
      if (!brief) {
        gate.release();
        return json(res, 400, { error: "brief required" });
      }
      if (brief.length > 1200) {
        gate.release();
        return json(res, 400, { error: "brief is too long (1200 characters max)" });
      }
      const job = createJob({
        brief,
        budget: limits.clampBudget(body.budget, 5),
        client: String(body.client || "you").slice(0, 64),
      });
      // The slot is held until the background job finishes, not until the
      // response is sent: otherwise the queue could start jobs without bound.
      executeJob(job).finally(gate.release); // async; poll /api/firm/jobs/:id
      return json(res, 202, { id: job.id, status: job.status });
    } catch (e) {
      gate.release();
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  if (url.pathname.startsWith("/api/firm/jobs/") && req.method === "GET") {
    const id = url.pathname.split("/").pop();
    const job = jobs.get(id);
    if (!job) return json(res, 404, { error: "job not found" });
    return json(res, 200, {
      id: job.id,
      brief: job.brief,
      status: job.status,
      client: job.client,
      spent: job.result?.spent ?? 0,
      artifact: job.result?.artifact ?? null,
      verdict: job.result?.verdict ?? null,
      payments: job.result?.payments ?? [],
      error: job.error || job.result?.error || null,
    });
  }

  // agent registry
  if (url.pathname === "/api/agents" && req.method === "GET") {
    return json(res, 200, { agents: listAgents() });
  }

  if (url.pathname === "/api/agents" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const agent = registerAgent(body);
      // An outside agent must exist on-chain before the treasury can pay it.
      treasury.ensureAgents([agent.id]).catch((e) => console.log(`  agent registration failed: ${e.message}`));
      return json(res, 201, { agent });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  // treasury
  if (url.pathname === "/api/treasury" && req.method === "GET") {
    return json(res, 200, await treasury.snapshot());
  }

  // cross-firm market
  // Everything the market panel needs in one call: contract state, the local
  // specs this firm published, and whether the second firm is awake.
  if (url.pathname === "/api/market" && req.method === "GET") {
    const snapshot = await market.snapshot();
    return json(res, 200, {
      ...snapshot,
      account: market.account,
      rate: env.nearUsdRate,
      worker: await probeWorker(),
      specs: recentSpecs(12),
    });
  }

  // Store a spec without touching the chain. A browser client uses this so the
  // worker can fetch the brief it is being asked to deliver; the client then
  // signs `open_job` itself.
  if (url.pathname === "/api/market/spec" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const brief = String(body.brief || body.task || "").trim();
      if (!brief) return json(res, 400, { error: "brief required" });
      if (brief.length > 1200) return json(res, 400, { error: "brief is too long (1200 characters max)" });

      const allowance = limits.allowSpec(clientIp(req));
      if (!allowance.ok) return tooMany(res, allowance);

      const spec = {
        brief,
        capability: String(body.capability || "writing").slice(0, 40),
        acceptance: Array.isArray(body.acceptance) ? body.acceptance.map(String).slice(0, 8) : [],
        requires: Array.isArray(body.requires) ? body.requires.map(String).slice(0, 8) : [],
        createdAt: new Date().toISOString(),
        client: String(body.client || "browser-client").slice(0, 64),
      };
      const specText = JSON.stringify(spec);
      const hash = saveSpec(specText);
      return json(res, 201, { hash, specHash: hash, specUrl: `${env.siteUrl}/api/market/spec/${hash}`, spec });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  // Publish a spec and escrow for it. The spec body is stored here and its hash
  // goes on chain, because prose on chain costs more than the job is worth.
  if (url.pathname === "/api/market/jobs" && req.method === "POST") {
    if (!marketReady(res)) return;
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "body must be JSON" });
    }
    const brief = String(body.brief || body.task || "").trim();
    if (!brief) return json(res, 400, { error: "brief required" });
    if (brief.length > 1200) return json(res, 400, { error: "brief is too long (1200 characters max)" });

    const gate = limits.begin(clientIp(req));
    if (!gate.ok) return tooMany(res, gate);
    try {
      const spec = {
        brief,
        capability: String(body.capability || "writing").slice(0, 40),
        acceptance: Array.isArray(body.acceptance) ? body.acceptance.map(String).slice(0, 8) : [],
        requires: Array.isArray(body.requires) ? body.requires.map(String).slice(0, 8) : [],
        createdAt: new Date().toISOString(),
        client: market.account,
      };
      const specText = JSON.stringify(spec);
      const hash = saveSpec(specText);
      const specUrl = `${env.siteUrl}/api/market/spec/${hash}`;

      const depositUsd = Math.min(Math.max(Number(body.depositUsd) || 0.5, 0.01), 5);
      const deadlineSecs = Math.min(Math.max(Number(body.deadlineSecs) || 900, 10), 60 * 60 * 24 * 30);

      const opened = await market.openJob({
        capability: spec.capability,
        spec: specText,
        specUrl,
        depositUsd,
        deadlineSecs,
      });

      return json(res, 201, {
        ...opened,
        job: decorate(opened.job),
        specHash: hash,
        specUrl,
        spec,
        limits: limits.snapshot(clientIp(req)),
      });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    } finally {
      gate.release();
    }
  }

  // The spec is immutable, so a worker can cache it against its hash.
  if (url.pathname.startsWith("/api/market/spec/") && req.method === "GET") {
    const hash = url.pathname.split("/").pop();
    const spec = loadSpec(hash);
    if (!spec) return json(res, 404, { error: "no spec with that hash" });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, immutable",
      "access-control-allow-origin": "*",
    });
    return res.end(JSON.stringify({ hash, ...spec }));
  }

  if (url.pathname.startsWith("/api/market/jobs/") && req.method === "GET") {
    try {
      const id = Number(url.pathname.split("/").pop());
      if (!Number.isInteger(id) || id < 0) return json(res, 400, { error: "bad job id" });
      const job = decorate(await market.getJob(id));
      return json(res, 200, { ...job, spec: loadSpec(job.specHash) });
    } catch (e) {
      return json(res, 404, { error: String(e.message || e) });
    }
  }

  // Judge a submitted job without moving money. The browser reads this, then
  // signs its own `release` or `refund`, so the server never holds the client's
  // key and cannot settle on its own.
  if (/^\/api\/market\/jobs\/\d+\/verdict$/.test(url.pathname) && req.method === "POST") {
    try {
      const id = Number(url.pathname.split("/")[4]);
      const outcome = await inspectJob(id);
      if (!outcome.action) return json(res, 409, { error: outcome.reason, job: outcome.job });
      return json(res, 200, {
        action: outcome.action,
        reason: outcome.reason || null,
        verdict: outcome.verdict || null,
        deliverable: outcome.deliverable || null,
        expected: outcome.expected,
        got: outcome.got,
        job: decorate(await market.getJob(id)),
      });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  }

  // Settle a submitted job with the server's key: fetch the result, check the
  // hash, judge the work, then release or refund. The client never pays on the
  // worker's word. A client with a connected wallet uses /verdict instead and
  // signs the settlement itself.
  if (/^\/api\/market\/jobs\/\d+\/settle$/.test(url.pathname) && req.method === "POST") {
    if (!marketReady(res)) return;
    try {
      const id = Number(url.pathname.split("/")[4]);
      const outcome = await inspectJob(id);
      if (!outcome.action) return json(res, 409, { error: outcome.reason, job: outcome.job });

      const settled = outcome.action === "release" ? await market.release(id) : await market.refund(id);
      return json(res, 200, {
        ...outcome,
        job: decorate(await market.getJob(id)),
        tx: settled.tx,
        url: settled.url,
      });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  }

  // Cancel an open job, or take back a submitted one after its deadline.
  if (/^\/api\/market\/jobs\/\d+\/refund$/.test(url.pathname) && req.method === "POST") {
    if (!marketReady(res)) return;
    try {
      const id = Number(url.pathname.split("/")[4]);
      const job = decorate(await market.getJob(id));
      const refund = await market.refund(id);
      return json(res, 200, { action: "refund", job: decorate(await market.getJob(id)), tx: refund.tx, url: refund.url, before: job.status });
    } catch (e) {
      return json(res, 400, { error: String(e.message || e) });
    }
  }

  // static web app
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = join(webRoot, file);

  if (!full.startsWith(webRoot)) {
    res.writeHead(403);
    return res.end("forbidden");
  }

  if (existsSync(full)) {
    res.writeHead(200, {
      "content-type": MIME[extname(full)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    return res.end(readFileSync(full));
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// One container, two firms. The second firm is a separate process with its own
// account and key; only its listener is internal.
let workerChild = null;
if (EMBED_WORKER) {
  workerChild = spawn(process.execPath, [join(root, "scripts", "firm_worker.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      BOSS_BIND: "127.0.0.1",
      BOSS_WORKER_PORT: String(WORKER_PORT),
      // The result URL must be the public origin, because the client fetches it.
      BOSS_WORKER_URL: process.env.BOSS_WORKER_URL || env.siteUrl,
    },
  });
  workerChild.on("exit", (code, signal) => {
    console.error(`[worker] child exited (${signal || code}); new jobs will have no worker`);
    workerChild = null;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try {
        workerChild?.kill(signal);
      } catch {
        /* already gone */
      }
      process.exit(0);
    });
  }
}

server.listen(env.port, env.bind, () => {
  console.log(`BOSS listening on http://${env.bind}:${env.port}`);
  const chain = providersInOrder().map((p) => p.name).join(" → ") || "no model configured";
  console.log(`  models: ${chain}`);
  console.log(`  treasury: ${treasury.live ? `${treasury.contractId} on ${treasury.network}` : "local mirror (no key/contract)"}`);
  console.log(`  market:   ${market.live ? `${market.contractId} on ${market.network}` : "not configured — npm run deploy:market"}`);
  console.log(`  worker:   ${env.workerAccount || "not configured — npm run worker"}`);
  if (treasury.live) {
    treasury
      .ensureAgents(listAgents().map((a) => a.id))
      .then((r) => console.log(`  agents on-chain: ${r.registered?.length ?? 0} new`))
      .catch((e) => console.log(`  treasury setup skipped: ${e.message}`));
  }
});
