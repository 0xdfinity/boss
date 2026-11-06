// NEAR Intents definitions — Real-World Money + Unstoppable DeFi tracks.
// An intent says: lock {amount} on NEAR, pay {amount} USDC on {chain} to the worker.

export function defineIntent({ amount, chain = "base", taskId, recipient }) {
  if (!amount || amount <= 0) throw new Error("intent amount must be positive");
  if (!taskId) throw new Error("intent requires a taskId");
  return {
    id: `intent_${taskId}`,
    amount,
    fromChain: "near",
    toChain: chain,
    token: "USDC",
    taskId,
    recipient: recipient ?? `worker_${taskId}`,
    proofRequired: true,
  };
}
