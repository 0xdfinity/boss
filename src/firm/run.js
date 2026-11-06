// runJob — the firm at work.
//
// Plan -> hire -> execute -> judge -> pay, stage by stage. Nothing is paid on
// a claim: the judge runs first, the treasury authorizes after. If a stage
// fails, the agent is not paid, loses reputation, and a second agent gets one
// attempt. If the second attempt fails, the job stops instead of faking it.

import { planStages, artifactHint, toPlainText } from "./plan.js";
import { hire, execute, recordOutcome, listAgents } from "./agents.js";
import { judgeStage, finalVerdict } from "./judge.js";
import { treasury } from "../chain/treasury.js";
import { BOSS_POLICY } from "../security/policies.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REQUIRED = { research: 0.35, draft: 0.9, critique: 0.45, revise: 0.8 };
const TOTAL = Object.values(REQUIRED).reduce((a, b) => a + b, 0);

/**
 * Keep the pipeline inside the client's budget. Prefer a pipeline that ends
 * with a real deliverable (draft + revise) over one that stops at a draft.
 */
export function fitStages(stages, budget) {
  const pick = (kinds) => stages.filter((s) => kinds.includes(s.kind));
  if (budget >= TOTAL) return stages;
  if (budget >= REQUIRED.draft + REQUIRED.revise) return pick(["draft", "revise"]);
  if (budget >= REQUIRED.research + REQUIRED.draft) return pick(["research", "draft"]);
  return [];
}

export async function runJob({ brief, budget = 20, client = "you", paceMs = 0, onEvent = () => {}, deps = {} }) {
  const hireFn = deps.hire || hire;
  const executeFn = deps.execute || execute;
  const judgeFn = deps.judge || judgeStage;
  const verdictFn = deps.finalVerdict || finalVerdict;
  const book = deps.treasury || treasury;
  const recordFn = deps.recordOutcome || recordOutcome;
  const listFn = deps.listAgents || listAgents;
  const started = Date.now();
  onEvent({ type: "mission.start", task: brief, budget, client });

  const planned = planStages(brief);
  const stages = fitStages(planned, budget);
  if (!stages.length) {
    onEvent({ type: "mission.error", error: `budget $${budget} is below the $1.25 minimum for research + draft` });
    return { brief, artifact: null, stages: [], paid: 0, rejected: 0, spent: 0, error: "budget too small" };
  }

  onEvent({
    type: "firm.plan",
    stages: stages.map((s) => ({ kind: s.kind, title: s.title })),
    hint: artifactHint(brief),
    budget,
  });

  const done = [];
  const rejected = [];
  const payments = [];
  let spent = 0;
  let prior = "";
  let critique = "";

  for (const stage of stages) {
    if (paceMs) await sleep(paceMs);

    let agent = hireFn(stage.capability);
    let attempt = 0;
    let accepted = false;

    while (agent && attempt < 2) {
      attempt++;
      onEvent({ type: "swarm.spawn", agent: agent.id, stage: stage.kind, price: agent.price });

      if (spent + agent.price > budget + 1e-9) {
        rejected.push({ stage: stage.kind, reason: `client budget would be exceeded ($${spent} + $${agent.price})` });
        onEvent({ type: "stage.rejected", stage: stage.kind, agent: agent.id, reason: "client budget exhausted" });
        agent = null;
        break;
      }

      let deliverable = "";
      let producer = null;
      try {
        onEvent({ type: "stage.start", stage: stage.kind, agent: agent.id, price: agent.price, title: stage.title });
        const out = await executeFn(agent, stage, { prior, critique });
        deliverable = out.deliverable;
        // Which provider actually produced this stage. The judge records its own
        // provider separately, and they can differ when one provider rate-limits.
        producer = out.via || null;
      } catch (e) {
        recordFn(agent.id, false);
        onEvent({ type: "stage.rejected", stage: stage.kind, agent: agent.id, reason: String(e.message || e).slice(0, 160) });
        rejected.push({ stage: stage.kind, agent: agent.id, reason: String(e.message || e).slice(0, 160) });
        agent = nextCandidate(listFn, stage.capability, agent.id);
        continue;
      }

      const verdict = await judgeFn(stage, deliverable, { prior, critique });

      if (!verdict.ok) {
        recordFn(agent.id, false);
        rejected.push({ stage: stage.kind, agent: agent.id, reason: verdict.reasons[0], score: verdict.score });
        onEvent({
          type: "proof.rejected",
          stage: stage.kind,
          agent: agent.id,
          reason: verdict.reasons[0],
          reasons: verdict.reasons,
          confidence: verdict.score / 100,
          mode: verdict.mode,
          sample: deliverable.slice(0, 600),
        });
        agent = nextCandidate(listFn, stage.capability, agent.id);
        continue;
      }

      // Verified. Now, and only now, the treasury is asked for money.
      const auth = await book.authorize({
        agent: agent.id,
        amount: agent.price,
        action: `${stage.title} accepted (${verdict.score}/100 via ${verdict.mode})`,
        taskId: stage.id,
        worker: agent.mode === "external" ? agent.account || null : null,
      });

      if (!auth.ok) {
        rejected.push({ stage: stage.kind, agent: agent.id, reason: auth.reason });
        onEvent({ type: "payment.rejected", task: stage.title, agent: agent.id, reason: auth.reason });
        agent = null;
        break;
      }

      recordFn(agent.id, true);
      spent = round(spent + agent.price);
      payments.push({
        stage: stage.kind,
        agent: agent.id,
        amount: agent.price,
        tx: auth.tx,
        url: auth.url,
        mode: auth.mode,
        producer,
        judge: verdict.mode,
      });

      onEvent({
        type: "verifier.attested",
        stage: stage.kind,
        agent: agent.id,
        confidence: verdict.score / 100,
        mode: verdict.mode,
        producer,
        reasons: verdict.reasons,
      });
      onEvent({
        type: "payer.settled",
        task: stage.title,
        worker: agent.id,
        account: auth.worker || null,
        amount: agent.price,
        chain: auth.mode === "near" ? "NEAR" : "ledger",
        mode: auth.mode === "near" ? "on-chain" : "mirror",
        tx: auth.tx,
        url: auth.url,
        yocto: auth.yocto || null,
      });
      onEvent({ type: "mission.spent", spent, remaining: round(budget - spent) });

      done.push({ ...stage, agent: agent.id, price: agent.price, deliverable, verdict });
      if (stage.kind === "draft") prior = deliverable;
      if (stage.kind === "critique") critique = deliverable;
      if (stage.kind === "revise") prior = deliverable;
      accepted = true;
      break;
    }

    if (!accepted) {
      const reason = rejected.at(-1)?.reason || "no capable agent";
      onEvent({ type: "mission.error", error: `${stage.kind} failed — ${reason}. Nothing more was paid.` });
      return {
        brief,
        artifact: prior || null,
        stages: done,
        paid: payments.length,
        rejected: rejected.length,
        spent,
        payments,
        error: `${stage.kind} failed`,
      };
    }
  }

  const artifact = toPlainText(prior || done.at(-1)?.deliverable || "");
  const verdict = await verdictFn(brief, artifact);
  onEvent({ type: "firm.verdict", ...verdict });

  const result = {
    brief,
    artifact,
    stages: done.map((d) => ({ kind: d.kind, agent: d.agent, price: d.price, verdict: d.verdict, deliverable: d.deliverable })),
    payments,
    paid: payments.length,
    rejected: rejected.length,
    spent,
    budget,
    verdict,
    ms: Date.now() - started,
  };

  onEvent({
    type: "mission.complete",
    task: brief,
    paid: payments.length,
    rejected: rejected.length,
    spent,
    budget,
    verdict,
    artifact,
    ms: result.ms,
  });

  return result;
}

function nextCandidate(listFn, capability, excludeId) {
  return (
    listFn()
      .filter((a) => a.capability === capability && a.id !== excludeId && a.reputation >= 55 && a.price <= 2)
      .sort((a, b) => a.price - b.price || b.reputation - a.reputation)[0] || null
  );
}

function round(n) {
  return Math.round(n * 100) / 100;
}

export const POLICY = BOSS_POLICY;
