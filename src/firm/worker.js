// The worker firm — the other half of the market.
//
// This is a second BOSS instance with its own NEAR account, its own key, its
// own model budget and its own tool list. It polls boss_market for open jobs it
// can do, fetches the spec from the URL the client published, produces the
// deliverable, serves it over HTTP, and puts its hash on chain.
//
// Two rules make it honest:
//   * it only takes capabilities it actually lists in its agent card
//   * if a spec requires a tool it does not have, it declines in writing rather
//     than inventing a source. The client's judge then refuses the delivery and
//     the escrow refunds. That refusal is the product working.

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Market, specHash, decorate } from "../chain/market.js";
import { chatText } from "../ai/model.js";
import { env } from "../config/env.js";
import { lengthInstruction } from "./plan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const resultDir = join(root, "data", "results");

const DEFAULT_CAPABILITIES = ["writing", "rewrite", "critique", "plan", "research"];
const DEFAULT_TOOLS = [];

export class FirmWorker {
  constructor(opts = {}) {
    this.account = opts.account ?? env.workerAccount;
    this.key = opts.key ?? env.workerKey;
    this.port = Number(opts.port ?? env.workerPort);
    this.bind = opts.bind ?? env.bind;
    this.url = String(opts.url ?? env.workerUrl).replace(/\/$/, "");
    this.contractId = opts.contractId ?? env.marketContractId;
    this.capabilities = opts.capabilities ?? DEFAULT_CAPABILITIES;
    this.tools = opts.tools ?? DEFAULT_TOOLS;
    this.price = Number(opts.price ?? 0.5);
    this.pollMs = Number(opts.pollMs ?? 4000);
    this.maxAttempts = Number(opts.maxAttempts ?? 3);

    this.market = new Market({
      accountId: this.account,
      privateKey: this.key,
      contractId: this.contractId,
    });

    this.results = new Map();
    this.seen = new Set();
    this.attempts = new Map();
    this.log = [];
    this.busy = false;
    this.timer = null;
    this.server = null;
  }

  get live() {
    return Boolean(this.account && this.key && this.contractId);
  }

  record(line) {
    const entry = { at: new Date().toISOString(), line: String(line) };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    console.log(`[worker] ${entry.line}`);
    return entry;
  }

  // HTTP surface
  card() {
    return {
      protocol: "boss/1",
      type: "agent-card",
      account: this.account,
      name: "BOSS worker firm",
      capabilities: this.capabilities,
      tools: this.tools,
      pricing: { unit: "USD", perJob: this.price },
      settlement: {
        chain: "near",
        network: this.market.network,
        market: this.contractId,
      },
      endpoints: {
        result: `${this.url}/result/{jobId}`,
        health: `${this.url}/health`,
        card: `${this.url}/.well-known/agent-card.json`,
      },
      accepts: {
        spec: "application/json",
        note: "Put the brief in `brief`, the checks in `acceptance`, and any tool requirements in `requires`.",
      },
    };
  }

  start() {
    if (this.server) return this.server;
    mkdirSync(resultDir, { recursive: true });

    this.server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const send = (code, body, type = "application/json") => {
        res.writeHead(code, {
          "content-type": `${type}; charset=utf-8`,
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
        });
        res.end(body);
      };

      if (url.pathname === "/health") {
        return send(
          200,
          JSON.stringify({
            ok: true,
            account: this.account,
            capabilities: this.capabilities,
            tools: this.tools,
            market: this.contractId,
            network: this.market.network,
            delivered: this.results.size,
            last: this.log.at(-1) || null,
          })
        );
      }

      if (url.pathname === "/.well-known/agent-card.json") {
        return send(200, JSON.stringify(this.card(), null, 2));
      }

      const m = url.pathname.match(/^\/result\/(\d+)(\.json)?$/);
      if (m) {
        const jobId = Number(m[1]);
        const entry = this.results.get(jobId);
        if (!entry) return send(404, JSON.stringify({ error: "no result for that job" }));
        if (m[2]) {
          return send(
            200,
            JSON.stringify(
              {
                jobId,
                account: this.account,
                sha256: entry.hash,
                refused: entry.refused,
                missing: entry.missing,
                at: entry.at,
                bytes: Buffer.byteLength(entry.text),
              },
              null,
              2
            )
          );
        }
        // Plain text, byte-for-byte what was hashed. A JSON wrapper here would
        // change the hash and make an honest delivery look tampered with.
        return send(200, entry.text, "text/plain");
      }

      if (url.pathname === "/") {
        return send(200, JSON.stringify({ service: "boss-worker", card: "/.well-known/agent-card.json" }));
      }

      return send(404, JSON.stringify({ error: "not found" }));
    });

    this.server.on("error", (e) => {
      console.error(`[worker] cannot listen on ${this.bind}:${this.port} — ${e.message}`);
      if (e.code === "EADDRINUSE") {
        console.error(`[worker] change BOSS_WORKER_PORT and retry`);
        process.exit(1);
      }
    });

    this.server.listen(this.port, this.bind, () => {
      this.record(`listening on ${this.url} · ${this.capabilities.join(", ")} · tools: ${this.tools.join(", ") || "none"}`);
    });

    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.timer.unref?.();
    return this.server;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.server) this.server.close();
    this.server = null;
  }

  // market loop
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const open = await this.market.openJobs(0, 25);
      for (const raw of open) {
        const job = decorate(raw);
        if (!this.capabilities.includes(job.capability)) continue;
        if (this.seen.has(job.id)) continue;
        const tries = this.attempts.get(job.id) || 0;
        if (tries >= this.maxAttempts) continue;
        this.attempts.set(job.id, tries + 1);
        try {
          await this.handle(job);
          this.seen.add(job.id);
        } catch (e) {
          this.record(`job ${job.id} attempt ${tries + 1} failed: ${String(e.message || e).slice(0, 180)}`);
        }
      }
    } catch (e) {
      this.record(`poll failed: ${String(e.message || e).slice(0, 160)}`);
    } finally {
      this.busy = false;
    }
  }

  async handle(job) {
    const spec = await this.fetchSpec(job.specUrl);
    const out = await this.produce(spec);
    const hash = specHash(out.text);

    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(resultDir, `${job.id}.txt`), out.text, "utf8");
    this.results.set(job.id, {
      jobId: job.id,
      text: out.text,
      hash,
      refused: out.refused,
      missing: out.missing || [],
      at: new Date().toISOString(),
    });

    const tx = await this.market.submit({
      jobId: job.id,
      result: out.text,
      resultUrl: `${this.url}/result/${job.id}`,
    });

    this.record(
      `${out.refused ? "declined" : "delivered"} job ${job.id} (${job.capability}) · ${hash.slice(0, 12)}… · tx ${tx.tx.slice(0, 10)}…`
    );
    return { ...out, hash, tx };
  }

  async fetchSpec(url) {
    if (!url) throw new Error("job has no spec_url");
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`spec fetch ${res.status}`);
    const spec = await res.json();
    if (!spec || typeof spec.brief !== "string" || !spec.brief.trim()) {
      throw new Error("spec has no brief");
    }
    return spec;
  }

  async produce(spec) {
    const requires = Array.isArray(spec.requires) ? spec.requires.map(String) : [];
    const missing = requires.filter((t) => !this.tools.includes(t));

    if (missing.length) {
      // The honest answer to "read the chain" or "cite a live source" from a
      // firm without that tool. It is a delivery of a refusal, which the
      // client's rules catch, and the escrow goes back. Inventing a balance or
      // a URL here would be the dishonest path.
      return {
        refused: true,
        missing,
        text:
          `I can't take this job. It requires ${missing.join(", ")}, and this firm has no ` +
          `${missing.join(" or ")} tool installed. Rather than invent a number or a source I did not check, ` +
          `I am declining the job so the client's escrow can be refunded.`,
      };
    }

    const acceptance = Array.isArray(spec.acceptance) ? spec.acceptance.filter(Boolean) : [];
    const list = acceptance.length ? acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n") : "None stated.";
    const reply = await chatText({
      system:
        "You are an independent firm delivering work on the BOSS market. " +
        "You write only the deliverable the spec asks for: plain text, no preamble, no 'as an AI'. " +
        "You never claim to have browsed, verified, or measured anything you did not. " +
        "You never pad to hit a word count.",
      user:
        `Job spec:\n${spec.brief}\n\n` +
        `The client's judge will check:\n${list}\n\n` +
        `${lengthInstruction(spec.brief)}\n\n` +
        "If the acceptance list names a number of items, return exactly that many, numbered. " +
        "If it asks for one pick, name the pick. Return the finished deliverable only.",
      temperature: 0.4,
      maxTokens: 1200,
    });

    if (!reply) throw new Error("no model available");
    return { text: reply.text.trim(), refused: false, missing: [] };
  }
}

export { specHash };
