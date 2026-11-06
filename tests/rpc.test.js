// The RPC failover. near.org's public testnet endpoint started answering some
// requests with "THIS ENDPOINT IS DEPRECATED!" instead of a result, which broke
// the worker's poll loop. The client is allowed to move to a working endpoint
// once, and must not go back to paying that tax on every call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Near } from "../src/chain/near.js";

function serve(handler) {
  return new Promise((resolve) => {
    const hits = { count: 0 };
    const server = createServer((req, res) => {
      hits.count += 1;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const payload = handler(JSON.parse(body || "{}"), hits.count);
        res.writeHead(payload.http || 200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload.json));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const viewResult = (value) => ({
  json: { jsonrpc: "2.0", id: "boss", result: { result: [...Buffer.from(JSON.stringify(value))] } },
});

test("a retired endpoint is abandoned once, not on every call", async () => {
  const dead = await serve(() => ({
    json: {
      jsonrpc: "2.0",
      id: "boss",
      error: { message: "WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW!" },
    },
  }));
  const live = await serve(() => viewResult(["market.testnet", null, 4, 2, 2]));

  const near = new Near({ rpcUrl: dead.url, fallbackRpcUrl: live.url, accountId: "market.testnet" });

  const first = await near.callView("market.testnet", "config", {});
  assert.deepEqual(first, ["market.testnet", null, 4, 2, 2]);
  assert.equal(dead.hits.count, 1);
  assert.equal(live.hits.count, 1);

  const second = await near.callView("market.testnet", "config", {});
  assert.deepEqual(second, ["market.testnet", null, 4, 2, 2]);
  assert.equal(dead.hits.count, 1, "the dead endpoint must not be tried again");
  assert.equal(live.hits.count, 2);

  dead.server.close();
  live.server.close();
});

test("an honest error from a healthy endpoint is not hidden by a fallback", async () => {
  const live = await serve(() => viewResult(["ok"]));
  const contractError = await serve(() => ({
    json: {
      jsonrpc: "2.0",
      id: "boss",
      error: { cause: { name: "UNKNOWN_ACCOUNT" }, data: "account does not exist" },
    },
  }));

  const near = new Near({
    rpcUrl: contractError.url,
    fallbackRpcUrl: live.url,
    accountId: "missing.testnet",
  });

  await assert.rejects(() => near.callView("missing.testnet", "config", {}), /UNKNOWN_ACCOUNT/);
  assert.equal(live.hits.count, 0, "a normal RPC error must reach the caller");

  contractError.server.close();
  live.server.close();
});
