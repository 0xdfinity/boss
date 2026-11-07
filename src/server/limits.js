// Public-use guardrails.
//
// A hosted BOSS spends two things it cannot get back: model quota (every job is
// several LLM calls) and testnet NEAR (every escrow is real). One open button
// and a bored visitor empties both, so the demo path is metered here — before
// the job starts, not after it has already paid.
//
// Three limits, all countable without a database:
//   per IP / day      stops one person from being the whole traffic
//   per day (global)  hard ceiling for the operator's wallet
//   concurrent        stops N tabs from running the firm at once
//
// Counts survive a restart when a persistent disk is mounted (BOSS_LIMITS_FILE);
// without one they reset on deploy, which is the safe direction.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const LIMIT_DEFAULTS = {
  perIpPerDay: envInt("BOSS_JOBS_PER_IP_DAY", 5),
  globalPerDay: envInt("BOSS_JOBS_PER_DAY", 60),
  concurrent: envInt("BOSS_CONCURRENT_JOBS", 2),
  maxBudget: envInt("BOSS_MAX_JOB_BUDGET", 8),
  specsPerIp: envInt("BOSS_SPECS_PER_IP_DAY", 20),
};

const secondsToUtcMidnight = (now) => {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now) / 1000));
};

/** Behind a proxy every socket is 127.0.0.1, so per-IP only works when told. */
export function clientIp(req, trustProxy = process.env.BOSS_TRUST_PROXY === "1") {
  if (trustProxy) {
    const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return String(req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

export class Limits {
  constructor(opts = {}) {
    this.perIpPerDay = opts.perIpPerDay ?? LIMIT_DEFAULTS.perIpPerDay;
    this.globalPerDay = opts.globalPerDay ?? LIMIT_DEFAULTS.globalPerDay;
    this.concurrent = opts.concurrent ?? LIMIT_DEFAULTS.concurrent;
    this.maxBudget = opts.maxBudget ?? LIMIT_DEFAULTS.maxBudget;
    this.specsPerIp = opts.specsPerIp ?? LIMIT_DEFAULTS.specsPerIp;
    this.file = opts.file === undefined ? process.env.BOSS_LIMITS_FILE || join(root, "data", "limits.json") : opts.file;
    this.now = opts.now || (() => new Date());
    this.running = 0;
    this.state = this.load();
    this.roll();
  }

  dayKey() {
    return this.now().toISOString().slice(0, 10);
  }

  load() {
    const empty = { day: this.dayKey(), global: 0, ips: {}, lastJobAt: null };
    if (!this.file || !existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      if (!raw || typeof raw !== "object") return empty;
      return {
        day: String(raw.day || empty.day),
        global: Number(raw.global) || 0,
        ips: raw.ips && typeof raw.ips === "object" ? raw.ips : {},
        lastJobAt: raw.lastJobAt || null,
      };
    } catch {
      // A corrupt counter must not take the server down; resetting it is the
      // conservative failure because it can only reduce what is allowed next.
      return empty;
    }
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.state), "utf8");
    } catch {
      // Read-only disk: the in-memory count still applies for this process.
    }
  }

  /** New UTC day, new budget. Counts are daily, so nothing else carries over. */
  roll() {
    const day = this.dayKey();
    if (this.state.day === day) return false;
    this.state = { day, global: 0, ips: {}, lastJobAt: this.state.lastJobAt };
    this.save();
    return true;
  }

  used(ip) {
    this.roll();
    return Number(this.state.ips[ip] || 0);
  }

  check(ip) {
    this.roll();
    const retryAfter = secondsToUtcMidnight(this.now());

    if (this.running >= this.concurrent) {
      return {
        ok: false,
        code: "concurrent",
        reason: `the firm is already running ${this.running} job${this.running === 1 ? "" : "s"}; retry in a moment`,
        retryAfter: 10,
      };
    }
    if (this.state.global >= this.globalPerDay) {
      return {
        ok: false,
        code: "daily",
        reason: `the public demo reached its ${this.globalPerDay} jobs for today`,
        retryAfter,
      };
    }
    const used = this.used(ip);
    if (used >= this.perIpPerDay) {
      return {
        ok: false,
        code: "ip",
        reason: `this address has run its ${this.perIpPerDay} demo jobs for today`,
        retryAfter,
      };
    }
    return {
      ok: true,
      remaining: Math.min(this.perIpPerDay - used, this.globalPerDay - this.state.global),
    };
  }

  /**
   * Claim a slot. The caller must call release() when the job finishes, in a
   * finally block, or one crash permanently lowers the concurrency ceiling.
   */
  begin(ip) {
    const gate = this.check(ip);
    if (!gate.ok) return gate;

    this.state.global += 1;
    this.state.ips[ip] = this.used(ip) + 1;
    this.state.lastJobAt = this.now().toISOString();
    this.running += 1;
    this.save();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.running = Math.max(0, this.running - 1);
    };
    return { ...gate, ok: true, release };
  }

  /** Never let a request choose its own budget. */
  clampBudget(value, fallback = this.maxBudget) {
    const n = Number(value);
    const budget = Number.isFinite(n) && n > 0 ? n : fallback;
    return Math.round(Math.min(budget, this.maxBudget) * 100) / 100;
  }

  /**
   * Storing a spec is not a job, but it is a file write. Capped separately so
   * a script cannot fill the disk without ever paying for a job.
   */
  allowSpec(ip) {
    this.roll();
    const key = `spec:${ip}`;
    const used = Number(this.state.ips[key] || 0);
    if (used >= this.specsPerIp) {
      return {
        ok: false,
        code: "spec",
        reason: `this address stored its ${this.specsPerIp} specs for today`,
        retryAfter: secondsToUtcMidnight(this.now()),
      };
    }
    this.state.ips[key] = used + 1;
    this.save();
    return { ok: true, remaining: this.specsPerIp - used - 1 };
  }

  snapshot(ip) {
    this.roll();
    const used = this.used(ip);
    return {
      day: this.state.day,
      perIp: { used, cap: this.perIpPerDay, left: Math.max(0, this.perIpPerDay - used) },
      global: { used: this.state.global, cap: this.globalPerDay, left: Math.max(0, this.globalPerDay - this.state.global) },
      concurrent: { running: this.running, cap: this.concurrent },
      maxBudget: this.maxBudget,
      lastJobAt: this.state.lastJobAt,
    };
  }

  /** Test/webhook helper: forget today's counts. */
  reset() {
    this.state = { day: this.dayKey(), global: 0, ips: {}, lastJobAt: null };
    this.save();
  }
}

export const limits = new Limits();
