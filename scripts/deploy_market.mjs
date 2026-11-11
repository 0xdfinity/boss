// Deploy the cross-firm market and provision a second, independent firm.
//
//   npm run deploy:market
//
// What this does, in order:
//   1. deploys boss_market to `market.<your-account>.testnet`
//   2. creates a second firm account with its OWN key (the worker side)
//   3. funds it enough to pay gas, and writes its credentials to .env
//
// Never prints a private key. Only the account ids and transaction links.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Near, generateKey, txUrl } from "../src/chain/near.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "contracts", "boss_market", "target", "wasm32-unknown-unknown", "release", "boss_market.wasm");
const RPC = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const ONE_NEAR = 1_000_000_000_000_000_000_000_000n;

function readEnv() {
  const out = {};
  const path = join(root, ".env");
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function setEnv(pairs) {
  const path = join(root, ".env");
  const current = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const out = current.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && pairs[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${pairs[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(pairs)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(path, out.filter((l, i) => l !== "" || i < out.length - 1).join("\n") + "\n");
}

async function retry(fn, tries = 4, waitMs = 1200) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!/EAI_AGAIN|ENOTFOUND|fetch failed|Timeout|socket hang up/i.test(String(e.message))) throw e;
      await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
    }
  }
  throw last;
}

async function accountExists(near, id) {
  try {
    await retry(() => near.viewAccount(id));
    return true;
  } catch {
    return false;
  }
}

async function waitForCode(near, id, tries = 15) {
  for (let i = 0; i < tries; i++) {
    try {
      const code = await near.rpc("query", { request_type: "view_code", finality: "final", account_id: id });
      if (code.code_base64 && code.code_base64.length > 0) return true;
    } catch {
      // not deployed yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Ask the NEAR testnet helper to mint a top-level account with this key. */
async function faucet(topLevelId, publicKey) {
  const res = await retry(() =>
    fetch("https://helper.nearprotocol.com/account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: topLevelId, newAccountPublicKey: publicKey }),
      signal: AbortSignal.timeout(30_000),
    })
  );
  if (!res.ok) throw new Error(`helper ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json().catch(() => ({}));
}

const env = readEnv();
const accountId = process.env.NEAR_ACCOUNT || env.NEAR_ACCOUNT;
const privateKey = process.env.NEAR_PRIVATE_KEY || env.NEAR_PRIVATE_KEY;

if (!accountId || !privateKey) {
  console.error("Set NEAR_ACCOUNT and NEAR_PRIVATE_KEY in .env first (see README).");
  process.exit(1);
}
if (!existsSync(wasmPath)) {
  console.error(`Missing ${wasmPath}\nRun: cargo build --release --target wasm32-unknown-unknown --manifest-path contracts/boss_market/Cargo.toml`);
  process.exit(1);
}

const near = new Near({ rpcUrl: RPC, accountId, privateKey });
const me = await retry(() => near.viewAccount());
console.log(`client firm: ${accountId}`);
console.log(`balance:     ${(Number(me.amount) / 1e24).toFixed(3)} NEAR`);

// 1. market contract
const marketId = process.env.BOSS_MARKET_CONTRACT_ID || env.BOSS_MARKET_CONTRACT_ID || `market.${accountId}`;
let marketCreated = false;

if (!(await accountExists(near, marketId))) {
  const tx = await near.createAccount({
    newAccountId: marketId,
    publicKey: near.key.publicKey,
    initialBalance: 5n * ONE_NEAR, // ~3 NEAR of it is storage stake for the code
  });
  marketCreated = true;
  console.log(`market:      ${marketId} created · ${txUrl(tx.hash, "testnet")}`);
  // The key must be visible at finality before the contract accepts a deploy
  // signed with it.
  for (let i = 0; i < 20 && !(await accountExists(near, marketId)); i++) {
    await new Promise((r) => setTimeout(r, 2000));
  }
} else {
  console.log(`market:      ${marketId} exists`);
}

let deployed = false;
try {
  const code = await retry(() =>
    near.rpc("query", { request_type: "view_code", finality: "final", account_id: marketId })
  );
  deployed = Boolean(code.code_base64 && code.code_base64.length > 0);
} catch {
  deployed = false;
}

if (deployed) {
  console.log(`market:      contract already deployed`);
} else {
  const code = readFileSync(wasmPath);
  // DeployContract is only accepted when the transaction is signed by the
  // contract account itself. The parent holds a full-access key there, so we
  // sign as the market account rather than as the firm.
  const tx = await near.signAndSend({
    signerId: marketId,
    receiverId: marketId,
    actions: [
      { type: "deployContract", code },
      { type: "functionCall", method: "new", args: { arbiter: null }, gas: 30_000_000_000_000n, deposit: 0n },
    ],
  });
  console.log(`market:      deployed ${(code.length / 1024).toFixed(0)} KB · ${txUrl(tx.hash, "testnet")}`);

  const landed = await waitForCode(near, marketId);
  if (!landed) {
    console.error("market:      deploy did not land — check the account balance");
    process.exit(1);
  }
}

// 2. second firm
let workerId = process.env.BOSS_WORKER_ACCOUNT || env.BOSS_WORKER_ACCOUNT || "";
let workerKey = process.env.BOSS_WORKER_KEY || env.BOSS_WORKER_KEY || "";
let workerKind = "existing";

if (!workerId || !workerKey) {
  const key = generateKey();
  workerKey = key.secretStr;
  const candidate = `boss-worker-${Math.floor(Math.random() * 900000 + 100000)}.testnet`;

  try {
    await faucet(candidate, key.publicKeyStr);
    workerId = candidate;
    workerKind = "top-level (faucet)";
  } catch (e) {
    // Falling back to a sub-account still gives the worker its own account and
    // its own key; it just shares the parent's namespace.
    workerId = `worker.${accountId}`;
    workerKind = `sub-account (faucet unavailable: ${String(e.message).slice(0, 60)})`;
    if (!(await accountExists(near, workerId))) {
      const tx = await near.createAccount({
        newAccountId: workerId,
        publicKey: key.publicKey,
        initialBalance: 2n * ONE_NEAR,
      });
      console.log(`worker:      ${workerId} created · ${txUrl(tx.hash, "testnet")}`);
    }
  }
  console.log(`worker:      ${workerId} · ${workerKind}`);
} else {
  console.log(`worker:      ${workerId} (from .env)`);
}

// Give the worker gas money if it has none. The worker never needs a deposit:
// the client escrows, the worker only signs submit().
for (let i = 0; i < 20 && !(await accountExists(near, workerId)); i++) {
  await new Promise((r) => setTimeout(r, 3000));
}
const workerAcct = await retry(() => near.viewAccount(workerId));
if (BigInt(workerAcct.amount) < ONE_NEAR) {
  await near.signAndSend({
    receiverId: workerId,
    actions: [{ type: "transfer", deposit: 2n * ONE_NEAR }],
  });
  console.log(`worker:      funded 2 NEAR for gas`);
}

// 3. probe
const [owner, arbiter, count, released, refunded] = await retry(() => near.callView(marketId, "config", {}));
console.log(`\nmarket config: owner=${owner} arbiter=${arbiter || "none"} jobs=${count} released=${released} refunded=${refunded}`);

setEnv({
  BOSS_MARKET_CONTRACT_ID: marketId,
  BOSS_WORKER_ACCOUNT: workerId,
  BOSS_WORKER_KEY: workerKey,
  BOSS_WORKER_PORT: env.BOSS_WORKER_PORT || "8795",
});

console.log("\n.env updated: market contract, worker account, worker key.");
console.log("Key written to .env only. It is gitignored — never commit it.");
console.log("\nNext:  npm run market:demo");
