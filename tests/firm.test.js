import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob, fitStages } from "../src/firm/run.js";
import { planStages } from "../src/firm/plan.js";

const BOOK = {
  "a.research": { id: "a.research", capability: "research", price: 0.35, reputation: 80 },
  "q.draft": { id: "q.draft", capability: "draft", price: 0.9, reputation: 90 },
  "q2.draft": { id: "q2.draft", capability: "draft", price: 1.1, reputation: 70 },
  "l.critique": { id: "l.critique", capability: "critique", price: 0.45, reputation: 84 },
  "f.revise": { id: "f.revise", capability: "revise", price: 0.8, reputation: 87 },
};

function fakeHire(capability) {
  return Object.values(BOOK).find((a) => a.capability === capability && a.id !== "q2.draft") || null;
}

function fakeExecute(agent, stage) {
  return { deliverable: `${agent.id}::${stage.kind} output`, via: "test" };
}

function makeTreasury({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async authorize(input) {
      calls.push(input);
      if (fail) return { ok: false, mode: "mirror", reason: "daily cap reached" };
      return { ok: true, mode: "mirror", tx: null, url: "" };
    },
  };
}

test("happy path: four stages, four payments, artifact is the revision", async () => {
  const book = makeTreasury();
  const events = [];
  const r = await runJob({
    brief: "write five taglines",
    budget: 20,
    deps: {
      hire: fakeHire,
      execute: fakeExecute,
      judge: async () => ({ ok: true, mode: "test", score: 88, reasons: ["fine"] }),
      finalVerdict: async () => ({ ok: true, mode: "test", score: 90, reasons: [] }),
      treasury: book,
      listAgents: () => Object.values(BOOK),
      recordOutcome: () => {},
    },
    onEvent: (e) => events.push(e),
  });

  assert.equal(r.paid, 4);
  assert.equal(r.spent, 2.5);
  assert.equal(r.artifact, "f.revise::revise output");
  assert.equal(book.calls.length, 4);
  assert.ok(events.some((e) => e.type === "mission.complete"));
  assert.ok(events.some((e) => e.type === "payer.settled" && e.worker === "q.draft"));
});

test("a rejected draft goes to the next agent, who is the one paid", async () => {
  const book = makeTreasury();
  const outcomes = [];
  const r = await runJob({
    brief: "write five taglines",
    budget: 20,
    deps: {
      hire: () => BOOK["q.draft"],
      execute: (agent, stage) => ({ deliverable: `${agent.id}::${stage.kind}` }),
      // first draft agent fails, the stand-in passes
      judge: async (stage, deliverable) => ({
        ok: !deliverable.startsWith("q.draft"),
        mode: "test",
        score: deliverable.startsWith("q.draft") ? 30 : 85,
        reasons: ["test"],
      }),
      finalVerdict: async () => ({ ok: true, mode: "test", score: 90, reasons: [] }),
      treasury: book,
      listAgents: () => Object.values(BOOK),
      recordOutcome: (id, pass) => outcomes.push([id, pass]),
    },
  });

  assert.equal(r.paid, 4);
  const draftPayment = book.calls.find((c) => c.agent.includes("draft"));
  assert.equal(draftPayment.agent, "q2.draft");
  assert.ok(outcomes.some(([id, pass]) => id === "q.draft" && pass === false));
  assert.ok(outcomes.some(([id, pass]) => id === "q2.draft" && pass === true));
});

test("two failed agents stop the job; nothing after is paid", async () => {
  const book = makeTreasury();
  const r = await runJob({
    brief: "write five taglines",
    budget: 20,
    deps: {
      hire: (cap) => Object.values(BOOK).find((a) => a.capability === cap && a.id !== "q2.draft"),
      execute: (agent, stage) => ({ deliverable: `${agent.id}::${stage.kind}` }),
      judge: async (stage) => (stage.kind === "draft"
        ? { ok: false, mode: "rules", score: 20, reasons: ["draft too short"] }
        : { ok: true, mode: "test", score: 85, reasons: [] }),
      finalVerdict: async () => ({ ok: true, score: 90, reasons: [] }),
      treasury: book,
      listAgents: () => Object.values(BOOK),
      recordOutcome: () => {},
    },
  });

  assert.equal(r.error, "draft failed");
  assert.equal(r.paid, 1); // research only
  assert.equal(r.spent, 0.35);
  assert.ok(book.calls.every((c) => c.agent === "a.research"));
});

test("a treasury refusal stops the job and is reported", async () => {
  const book = makeTreasury({ fail: true });
  const r = await runJob({
    brief: "write five taglines",
    budget: 20,
    deps: {
      hire: fakeHire,
      execute: fakeExecute,
      judge: async () => ({ ok: true, mode: "test", score: 88, reasons: [] }),
      finalVerdict: async () => ({ ok: true, score: 90, reasons: [] }),
      treasury: book,
      listAgents: () => Object.values(BOOK),
      recordOutcome: () => {},
    },
  });
  assert.equal(r.paid, 0);
  assert.equal(r.error, "research failed");
  assert.equal(r.spent, 0);
});

test("budget shrinks the pipeline instead of overrunning it", () => {
  const stages = planStages("x");
  assert.equal(fitStages(stages, 20).length, 4);
  assert.deepEqual(fitStages(stages, 2).map((s) => s.kind), ["draft", "revise"]);
  assert.deepEqual(fitStages(stages, 1.3).map((s) => s.kind), ["research", "draft"]);
  assert.equal(fitStages(stages, 0.5).length, 0);
});
