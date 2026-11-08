// Tiny loader for BOSS/.env and BOSS/.env.local (no dependency, no dotenv needed).
// Shell variables win, then .env, then .env.local, so a local override does not
// require editing the committed example. Keys stay server-side only.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const name of [".env", ".env.local"]) {
  const path = join(root, name);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export const env = {
  nearAiKey: process.env.NEAR_AI_API_KEY || "",
  nearAiBaseUrl: process.env.NEAR_AI_BASE_URL || "https://cloud-api.near.ai",
  nearAiModel: process.env.NEAR_AI_MODEL || "",
  groqKey: process.env.GROQ_API_KEY || "",
  groqBaseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  nearAccount: process.env.NEAR_ACCOUNT || "",
  nearPrivateKey: process.env.NEAR_PRIVATE_KEY || "",
  nearRpcUrl: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com",
  nearNetwork:
    process.env.NEAR_NETWORK ||
    ((process.env.NEAR_RPC_URL || "").includes("mainnet") ? "mainnet" : "testnet"),
  siteUrl: (process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || "http://127.0.0.1:8787").replace(/\/+$/, ""),
  treasuryContractId: process.env.BOSS_TREASURY_CONTRACT_ID || "",
  marketContractId: process.env.BOSS_MARKET_CONTRACT_ID || "",
  workerAccount: process.env.BOSS_WORKER_ACCOUNT || "",
  workerKey: process.env.BOSS_WORKER_KEY || "",
  workerPort: Number(process.env.BOSS_WORKER_PORT || process.env.PORT || 8795),
  workerUrl:
    process.env.BOSS_WORKER_URL ||
    `http://127.0.0.1:${Number(process.env.BOSS_WORKER_PORT || process.env.PORT || 8795)}`,
  nearUsdRate: Number(process.env.NEAR_USD_RATE || 10),
  port: Number(process.env.PORT || 8787),
  // Loopback by default. A container or PaaS must bind 0.0.0.0 to receive traffic.
  bind: process.env.BOSS_BIND || "127.0.0.1",
};
