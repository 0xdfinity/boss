// Quick intent test: lock $2, require proof (see demo/script.md for the full flow).
import { checkSpend } from "../src/security/policies.js";
import { createPaymentIntent } from "../src/intents/solver.js";

const check = checkSpend({ agentId: "payer", amount: 2, proofVerified: true });
console.log("policy check:", check);
if (check.ok) {
  const intent = await createPaymentIntent({ amount: 2, chain: "base", taskId: "demo-001" });
  console.log("intent:", intent);
} else {
  console.log("rejected:", check.reason);
}
