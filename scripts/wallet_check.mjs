// npm run wallet:check — prove the browser's signing path on the real chain.
//
// A throwaway testnet account gets the two keys a real client ends up with:
//   - a full-access key standing in for the wallet itself (it signs the escrow),
//   - a function-call key scoped to the market (it settles without a deposit).
// Then the whole client side runs through frontend/near-lite.js: open_job with
// an escrow, wait for the worker, judge, release or refund. The server never
// signs anything.
//
// The script also asserts the chain rule the UI is built around: the scoped key
// is refused when the call carries a deposit.
//
// The popup itself (/login, /sign) is a browser flow this script cannot drive;
// what it proves is that the transactions the page builds are accepted.

import { env } from "../src/config/env.js";
import { Near, generateKey, txUrl } from "../src/chain/near.js";
import { BrowserNear, formatNear, usdToYocto } from "../frontend/near-lite.js";

const site = (env.siteUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
const METHODS = ["open_job", "release", "refund"];
const CALL_GAS = 30_000_000_000_000n;

const log = (line = "") => console.log(line);
const die = (message) => {
  console.error(message);
  process.exit(1);
};

if (!env.nearAccount || !env.nearPrivateKey) {
  die("Set NEAR_ACCOUNT and NEAR_PRIVATE_KEY in .env (a funded testnet account).");
}
if (!env.marketContractId) {
  die("Set BOSS_MARKET_CONTRACT_ID in .env (npm run deploy:market writes it).");
}

const parent = new Near({ rpcUrl: env.nearRpcUrl, accountId: env.nearAccount, privateKey: env.nearPrivateKey });

const serverUp = await fetch(`${site}/health`).then((r) => r.ok).catch(() => false);
if (!serverUp) die(`The server is not answering at ${site}. Start it with: npm start`);

const walletKey = generateKey();
const clientKey = generateKey();
const accountId = `wc-${Date.now().toString(36)}.${env.nearAccount}`;

log(`parent:  ${env.nearAccount}`);
log(`client:  ${accountId}   (throwaway: wallet key + scoped key)`);
log(`market:  ${env.marketContractId}`);

// ---- 1. create the client with both keys in one transaction ---------------
const created = await parent.createAccount({
  newAccountId: accountId,
  publicKey: walletKey.publicKey, // stands in for the wallet's own key
  initialBalance: 250_000_000_000_000_000_000_000n, // 0.25 NEAR: escrow + storage, not a float
  extraKeys: [
    {
      publicKey: clientKey.publicKey,
      functionCall: { receiverId: env.marketContractId, methodNames: METHODS, allowance: null },
    },
  ],
});
log(`created ${txUrl(created.hash, env.nearNetwork)}`);

const wallet = new BrowserNear({ rpcUrl: env.nearRpcUrl, accountId, secret: walletKey.secretStr });
const browser = new BrowserNear({ rpcUrl: env.nearRpcUrl, accountId, secret: clientKey.secretStr });

// The AddKey receipts can land a block after the create transaction reports
// success, so give each key a moment to appear before calling it missing.
async function waitForKey(signer, attempts = 20) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const info = await signer.viewAccessKey();
      if (info?.permission) return info;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  die(`the key never appeared on chain: ${lastError?.message || "unknown"}`);
}

const walletInfo = await waitForKey(wallet);
const clientInfo = await waitForKey(browser);

const permission = clientInfo.permission;
const scoped = permission && typeof permission === "object" ? permission.FunctionCall || permission : null;
log(`wallet key:  ${typeof walletInfo.permission === "string" ? walletInfo.permission : "FunctionCall"}`);
log(`client key:  ${typeof permission === "string" ? permission : `FunctionCall -> ${scoped?.receiver_id}`}`);
if (typeof permission === "string" || !scoped || scoped.receiver_id !== env.marketContractId) {
  log(`  raw: ${JSON.stringify(clientInfo).slice(0, 400)}`);
  die("that is not a function-call key; aborting.");
}
log(`allowed:     ${(scoped.method_names || []).join(", ")}`);
log(`balance:     ${formatNear(await browser.balance())} NEAR`);
log();

// ---- 2. the rule the UI is built around: function-call keys cannot escrow --
const probeArgs = {
  capability: "writing",
  spec_hash: "00".repeat(32),
  spec_url: `${site}/api/market/specs/00`,
  deadline_secs: 900,
};
let refused = false;
let refusal = "";
try {
  await browser.signAndSend({
    receiverId: env.marketContractId,
    method: "open_job",
    args: probeArgs,
    gas: CALL_GAS,
    deposit: usdToYocto(0.5, env.nearUsdRate),
  });
} catch (e) {
  refusal = String(e.message || e);
  refused = /deposit/i.test(refusal);
}
if (!refused) die(`the scoped key attached a deposit — that should be impossible (${refusal || "no error"})`);
log("refused:     the scoped key cannot attach a deposit (expected)");
log();

// ---- 3. publish the spec (server stores prose; chain keeps the hash) -------
const brief =
  "Write exactly 5 numbered taglines for a coffee subscription that ships a new single-origin roast every month. " +
  "Then name the strongest one and give a one-sentence reason. Keep it under 120 words.";
const specRes = await fetch(`${site}/api/market/spec`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    brief,
    capability: "writing",
    acceptance: ["exactly 5 numbered taglines", "one named strongest pick with a one-sentence reason", "under 120 words"],
    client: accountId,
  }),
});
const spec = await specRes.json();
if (!specRes.ok) die(`spec: ${spec.error || specRes.status}`);
log(`spec:    ${spec.hash.slice(0, 16)}…  ${spec.specUrl}`);

// ---- 4. open_job with the wallet key (this is the tx the popup would sign) -
const before = Number(await browser.callView(env.marketContractId, "job_count", {}).catch(() => 0));
const deposit = usdToYocto(0.5, env.nearUsdRate);
const opened = await wallet.openJob({
  contractId: env.marketContractId,
  capability: "writing",
  specHash: spec.hash,
  specUrl: spec.specUrl,
  deadlineSecs: 900,
  deposit,
});
log(`open_job ${txUrl(opened.hash, env.nearNetwork)}  · escrow ${formatNear(deposit)} NEAR`);

let jobId = opened.successValue;
if (!Number.isInteger(jobId)) {
  jobId = null;
  for (let i = 0; i < 20 && jobId === null; i++) {
    const count = Number(await browser.callView(env.marketContractId, "job_count", {}));
    if (count > before) jobId = count - 1;
    else await new Promise((r) => setTimeout(r, 500));
  }
}
if (jobId === null) die("job opened but the id could not be read back");
log(`job id:  ${jobId}`);
log();

// ---- 5. wait for the second firm, judge, then settle with the scoped key ---
const started = Date.now();
let job = null;
while (Date.now() - started < 240_000) {
  const res = await fetch(`${site}/api/market/jobs/${jobId}`);
  if (res.ok) {
    job = await res.json();
    if (["Submitted", "Released", "Refunded"].includes(job.status)) break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!job || job.status !== "Submitted") {
  log(`no delivery (status ${job?.status || "unknown"}). Refunding with the scoped key…`);
  const refund = await browser.refund({ contractId: env.marketContractId, jobId });
  log(`refund   ${txUrl(refund.hash, env.nearNetwork)}`);
  process.exit(0);
}

log(`delivered: ${String(job.resultHash).slice(0, 16)}…  ${job.resultUrl}`);
const judged = await fetch(`${site}/api/market/jobs/${jobId}/verdict`, { method: "POST" }).then((r) => r.json());
log(`verdict:   ${judged.action} · ${judged.verdict?.score ?? "?"}/100 · ${judged.verdict?.reasons?.[0] || judged.reason || ""}`);

const settled =
  judged.action === "release"
    ? await browser.release({ contractId: env.marketContractId, jobId })
    : await browser.refund({ contractId: env.marketContractId, jobId });

log(`settled:   ${txUrl(settled.hash, env.nearNetwork)}`);
log(`balance:   ${formatNear(await browser.balance())} NEAR`);
log();
log("the wallet key opened the escrow, the scoped key settled it. The server never had either.");
