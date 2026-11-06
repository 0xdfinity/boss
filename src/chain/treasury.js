// Treasury — one interface over two backends:
//   1. live: the boss_treasury contract on NEAR (real tx, real caps)
//   2. mirror: an in-memory ledger that applies the same rules, used when no
//      key/contract is configured so the demo never blocks.
//
// The mirror is honest about being a mirror: every result carries `mode`, and
// the UI prints "local mirror — not on-chain" when that is what happened.

import { env } from "../config/env.js";
import { Near, txUrl } from "./near.js";
import { BOSS_POLICY, toMicro } from "../security/policies.js";

const AGENTS = ["scout", "worker", "judge", "payer"];

export class Treasury {
  constructor() {
    this.near = new Near({
      rpcUrl: env.nearRpcUrl,
      accountId: env.nearAccount,
      privateKey: env.nearPrivateKey,
    });
    this.contractId = env.treasuryContractId;
    this.network = env.nearNetwork;
    this.mode = this.live ? "near" : "mirror";
    this.spentToday = 0;
    this.audit = [];
    this.budget = Number(BOSS_POLICY.dailyBudget);
    this.ready = null;
  }

  get live() {
    return Boolean(this.contractId && this.near.configured);
  }

  get explorer() {
    return (hash) => txUrl(hash, this.network);
  }

  /** Register the swarm's scoped agents once per process (owner calls). */
  async ensureAgents(ids = AGENTS) {
    if (!this.live) return { mode: "mirror" };
    if (this.ready && ids === AGENTS) return this.ready;
    const register = async () => {
      const registered = [];
      for (const agent of ids) {
        try {
          const profile = await this.near.callView(this.contractId, "agent_profile", { agent });
          if (profile) continue;
        } catch {
          // not registered yet
        }
        const perTx = toMicro(BOSS_POLICY.maxAgentSpend);
        await this.near.call({
          contractId: this.contractId,
          method: "create_sub_agent",
          args: { agent, max_per_tx: String(perTx), daily_limit: String(toMicro(BOSS_POLICY.dailyBudget)) },
        });
        registered.push(agent);
      }
      return { mode: "near", registered };
    };
    if (ids === AGENTS) {
      this.ready = register();
      return this.ready;
    }
    return register();
  }

  /**
   * Authorize a spend. Live mode calls the contract, which asserts the caps
   * on-chain. Returns { ok, mode, tx, reason }.
   */
  async authorize({ agent, amount, action, taskId, worker = null }) {
    const micro = toMicro(amount);

    if (toMicro(amount) <= 0) return { ok: false, mode: this.mode, reason: "amount must be positive" };
    if (micro > toMicro(BOSS_POLICY.maxAgentSpend)) {
      return { ok: false, mode: this.mode, reason: `exceeds per-tx cap of $${BOSS_POLICY.maxAgentSpend}` };
    }
    if (this.spentToday + amount > this.budget + 1e-9) {
      return { ok: false, mode: this.mode, reason: `exceeds daily cap of $${BOSS_POLICY.dailyBudget}` };
    }

    if (this.live) {
      try {
        // Outside agents get real NEAR, not just an IOU: the contract charges
        // the agent's allowance and transfers to the worker in the same call.
        const yocto = worker ? nearYocto(amount, env.nearUsdRate) : 0n;
        const paying = worker && yocto > 0n;
        const tx = await this.near.call({
          contractId: this.contractId,
          method: paying ? "pay" : "authorize_spend",
          args: paying
            ? { agent, amount: String(micro), worker, near_yocto: String(yocto), action: `${taskId || "task"} :: ${action}`.slice(0, 120) }
            : { agent, amount: String(micro), action: `${taskId || "task"} :: ${action}`.slice(0, 120) },
        });
        this.spentToday = round(this.spentToday + amount);
        this.audit.push({ agent, amount, action, taskId, tx: tx.hash, mode: "near", worker, yocto: String(yocto) });
        return { ok: true, mode: "near", tx: tx.hash, url: txUrl(tx.hash, this.network), yocto: String(yocto), worker };
      } catch (e) {
        return { ok: false, mode: "near", reason: String(e.message || e).slice(0, 200) };
      }
    }

    this.spentToday = round(this.spentToday + amount);
    this.audit.push({ agent, amount, action, taskId, mode: "mirror" });
    return { ok: true, mode: "mirror", tx: null };
  }

  async snapshot() {
    const recent = this.audit.slice(-10);
    if (!this.live) {
      return {
        mode: "mirror",
        contract: null,
        account: null,
        balance: null,
        spentToday: this.spentToday,
        budget: this.budget,
        audit: this.audit.length,
        entries: recent,
      };
    }
    try {
      const [acct, remaining] = await Promise.all([
        this.near.viewAccount(this.near.accountId),
        this.near.callView(this.contractId, "remaining_budget", {}),
      ]);
      return {
        mode: "near",
        network: this.network,
        contract: this.contractId,
        account: this.near.accountId,
        balance: nearToNear(acct.amount),
        remaining: Number(remaining) / 1e6,
        spentToday: this.spentToday,
        budget: this.budget,
        audit: this.audit.length,
        entries: recent.map((e) => ({ ...e, url: e.tx ? txUrl(e.tx, this.network) : "" })),
      };
    } catch (e) {
      return { mode: "near", contract: this.contractId, account: this.near.accountId, error: String(e.message) };
    }
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function nearToNear(yocto) {
  return Number(yocto) / 1e24;
}

/** USD -> yoctoNEAR at the configured demo rate. */
function nearYocto(usd, rate) {
  const perNear = Number(rate) > 0 ? Number(rate) : 10;
  return BigInt(Math.round((Number(usd) / perNear) * 1e24));
}

export const treasury = new Treasury();
