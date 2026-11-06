// Deploy the BOSS treasury to testnet and create the worker account.
//
//   node scripts/deploy_testnet.mjs
//
// Reads the key from .env (NEAR_ACCOUNT / NEAR_PRIVATE_KEY), so nothing secret
// is ever printed. Writes the contract id back into .env when the deploy lands.
//
// The treasury's caps live in the contract; this script only puts it there.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Near, txUrl, parseKey } from "../src/chain/near.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "contracts", "boss_treasury", "target", "wasm32-unknown-unknown", "release", "boss_treasury.wasm");

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

const env = readEnv();
const accountId = process.env.NEAR_ACCOUNT || env.NEAR_ACCOUNT;
const privateKey = process.env.NEAR_PRIVATE_KEY || env.NEAR_PRIVATE_KEY;
const rpcUrl = process.env.NEAR_RPC_URL || env.NEAR_RPC_URL || "https://rpc.testnet.near.org";

if (!accountId || !privateKey) {
  console.error("Set NEAR_ACCOUNT and NEAR_PRIVATE_KEY in .env first.");
  process.exit(1);
}
if (!existsSync(wasmPath)) {
  console.error(`Missing ${wasmPath}\nRun: cd contracts/boss_treasury && cargo build --release --target wasm32-unknown-unknown`);
  process.exit(1);
}

const near = new Near({ rpcUrl, accountId, privateKey });
const key = parseKey(privateKey);
const workerId = `verity.${accountId}`;

console.log(`deployer: ${accountId}`);
console.log(`rpc:      ${rpcUrl}`);

const acct = await near.viewAccount();
console.log(`balance:  ${Number(acct.amount) / 1e24} NEAR`);

// 1. Worker account (receives real NEAR when it wins a stage).
try {
  await near.viewAccount(workerId);
  console.log(`worker:   ${workerId} already exists`);
} catch {
  const tx = await near.createAccount({
    newAccountId: workerId,
    publicKey: key.publicKey,
    initialBalance: 1_000_000_000_000_000_000_000_000n, // 1 NEAR
  });
  console.log(`worker:   ${workerId} created · ${txUrl(tx.hash, "testnet")}`);
}

// 2. Contract, only once.
let deployed = false;
try {
  const code = await near.rpc("query", {
    request_type: "view_code",
    finality: "final",
    account_id: accountId,
  });
  deployed = code.code_base64 && code.code_base64.length > 0;
} catch {
  deployed = false;
}

if (deployed) {
  console.log(`contract: already deployed at ${accountId}`);
} else {
  const code = readFileSync(wasmPath);
  const tx = await near.deployAndInit({
    contractId: accountId,
    code,
    method: "new",
    args: { total_budget: "20000000" },
  });
  console.log(`contract: deployed ${(code.length / 1024).toFixed(0)} KB · ${txUrl(tx.hash, "testnet")}`);
}

// 3. Probe: the caps must be readable from the chain.
const remaining = await near.callView(accountId, "remaining_budget", {});
console.log(`remaining_budget: ${remaining} micro-USD`);

setEnv({
  NEAR_ACCOUNT: accountId,
  NEAR_RPC_URL: rpcUrl,
  NEAR_NETWORK: "testnet",
  BOSS_TREASURY_CONTRACT_ID: accountId,
  NEAR_USD_RATE: env.NEAR_USD_RATE || "10",
});
console.log("\n.env updated (contract id, network). Secret key left untouched.");
console.log(`worker account for outside agents: ${workerId}`);
