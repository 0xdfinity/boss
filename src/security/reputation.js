// Agent reputation scoring — AI Security & Defense track.
// Failures (bad proof, dropped tasks) lower reputation;
// verified work raises it. Low-reputation agents get skipped by the swarm.

const scores = new Map();

export function registerAgent(agentId) {
  if (!scores.has(agentId)) scores.set(agentId, 50);
  return scores.get(agentId);
}

export function getReputation(agentId) {
  return scores.get(agentId) ?? 50;
}

export function addScore(agentId, delta) {
  const next = Math.max(0, Math.min(100, getReputation(agentId) + delta));
  scores.set(agentId, next);
  return next;
}

export function isEligible(agentId, threshold = 30) {
  return getReputation(agentId) >= threshold;
}
