import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSpend } from "../src/security/policies.js";

test("allows spend within limits", () => {
  assert.equal(checkSpend({ agentId: "payer", amount: 1.5, proofVerified: true }).ok, true);
});

test("rejects spend above per-tx limit", () => {
  const r = checkSpend({ agentId: "payer", amount: 3, proofVerified: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /per-tx limit/);
});

test("rejects spend when proof is missing", () => {
  assert.equal(checkSpend({ agentId: "payer", amount: 1, proofVerified: false }).ok, false);
});

test("rejects spend that breaches daily budget", () => {
  const r = checkSpend({ agentId: "payer", amount: 2, spentToday: 19.5, proofVerified: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /daily budget/);
});
