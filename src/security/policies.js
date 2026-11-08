// BOSS policy engine — AI Security & Defense track.
// Mirrors the on-chain limits in contracts/boss_treasury/src/lib.rs.
// The contract is the source of truth at runtime; this client-side mirror
// lets agents fail fast before signing anything.

export const BOSS_POLICY = Object.freeze({
  maxAgentSpend: "2", // USDC per transaction
  dailyBudget: "20", // USDC per day across the swarm
  requireProof: true, // no verified proof = auto refund
  allowedChains: ["near"], // every settled payment in this build is NEAR
});

export function toMicro(amount) {
  // Store amounts as micro-units (1 USDC = 1,000,000) to match the contract.
  return Math.round(Number(amount) * 1_000_000);
}

export function checkSpend({ agentId, amount, spentToday = 0, proofVerified = true }) {
  const micro = toMicro(amount);
  if (micro <= 0) return { ok: false, reason: "amount must be positive" };
  if (micro > toMicro(BOSS_POLICY.maxAgentSpend)) {
    return { ok: false, reason: `exceeds per-tx limit of $${BOSS_POLICY.maxAgentSpend}` };
  }
  if (toMicro(spentToday) + micro > toMicro(BOSS_POLICY.dailyBudget)) {
    return { ok: false, reason: `exceeds daily budget of $${BOSS_POLICY.dailyBudget}` };
  }
  if (BOSS_POLICY.requireProof && !proofVerified) {
    return { ok: false, reason: "proof not verified — payment would auto-refund" };
  }
  return { ok: true, agentId, amountMicro: micro };
}
