// The cross-firm market: one thin wrapper over boss_market.
//
// Both sides of the market use this class. A client opens a job and escrows;
// a worker submits; the client releases or refunds. Nothing here decides who
// is right — that is the judge's job — this file only moves money by rule.

import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { Near, txUrl } from "./near.js";

export const specHash = (text) => createHash("sha256").update(String(text)).digest("hex");

/** USD -> yoctoNEAR at the configured demo rate. */
export function usdToYocto(usd, rate = env.nearUsdRate) {
  const perNear = Number(rate) > 0 ? Number(rate) : 10;
  // Keep this in integers: 0.5 / 10 * 1e24 is past the range where a JS float
  // still holds every digit, and an escrow that is off by a few yocto is still
  // an escrow nobody can reconcile.
  const micro = BigInt(Math.round(Number(usd) * 1e6));
  const rateMicro = BigInt(Math.round(perNear * 1e6));
  if (rateMicro <= 0n) throw new Error("NEAR_USD_RATE must be positive");
  return (micro * 10n ** 24n) / rateMicro;
}

export function yoctoToNear(yocto) {
  return Number(yocto) / 1e24;
}

export class Market {
  constructor({ accountId = env.nearAccount, privateKey = env.nearPrivateKey, contractId = env.marketContractId } = {}) {
    this.near = new Near({ rpcUrl: env.nearRpcUrl, accountId, privateKey });
    this.contractId = contractId;
    this.network = env.nearNetwork;
  }

  get live() {
    return Boolean(this.contractId && this.near.configured);
  }

  get account() {
    return this.near.accountId;
  }

  url(hash) {
    return txUrl(hash, this.network);
  }

  async openJob({ capability, spec, specUrl, depositUsd = 0.5, deadlineSecs = 900 }) {
    if (!this.live) throw new Error("market is not configured (set BOSS_MARKET_CONTRACT_ID and a key)");
    const deposit = usdToYocto(depositUsd);
    if (deposit <= 0n) throw new Error("deposit must be positive");

    const hash = specHash(spec);
    const before = Number(await this.near.callView(this.contractId, "job_count", {}).catch(() => 0));

    const tx = await this.near.call({
      contractId: this.contractId,
      method: "open_job",
      args: {
        capability: String(capability),
        spec_hash: hash,
        spec_url: String(specUrl),
        deadline_secs: Number(deadlineSecs),
      },
      deposit,
    });

    // `open_job` returns the new id. Fall back to watching job_count grow, for
    // nodes that do not return a success value.
    let jobId = this.near.successValue(tx);
    if (!Number.isInteger(jobId)) {
      jobId = null;
      for (let i = 0; i < 20 && jobId === null; i++) {
        const count = Number(await this.near.callView(this.contractId, "job_count", {}));
        if (count > before) jobId = count - 1;
        else await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (jobId === null) throw new Error("job opened but its id could not be read back");

    // Reads can lag the receipt by a block. Wait until the job we opened is
    // actually visible, so callers never settle somebody else's job.
    let job = null;
    for (let i = 0; i < 20; i++) {
      try {
        const seen = await this.getJob(jobId);
        if (seen && seen.spec_hash === hash) {
          job = seen;
          break;
        }
      } catch {
        // not indexed yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!job) throw new Error(`job ${jobId} opened but is not readable yet`);

    return { jobId, job, tx: tx.hash, url: txUrl(tx.hash, this.network), depositNear: yoctoToNear(deposit) };
  }

  async submit({ jobId, result, resultUrl }) {
    if (!this.live) throw new Error("market is not configured");
    const tx = await this.near.call({
      contractId: this.contractId,
      method: "submit",
      args: {
        job_id: Number(jobId),
        result_hash: specHash(result),
        result_url: String(resultUrl),
      },
    });
    return { tx: tx.hash, url: txUrl(tx.hash, this.network) };
  }

  async release(jobId) {
    const tx = await this.near.call({
      contractId: this.contractId,
      method: "release",
      args: { job_id: Number(jobId) },
      gas: 40_000_000_000_000n,
    });
    return { tx: tx.hash, url: txUrl(tx.hash, this.network) };
  }

  async refund(jobId) {
    const tx = await this.near.call({
      contractId: this.contractId,
      method: "refund",
      args: { job_id: Number(jobId) },
      gas: 40_000_000_000_000n,
    });
    return { tx: tx.hash, url: txUrl(tx.hash, this.network) };
  }

  async getJob(jobId) {
    return this.near.callView(this.contractId, "get_job", { job_id: Number(jobId) });
  }

  async openJobs(from = 0, limit = 20) {
    return this.near.callView(this.contractId, "open_jobs", { from, limit });
  }

  async recentJobs(from = 0, limit = 20) {
    return this.near.callView(this.contractId, "recent_jobs", { from, limit });
  }

  async stats(accountId = this.account) {
    return this.near.callView(this.contractId, "agent_stats", { account: accountId });
  }

  async config() {
    return this.near.callView(this.contractId, "config", {});
  }

  async snapshot() {
    if (!this.live) {
      return { mode: "off", contract: null, account: null, jobs: [], message: "market not configured" };
    }
    const read = async () => {
      const [config, recent, open] = await Promise.all([
        this.config(),
        this.recentJobs(0, 12),
        this.openJobs(0, 12),
      ]);
      const [owner, arbiter, count, released, refunded] = config;
      return {
        mode: "near",
        network: this.network,
        contract: this.contractId,
        account: this.account,
        owner,
        arbiter: arbiter || null,
        jobs: Number(count),
        released: Number(released),
        refunded: Number(refunded),
        open: open.map(decorate),
        recent: recent.map(decorate),
      };
    };

    // Public RPC reads flake. One quiet retry turns a blank panel into a
    // correct one, which matters more than the 300ms.
    try {
      return await read();
    } catch {
      try {
        return await read();
      } catch (e) {
        return {
          mode: "near",
          contract: this.contractId,
          account: this.account,
          jobs: 0,
          released: 0,
          refunded: 0,
          open: [],
          recent: [],
          error: String(e.message || e).slice(0, 300),
        };
      }
    }
  }
}

export function decorate(job) {
  return {
    id: Number(job.id),
    client: job.client,
    worker: job.worker || null,
    capability: job.capability,
    specHash: job.spec_hash,
    specUrl: job.spec_url,
    depositNear: Number(job.deposit) / 1e24,
    depositUsd: Math.round((Number(job.deposit) / 1e24) * Number(env.nearUsdRate || 10) * 100) / 100,
    deadline: Number(job.deadline),
    resultHash: job.result_hash,
    resultUrl: job.result_url,
    status: typeof job.status === "string" ? job.status : Object.keys(job.status)[0] || "Unknown",
  };
}

export const market = new Market();
