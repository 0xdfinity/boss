// npm run sweep — move surplus NEAR from the second firm back to the client.
//
// Every demo job that releases pays 0.05 NEAR out of the client account and into
// the worker's. After a busy day the client can run dry while the worker holds
// the operator's own money, so this puts it back where it is needed.
//
// The worker keeps a reserve for its own transaction fees and storage. Nothing
// is signed without `-yes`: the default run only prints the plan.
//
// No process.exit() here. On Windows, exiting while the RPC socket is closing
// trips a libuv assertion and aborts with a status that looks like a crash, so
// every path returns and lets the process end on its own.

import { env } from "../src/config/env.js";
import { Near, txUrl } from "../src/chain/near.js";

const ONE_NEAR = 10n ** 24n;
const RESERVE = 1_000_000_000_000_000_000_000_000n; // 1 NEAR stays with the worker
const MIN_MOVE = 200_000_000_000_000_000_000_000n; // below 0.2 NEAR, not worth a tx

const near = (yocto) => (Number(yocto) / 1e24).toFixed(4);

async function main() {
  if (!env.workerAccount || !env.workerKey) {
    console.error("Set BOSS_WORKER_ACCOUNT and BOSS_WORKER_KEY in .env.");
    process.exitCode = 1;
    return;
  }
  if (!env.nearAccount) {
    console.error("Set NEAR_ACCOUNT in .env (the destination).");
    process.exitCode = 1;
    return;
  }

  const worker = new Near({ rpcUrl: env.nearRpcUrl, accountId: env.workerAccount, privateKey: env.workerKey });

  const before = await worker.rpc("query", {
    request_type: "view_account",
    finality: "final",
    account_id: env.workerAccount,
  });
  const locked = BigInt(before.locked || 0);
  const available = BigInt(before.amount) - locked;
  const move = available - RESERVE;

  console.log(`from:    ${env.workerAccount}`);
  console.log(`to:      ${env.nearAccount}`);
  console.log(`balance: ${near(available)} NEAR available (locked ${near(locked)})`);
  console.log(`reserve: ${near(RESERVE)} NEAR stays with the worker`);

  if (move < MIN_MOVE) {
    console.log(`\nnothing to move: ${near(move > 0n ? move : 0n)} NEAR is under the ${near(MIN_MOVE)} minimum.`);
    return;
  }

  console.log(`\nplan:    transfer ${near(move)} NEAR`);

  if (!process.argv.includes("-yes")) {
    console.log("\nnot sent. re-run with -yes to sign it.");
    return;
  }

  const tx = await worker.signAndSend({
    receiverId: env.nearAccount,
    actions: [{ type: "transfer", deposit: move }],
  });
  console.log(`\nsent:    ${txUrl(tx.hash, env.nearNetwork)}`);

  const after = await worker
    .rpc("query", { request_type: "view_account", finality: "optimistic", account_id: env.workerAccount })
    .catch(() => null);
  if (after) console.log(`worker:  ${near(BigInt(after.amount))} NEAR`);
}

await main();
