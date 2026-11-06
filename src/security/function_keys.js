// Function-call access keys — AI Security & Defense track.
// Each sub-agent gets a key scoped to ONE treasury method with a bounded
// allowance. The contract enforces the cap even if the agent is prompt-injected.

export const AGENT_KEY_SCOPES = Object.freeze({
  scout: { method: "authorize_spend", maxMicro: 500_000 },
  verifier: { method: "authorize_spend", maxMicro: 1_000_000 },
  payer: { method: "authorize_spend", maxMicro: 2_000_000 },
});

export function scopedKey(agentId) {
  const scope = AGENT_KEY_SCOPES[agentId];
  if (!scope) throw new Error(`unknown agent: ${agentId}`);
  return {
    agentId,
    allowedMethods: [scope.method],
    allowanceMicro: scope.maxMicro,
  };
}
