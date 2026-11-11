// Client-side wallet for the browser: your NEAR wallet, signed by you.
//
// NEAR's official connector (@hot-labs/near-connect, vendored under ./vendor)
// discovers wallets dynamically from the public manifest, so the list shown
// to the user is always the current one. It brings its own UI, so the chooser
// is a modal rather than a popup driven by hand.
//
// All the signing in this module happens inside the wallet:
//   open_job  — the user signs this, with the escrow attached
//   release   — the user signs this after the judge accepts
//   refund    — the user signs this after the judge refuses, or on no delivery
//
// The browser never holds a key, and the server learns nothing but signed
// transactions. If the wallet is not installed or cannot load the manifest,
// connect() rejects with the wallet's own error text.
import { NearConnector } from "./vendor/near-connect.js";

const RPC = "https://test.rpc.fastnear.com";
const YOCTO = 10n ** 24n;
const CALL_GAS = "30000000000000"; // 30 TGas

const connector = new NearConnector({
  network: "testnet",
  features: {
    signAndSendTransaction: true,
    signAndSendTransactions: true,
    signTransaction: true,
    signMessage: false,
  },
});

let currentWallet = null;
let currentAccount = null;

export function accountId() {
  return currentAccount?.accountId ?? null;
}

/** Open the wallet chooser. Resolves with the account the user picked. */
export async function connect() {
  const wallet = await connector.connect();
  const accounts = await wallet.getAccounts({ network: "testnet" });
  currentWallet = wallet;
  currentAccount = accounts[0] ?? null;
  if (!currentAccount) throw new Error("the wallet connected but returned no account");
  return currentAccount;
}

export async function disconnect() {
  if (currentWallet) await connector.disconnect(currentWallet);
  currentWallet = null;
  currentAccount = null;
}

/** Restore the session if the connector kept one. */
export async function restore() {
  try {
    const wallet = await connector.wallet();
    const accounts = await wallet.getAccounts({ network: "testnet" });
    currentWallet = wallet;
    currentAccount = accounts[0] ?? null;
    return currentAccount;
  } catch {
    currentWallet = null;
    currentAccount = null;
    return null;
  }
}

/** Sign and send a function call. Returns the final outcome reported by the wallet. */
export async function signAndCall({ receiverId, method, args = {}, deposit = "0" }) {
  if (!currentWallet) throw new Error("connect a wallet first");
  const accounts = await currentWallet.getAccounts({ network: "testnet" });
  const signerId = accounts[0]?.accountId;
  return currentWallet.signAndSendTransaction({
    receiverId,
    signerId,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: method, args, gas: CALL_GAS, deposit: String(deposit) },
      },
    ],
  });
}

/** Read a NEAR account's balance via the public RPC, without any SDK. */
export async function balanceOf(id) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "balance",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: id },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "view_account failed");
  return body.result;
}

const DEMO_USD = 0.5;

async function viewJobCount(contract) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "job_count",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: "job_count",
        args_base64: btoa(JSON.stringify({})),
      },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? "job_count failed");
  const raw = (body.result?.result ?? []).reduce((s, b) => s + b, 0);
  return JSON.parse(String.fromCharCode(...(body.result?.result ?? [])));
}

async function poll(fn, { timeoutMs = 240_000, everyMs = 3000 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return last;
}

const txUrl = (h) => (h ? `https://testnet.nearblocks.io/txns/${h}` : null);
const hashOf = (outcome) =>
  outcome?.transaction?.hash ?? outcome?.hash ?? (outcome?.status ? "" : "");

/**
 * The full client side of a market job, signed by the browser:
 * publish spec -> open_job + escrow (wallet) -> wait -> judge (server)
 * -> release or refund (wallet signs).
 */
export async function runAsClient({ contract, rate, brief, capability = "writing", acceptance = [], onLog = () => {} }) {
  const specRes = await fetch("/api/market/spec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief, capability, acceptance, client: accountId() }),
  });
  const spec = await specRes.json();
  if (!specRes.ok) throw new Error(spec.error ?? `spec failed (${specRes.status})`);
  onLog(`spec ${spec.hash.slice(0, 12)}… published (${brief.length} chars)`, "dim");

  const before = await viewJobCount(contract).catch(() => 0);
  const price = Number(rate) > 0 ? Number(rate) : 10;
  const deposit = String(BigInt(Math.round((DEMO_USD * Number(YOCTO)) / price)));

  onLog("confirm the escrow in your wallet", "dim");
  const opened = await signAndCall({
    receiverId: contract,
    method: "open_job",
    args: {
      capability: String(capability),
      spec_hash: String(spec.hash),
      spec_url: String(spec.specUrl),
      deadline_secs: 900,
    },
    deposit,
  });
  const openedHash = hashOf(opened);
  onLog(`open_job signed by your wallet · escrow moved`, "dim", txUrl(openedHash));

  let jobId = null;
  for (let i = 0; i < 20 && jobId === null; i++) {
    const count = await viewJobCount(contract).catch(() => before);
    if (count > before) jobId = count - 1;
    else await new Promise((r) => setTimeout(r, 600));
  }
  if (jobId === null) throw new Error("the job opened but its id could not be read back");

  onLog(`job ${jobId} open · client ${accountId()}`, "dim");

  const delivered = await poll(async () => {
    const res = await fetch(`/api/market/jobs/${jobId}`);
    if (!res.ok) return null;
    const job = await res.json();
    return ["Submitted", "Released", "Refunded"].includes(job.status) ? job : null;
  });

  if (!delivered) {
    onLog("no delivery before the wait ran out — cancelling the escrow", "bad");
    const outcome = await signAndCall({ receiverId: contract, method: "refund", args: { job_id: jobId } });
    const tx = hashOf(outcome);
    onLog("refund signed by your wallet — escrow returned", "good", txUrl(tx));
    return { jobId, action: "refund", tx };
  }
  onLog(`worker delivered · result hash ${String(delivered.resultHash).slice(0, 12)}…`, "dim");

  const judgeRes = await fetch(`/api/market/jobs/${jobId}/verdict`, { method: "POST" });
  const judged = await judgeRes.json();
  const score = judged.verdict?.score ?? "?";
  onLog(
    `judged ${score}/100 · ${judged.verdict?.reasons?.[0] || judged.reason || judged.action}`,
    judged.action === "release" ? "good" : "bad",
  );

  const method = judged.action === "release" ? "release" : "refund";
  const settled = await signAndCall({ receiverId: contract, method, args: { job_id: jobId } });
  const tx = hashOf(settled);
  onLog(
    `${method.toUpperCase()} signed by your wallet`,
    "good",
    txUrl(tx),
  );
  return { jobId, action: judged.action, verdict: judged.verdict, deliverable: judged.deliverable, tx };
}
