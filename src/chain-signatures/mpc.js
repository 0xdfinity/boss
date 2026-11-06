// Chain Signatures (MPC) — lets the NEAR account control EVM/Base wallets.
// Live path: derive the EVM address via chainsig.js / omni-transaction-rs
// (https://docs.near.org/chain-abstraction). This stub returns the derived
// address + a signed-message placeholder so the payer flow can proceed.

export function deriveEvmAddress(nearAccountId) {
  // Deterministic stand-in for the MPC-derived address.
  let hash = 0;
  for (const ch of nearAccountId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `0x${hash.toString(16).padStart(40, "0").slice(0, 40)}`;
}

export async function signEvmMessage(nearAccountId, message) {
  return {
    nearAccountId,
    evmAddress: deriveEvmAddress(nearAccountId),
    message,
    signature: `sig_${Buffer.from(message).toString("base64")}`,
    mode: "local-demo",
  };
}
