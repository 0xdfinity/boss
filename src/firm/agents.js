// Agent registry + execution.
//
// Built-in agents run in-process (they are BOSS's own staff). External agents
// register over HTTP with an endpoint, a capability, a price and a stake; BOSS
// hires whichever capable agent is cheapest at a reputation floor — so an
// outside agent can undercut the in-house team and win the work.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chatText } from "../ai/model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataDir = join(root, "data");
const file = join(dataDir, "agents.json");

export const BUILTIN = [
  { id: "atlas.research", name: "Atlas", capability: "research", price: 0.35, reputation: 88, jobs: 0, stake: 0, mode: "builtin" },
  { id: "quill.writer", name: "Quill", capability: "draft", price: 0.9, reputation: 91, jobs: 0, stake: 0, mode: "builtin" },
  { id: "lens.critic", name: "Lens", capability: "critique", price: 0.45, reputation: 84, jobs: 0, stake: 0, mode: "builtin" },
  { id: "forge.editor", name: "Forge", capability: "revise", price: 0.8, reputation: 87, jobs: 0, stake: 0, mode: "builtin" },
  { id: "gate.verify", name: "Gate", capability: "verify", price: 0.3, reputation: 95, jobs: 0, stake: 0, mode: "builtin" },
];

function load() {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw.external) ? raw.external : [];
  } catch {
    return [];
  }
}

let external = load();

function save() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ external }, null, 2));
}

export function listAgents() {
  return [...BUILTIN.map((a) => ({ ...a })), ...external];
}

export function getAgent(id) {
  return listAgents().find((a) => a.id === id) || null;
}

export function registerAgent(input) {
  const id = String(input.id || "").trim().toLowerCase();
  const capability = String(input.capability || "").trim().toLowerCase();
  const endpoint = String(input.endpoint || "").trim();
  const price = Number(input.price);

  if (!/^[a-z0-9][a-z0-9._-]{2,48}$/.test(id)) throw new Error("id must be 3-49 chars: a-z 0-9 . _ -");
  if (!["research", "draft", "critique", "revise", "verify"].includes(capability)) {
    throw new Error("capability must be research|draft|critique|revise|verify");
  }
  if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) throw new Error("endpoint must be http(s)");
  if (!Number.isFinite(price) || price <= 0 || price > 2) throw new Error("price must be > 0 and <= 2");

  const agent = {
    id,
    name: String(input.name || id).slice(0, 40),
    capability,
    price: Math.round(price * 100) / 100,
    reputation: Math.min(100, Math.max(0, Number(input.reputation) || 60)),
    jobs: 0,
    stake: Math.max(0, Number(input.stake) || 0),
    account: String(input.account || "").slice(0, 64),
    endpoint,
    mode: "external",
    addedAt: new Date().toISOString(),
  };

  external = external.filter((a) => a.id !== id);
  external.push(agent);
  save();
  return agent;
}

export function recordOutcome(id, pass) {
  const agent = external.find((a) => a.id === id) || BUILTIN.find((a) => a.id === id);
  if (!agent) return;
  agent.jobs = (agent.jobs || 0) + 1;
  if (pass) {
    agent.reputation = Math.min(100, agent.reputation + 2);
  } else {
    agent.reputation = Math.max(0, agent.reputation - 12);
    agent.stake = Math.max(0, Math.round((agent.stake - 1) * 100) / 100);
  }
  if (agent.mode === "external") save();
}

/** Cheapest capable agent at or above the reputation floor. */
export function hire(capability, { floor = 55 } = {}) {
  const candidates = listAgents()
    .filter((a) => a.capability === capability && a.reputation >= floor && a.price <= 2)
    .sort((a, b) => a.price - b.price || b.reputation - a.reputation);
  return candidates[0] || null;
}

/**
 * Run one stage with the hired agent. Built-ins call the model chain; external
 * agents receive an HTTP POST and must return { deliverable }.
 */
export async function execute(agent, stage, context) {
  if (agent.mode === "external") {
    const res = await fetch(agent.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: agent.id,
        stage: stage.kind,
        brief: stage.brief,
        title: stage.title,
        context,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`${agent.id} returned HTTP ${res.status}`);
    const data = await res.json();
    const deliverable = String(data.deliverable || "").trim();
    if (!deliverable) throw new Error(`${agent.id} returned an empty deliverable`);
    return { deliverable, via: agent.id };
  }

  const { system, user } = stage.prompt(stage.brief, context.prior, context.critique);
  const reply = await chatText({ system, user, temperature: stage.kind === "draft" ? 0.6 : 0.2 });
  if (!reply) {
    throw new Error(`no model available for ${agent.id} (set GROQ_API_KEY or NEAR_AI_MODEL)`);
  }
  return { deliverable: reply.text.trim(), via: reply.provider };
}
