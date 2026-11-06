// Run the second firm: an independent worker with its own account and key.
//
//   npm run worker
//
// It polls boss_market for open jobs, delivers, and submits the result hash on
// chain. Nothing here needs the client's key or the client's server.

import { FirmWorker } from "../src/firm/worker.js";
import { env } from "../src/config/env.js";

const worker = new FirmWorker({
  capabilities: (process.env.BOSS_WORKER_CAPABILITIES || "writing,rewrite,critique,plan,research")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  tools: (process.env.BOSS_WORKER_TOOLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

if (!worker.live) {
  console.error("Worker is not configured.");
  console.error("Set BOSS_WORKER_ACCOUNT, BOSS_WORKER_KEY and BOSS_MARKET_CONTRACT_ID in .env");
  console.error("or run: npm run deploy:market");
  process.exit(1);
}

console.log(`BOSS worker firm`);
console.log(`  account: ${worker.account}`);
console.log(`  market:  ${worker.contractId} (${worker.market.network})`);
console.log(`  tools:   ${worker.tools.join(", ") || "none (declines specs that require tools)"}`);
worker.start();

process.on("SIGINT", () => {
  worker.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  worker.stop();
  process.exit(0);
});
