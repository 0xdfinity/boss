import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { generateKey, encodeTransaction as serverEncode, signTransaction as serverSign } from "../src/chain/near.js";
import {
  parseSecret,
  encodeTransaction as webEncode,
  signTransaction as webSign,
  bytesToHex,
  b58encode,
  b58decode,
  usdToYocto,
  BrowserNear,
  bytesToB64,
} from "../frontend/near-lite.js";

const SPKI = Buffer.from("302a300506032b6570032100", "hex");

const fixture = () => {
  const key = generateKey();
  return {
    key,
    tx: {
      signerId: "client.testnet",
      publicKey: key.publicKey,
      nonce: 42n,
      receiverId: "market.testnet",
      blockHash: Uint8Array.from({ length: 32 }, (_, i) => i),
      actions: [
        {
          type: "functionCall",
          method: "open_job",
          args: { capability: "writing", spec_hash: "ab".repeat(32), spec_url: "https://x/y", deadline_secs: 900 },
          gas: 30_000_000_000_000n,
          deposit: 5n * 10n ** 22n,
        },
      ],
    },
  };
};

test("browser and server encode the same transaction to the same bytes", () => {
  const { tx } = fixture();
  const server = serverEncode(tx);
  const browser = webEncode(tx);
  assert.equal(bytesToHex(browser), server.toString("hex"));
});

test("browser and server produce the same signature", async () => {
  const { key, tx } = fixture();
  const bytes = webEncode(tx);
  const fromServer = serverSign(bytes, key.secret);
  const fromBrowser = await webSign(bytes, key.secret);
  assert.equal(bytesToHex(fromBrowser), fromServer.toString("hex"));
});

test("that signature verifies against the public key", async () => {
  const { key, tx } = fixture();
  const bytes = webEncode(tx);
  const signed = await webSign(bytes, key.secret);
  const signature = signed.subarray(bytes.length + 1);
  const publicKey = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(key.publicKey)]), format: "der", type: "spki" });
  // NEAR signs sha256(transaction), not the transaction bytes themselves.
  const hash = createHash("sha256").update(bytes).digest();
  assert.equal(verify(null, hash, publicKey, Buffer.from(signature)), true);

  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 1] ^= 0xff;
  const tamperedHash = createHash("sha256").update(tampered).digest();
  assert.equal(verify(null, tamperedHash, publicKey, Buffer.from(signature)), false);
});

test("addFunctionCallKey (the wallet's permission) encodes identically on both sides", async () => {
  const { key } = fixture();
  const tx = {
    signerId: "parent.testnet",
    publicKey: key.publicKey,
    nonce: 3n,
    receiverId: "child.parent.testnet",
    blockHash: Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
    actions: [
      { type: "createAccount" },
      { type: "transfer", deposit: 10n ** 23n },
      {
        type: "addFunctionCallKey",
        publicKey: key.publicKey,
        nonce: 0n,
        receiverId: "market.testnet",
        methodNames: ["open_job", "release", "refund"],
        allowance: null,
      },
    ],
  };
  const server = serverEncode(tx);
  assert.equal(bytesToHex(webEncode(tx)), server.toString("hex"));
});

test("a generated browser key round-trips through its stored secret", () => {
  const key = generateKey(); // node's generator, same PKCS8 shape
  const parsed = parseSecret(key.secretStr);
  assert.equal(bytesToHex(parsed.seed), bytesToHex(key.secret));
  assert.equal(parsed.publicKeyStr, key.publicKeyStr);
});

test("base58 round-trips and rejects a bad character", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) % 256);
  assert.equal(bytesToHex(b58decode(b58encode(bytes))), bytesToHex(bytes));
  assert.throws(() => b58decode("0OIl"), /invalid base58/);
});

test("usdToYocto matches the server formula exactly", () => {
  // 0.5 USD at 10 USD/NEAR = 0.05 NEAR
  assert.equal(usdToYocto(0.5, 10), 5n * 10n ** 22n);
  assert.equal(usdToYocto(0.01, 10), 10n ** 21n);
});

test("the browser decodes a function-call return value", () => {
  const near = new BrowserNear({ accountId: "client.testnet" });
  const payload = JSON.stringify(7);
  const out = { status: { SuccessValue: bytesToB64(new TextEncoder().encode(payload)) } };
  assert.equal(near.successValue(out), 7);
  assert.equal(near.successValue({ status: { SuccessValue: "" } }), null);
});

test("open_job uses the contract's argument names and a positive deposit", async () => {
  const { key } = fixture();
  const near = new BrowserNear({ accountId: "client.testnet", secret: key.secretStr });
  let sent = null;
  near.signAndSend = async (req) => {
    sent = req;
    return { hash: "x" };
  };
  await near.openJob({
    contractId: "market.testnet",
    capability: "writing",
    specHash: "ab".repeat(32),
    specUrl: "https://x/y",
    deadlineSecs: 900,
    deposit: usdToYocto(0.5, 10),
  });
  assert.equal(sent.receiverId, "market.testnet");
  assert.equal(sent.method, "open_job");
  assert.deepEqual(Object.keys(sent.args).sort(), ["capability", "deadline_secs", "spec_hash", "spec_url"]);
  assert.ok(sent.deposit > 0n);
});
