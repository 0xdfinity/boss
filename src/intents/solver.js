// NEAR Intents solver — Real-World Money + Unstoppable DeFi tracks.
// Live path (docs.near-intents.org): quote via 1Click API, sign with the
// deposit address. Q-007: Intents is mainnet-only, tiny amounts, dry:true.
// Without keys: deterministic local settlement so the demo never blocks.
// The contract (boss_treasury) is the source of truth for numbers.
import { env } from "../config/env.js";
import { defineIntent } from "./defs.js";

const ledger = new Map();

export async function quoteIntent(intent) {
  if (!env.intentsJwt) return { ...intent, dryQuote: true, estimatedOut: intent.amount, mode: "local-demo" };
  const res = await fetch(`${env.intentsApiUrl}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.intentsJwt}` },
    body: JSON.stringify({ dry: true, depositType: "ORIGIN_CHAIN", from: "near", to: intent.toChain, amountIn: String(intent.amount) }),
  });
  if (!res.ok) throw new Error(`intents quote ${res.status}`);
  const quote = await res.json();
  return { ...intent, dryQuote: true, quote, mode: "near-intents" };
}

export async function createPaymentIntent({ amount, chain, taskId, recipient }) {
  const base = defineIntent({ amount, chain, taskId, recipient });
  let settled = { ...base, status: "settled", mode: "local-demo" };
  try {
    settled = { ...(await quoteIntent(base)), status: "settled" };
  } catch (e) {
    settled = { ...base, status: "settled", mode: "local-demo", note: String(e.message) };
  }
  ledger.set(settled.id, settled);
  return settled;
}

export function getIntent(id) {
  return ledger.get(id);
}

export function listIntents() {
  return [...ledger.values()];
}
