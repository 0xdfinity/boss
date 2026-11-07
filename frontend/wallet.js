// A wallet that never leaves the browser.
//
// Connect = generate an ed25519 key in this tab, ask the wallet to add it as a
// *function-call* key scoped to the market contract (open_job, release,
// refund), and keep the secret in localStorage. The server sees only signed
// transactions, so it cannot move a client's escrow even if it wanted to.
//
// Two legs, because NEAR forbids deposits on function-call keys:
//   - open_job escrows NEAR, so the wallet itself signs it via /sign (popup).
//   - release / refund move no money, so the scoped key signs them in this tab.
//
// Both protocols are the ones the official wallet-selector uses for
// MyNearWallet: /login/ with contract_id + public_key, then a postMessage with
// `account_id`; /sign with base64 borsh transactions and a random placeholder
// key (the wallet rebuilds them with its own key and nonce), then a
// postMessage with `transactionHashes`.
import { BrowserNear, generateKey, usdToYocto, formatNear, txUrl, encodeTransaction, bytesToB64 } from "./near-lite.js";

export const WALLET_URL = "https://testnet.mynearwallet.com";
export const METHODS = ["open_job", "release", "refund"];
const STORE = "boss.wallet.v1";
const DEMO_USD = 0.5;

export function loadWallet() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || "null");
    if (!raw?.accountId || !raw?.secretStr) return null;
    return raw;
  } catch {
    return null;
  }
}

function saveWallet(wallet) {
  localStorage.setItem(STORE, JSON.stringify(wallet));
}

export function disconnect() {
  localStorage.removeItem(STORE);
}

/**
 * If the wallet app lands the popup back on this page instead of messaging the
 * opener, forward what it put in the URL and close. Only public results travel:
 * an account id and a transaction hash. Authority stays with the on-chain key,
 * which is checked next.
 */
export function bridgePopup() {
  if (!window.opener) return false;
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(String(window.location.hash || "").replace(/^#\/?/, ""));
  const get = (key) => search.get(key) || hash.get(key) || "";
  // The sign callback also accepts a comma-separated list.
  const transactionHashes = decodeURIComponent(get("transactionHashes").replace(/\+/g, " "));
  const accountId = get("account_id");
  const errorMessage = get("errorMessage") || get("error");
  if (!accountId && !transactionHashes && !errorMessage) return false;
  const message = errorMessage
    ? { status: "failure", errorMessage }
    : { status: "success", account_id: accountId, public_key: get("public_key"), transactionHashes };
  try {
    window.opener.postMessage(message, window.location.origin);
  } catch {
    /* the opener went away */
  }
  window.close();
  return true;
}

async function verifyKey(near, publicKeyStr, attempts = 12) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const key = await near.viewAccessKey(publicKeyStr);
      if (key?.permission) return key;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `the wallet has not confirmed the key on chain yet${lastError ? ` (${String(lastError.message || lastError).slice(0, 90)})` : ""}. Try connect again in a few seconds.`
  );
}

/**
 * Open the wallet in a popup and wait for it to talk back. Resolves with
 * `pick(data)` once a success message arrives.
 */
function popup(url, pick, { name = "boss-wallet", width = 480, height = 720 } = {}) {
  const left = Math.max(0, (window.screen.width - width) / 2);
  const top = Math.max(0, (window.screen.height - height) / 2);
  const win = window.open(url.toString(), name, `width=${width},height=${height},left=${left},top=${top}`);
  if (!win) throw new Error("the wallet popup was blocked. Allow popups for this site and try again.");

  return new Promise((resolve, reject) => {
    const walletOrigin = new URL(WALLET_URL).origin;
    let settled = false;
    let closedTimer = null;
    const timer = setInterval(() => {
      if (!win.closed) return;
      clearInterval(timer);
      // The wallet can post and close in the same tick. Give the message a
      // moment to land before calling it a cancel.
      closedTimer = setTimeout(() => finish(new Error("the wallet window was closed before approving")), 700);
    }, 800);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(closedTimer);
      window.removeEventListener("message", onMessage);
      try {
        win.close();
      } catch {
        /* already closed */
      }
      if (error) reject(error);
      else resolve(value);
    }

    function onMessage(event) {
      // The wallet's origin covers its direct postMessage; our own origin covers
      // the redirect-back bridge.
      if (event.origin !== walletOrigin && event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.status === "failure") return finish(new Error(data.errorMessage || "the wallet rejected the request"));
      if (data.status !== "success") return;
      const value = pick(data);
      if (value === null || value === undefined || value === "") {
        return finish(new Error(data.errorMessage || "the wallet approved but returned nothing"));
      }
      finish(null, value);
    }

    window.addEventListener("message", onMessage);
  });
}

/** Popup + postMessage. Resolves once the account id is known. */
function openLogin(key, contractId) {
  const url = new URL(`${WALLET_URL}/login/`);
  const back = `${window.location.origin}${window.location.pathname}`;
  url.searchParams.set("success_url", back);
  url.searchParams.set("failure_url", back);
  url.searchParams.set("contract_id", contractId);
  url.searchParams.set("public_key", key.publicKeyStr);
  for (const method of METHODS) url.searchParams.append("methodNames", method);

  return popup(url, (data) => String(data.account_id || ""), { name: "boss-wallet-login" });
}

/**
 * Connect a testnet wallet as this browser's client identity.
 * Returns { accountId, publicKeyStr, secretStr, contractId, balance }.
 */
export async function connect(contractId) {
  if (!contractId) throw new Error("the market is not configured on this server");
  if (!window.isSecureContext) throw new Error("wallet signing needs https (or localhost)");

  const key = await generateKey();
  const accountId = await openLogin(key, contractId);

  const near = new BrowserNear({ accountId, secret: key.secretStr });
  await verifyKey(near, key.publicKeyStr);
  const balance = await near.balance(accountId);

  const wallet = {
    accountId,
    publicKeyStr: key.publicKeyStr,
    secretStr: key.secretStr,
    contractId,
    connectedAt: new Date().toISOString(),
  };
  saveWallet(wallet);
  return { ...wallet, balance, near };
}

/** Rebuild the signer from storage and confirm the key is still on chain. */
export async function resume(wallet = loadWallet()) {
  if (!wallet) return null;
  const near = new BrowserNear({ accountId: wallet.accountId, secret: wallet.secretStr });
  try {
    await near.viewAccessKey(wallet.publicKeyStr);
  } catch {
    disconnect();
    return null;
  }
  return { ...wallet, near };
}

const CALL_GAS = 30_000_000_000_000n;

function txFailure(status) {
  const failure = status?.Failure;
  if (!failure) return String(status);
  const text = typeof failure === "string" ? failure : JSON.stringify(failure);
  return text.slice(0, 240);
}

/** Wait for a transaction the wallet sent to reach the chain. */
async function waitForTx(near, hash) {
  let last;
  for (let i = 0; i < 60; i++) {
    try {
      const out = await near.rpc("tx", {
        tx_hash: hash,
        sender_account_id: near.accountId,
        wait_until: "EXECUTED_OPTIMISTIC",
      });
      if (out) {
        if (out.status?.Failure) throw new Error(`the transaction failed on chain: ${txFailure(out.status)}`);
        return out;
      }
    } catch (e) {
      // "Unknown transaction" just means it is not in a block yet.
      if (!/unknown transaction|does not exist|not found|UNKNOWN_TX/i.test(String(e.message || e))) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`the wallet sent ${hash.slice(0, 10)}… but it has not landed yet${last ? ` (${last.message})` : ""}`);
}

/**
 * Sign a single function call with the wallet itself, through the /sign popup.
 * Required for `open_job`, because a function-call access key may not attach a
 * deposit. The transaction is built with a throwaway public key and nonce 0,
 * exactly like wallet-selector: the wallet replaces both with its own.
 */
export async function signWithWallet(near, { contractId, method, args = {}, deposit = 0n }) {
  if (!window.isSecureContext) throw new Error("wallet signing needs https (or localhost)");
  const blockHash = await near.blockHash();
  const placeholder = await generateKey();
  const tx = encodeTransaction({
    signerId: near.accountId,
    publicKey: placeholder.publicKey,
    nonce: 0n,
    receiverId: contractId,
    blockHash,
    actions: [{ type: "functionCall", method, args, gas: CALL_GAS, deposit }],
  });

  const url = new URL(`${WALLET_URL}/sign`);
  url.searchParams.set("transactions", bytesToB64(tx));
  url.searchParams.set("callbackUrl", `${window.location.origin}${window.location.pathname}`);

  const hashes = await popup(url, (data) => data.transactionHashes, { name: "boss-wallet-sign" });
  const hash = String(hashes).split(",")[0];
  if (!hash) throw new Error("the wallet approved but returned no transaction hash");

  const out = await waitForTx(near, hash);
  return { hash, status: out.status, successValue: near.successValue(out), result: out };
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `server ${res.status}`);
  return data;
}

async function poll(fn, { timeoutMs = 210_000, everyMs = 3000 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return null;
}

/**
 * The full client side of a job, signed by the browser:
 *   publish spec -> open_job + escrow (wallet) -> wait -> judge (server)
 *   -> release/refund (scoped key in this tab).
 * `onLog(line, kind, href)` streams progress to the UI.
 */
export async function runAsClient({ wallet, brief, capability = "writing", acceptance = [], onLog = () => {}, rate = 10 }) {
  const near = wallet.near || new BrowserNear({ accountId: wallet.accountId, secret: wallet.secretStr });
  const contract = wallet.contractId;

  const spec = await api("/api/market/spec", {
    brief,
    capability,
    acceptance,
    client: wallet.accountId,
  });
  onLog(`spec ${spec.hash.slice(0, 12)}… published (${brief.length} chars)`, "dim");

  const before = Number(await near.callView(contract, "job_count", {}).catch(() => 0));
  const deposit = usdToYocto(DEMO_USD, rate);
  onLog("confirm the escrow in your wallet", "dim");
  const opened = await signWithWallet(near, {
    contractId: contract,
    method: "open_job",
    args: {
      capability: String(capability),
      spec_hash: String(spec.hash),
      spec_url: String(spec.specUrl),
      deadline_secs: 900,
    },
    deposit,
  });
  onLog(`open_job signed by your wallet · escrow ${formatNear(deposit)} NEAR`, "dim", txUrl(opened.hash));

  let jobId = opened.successValue;
  if (!Number.isInteger(jobId)) {
    jobId = null;
    for (let i = 0; i < 20 && jobId === null; i++) {
      const count = Number(await near.callView(contract, "job_count", {}));
      if (count > before) jobId = count - 1;
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (jobId === null) throw new Error("the job opened but its id could not be read back");

  onLog(`job ${jobId} open · client ${wallet.accountId}`, "dim");

  const delivered = await poll(async () => {
    const res = await fetch(`/api/market/jobs/${jobId}`);
    if (!res.ok) return null;
    const job = await res.json();
    return ["Submitted", "Released", "Refunded"].includes(job.status) ? job : null;
  });

  if (!delivered) {
    onLog("no delivery before the wait ran out — cancelling the escrow", "bad");
    const refund = await near.refund({ contractId: contract, jobId });
    onLog(`refund signed by your scoped key · ${formatNear(deposit)} NEAR returned`, "good", txUrl(refund.hash));
    return { jobId, action: "refund", tx: refund.hash, url: txUrl(refund.hash) };
  }
  onLog(`worker delivered · result hash ${String(delivered.resultHash).slice(0, 12)}…`, "dim");

  const judged = await api(`/api/market/jobs/${jobId}/verdict`);
  const score = judged.verdict?.score ?? "?";
  onLog(`judged ${score}/100 · ${judged.verdict?.reasons?.[0] || judged.reason || judged.action}`, judged.action === "release" ? "good" : "bad");

  const settled =
    judged.action === "release"
      ? await near.release({ contractId: contract, jobId })
      : await near.refund({ contractId: contract, jobId });

  onLog(
    `${judged.action.toUpperCase()} signed by your scoped key · ${formatNear(deposit)} NEAR ${
      judged.action === "release" ? "to " + (delivered.worker || "the worker") : "back to you"
    }`,
    judged.action === "release" ? "good" : "good",
    txUrl(settled.hash)
  );

  return { jobId, action: judged.action, verdict: judged.verdict, deliverable: judged.deliverable, tx: settled.hash, url: txUrl(settled.hash) };
}
