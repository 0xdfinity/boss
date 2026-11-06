// Minimal NEAR client — zero dependencies.
// Borsh-encodes transactions, signs them with node:crypto ed25519, and talks to
// any NEAR JSON-RPC (testnet, mainnet, or a local sandbox).
//
// Why hand-rolled: the product must run with `node src/server/index.js` and no
// install step. The surface here is deliberately small: view, call, deploy,
// create account, transfer.

import { createPrivateKey, createPublicKey, sign as edSign, createHash } from "node:crypto";

// ---------------------------------------------------------------- base58
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes) {
  const buf = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function b58decode(str) {
  const map = new Map([...ALPHABET].map((c, i) => [c, i]));
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes = [];
  for (let i = zeros; i < str.length; i++) {
    let carry = map.get(str[i]);
    if (carry === undefined) throw new Error(`invalid base58 char: ${str[i]}`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes.reverse())]);
}

// ---------------------------------------------------------------- keys
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

export function parseKey(input) {
  const raw = String(input || "").replace(/^ed25519:/, "");
  if (!raw) throw new Error("empty key");
  const bytes = b58decode(raw);
  const secret = bytes.length === 64 ? bytes.subarray(0, 32) : bytes;
  if (secret.length !== 32) throw new Error("ed25519 secret key must be 32 or 64 bytes");
  const pub = bytes.length === 64 ? bytes.subarray(32, 64) : publicFromSecret(secret);
  return { secret, publicKey: pub, publicKeyStr: `ed25519:${b58encode(pub)}` };
}

function publicFromSecret(seed) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  return spki.subarray(-32);
}

export function signBytes(seed, message) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  return edSign(null, message, key);
}

// ---------------------------------------------------------------- borsh
class Writer {
  constructor() {
    this.parts = [];
  }
  u8(n) {
    this.parts.push(Buffer.from([n & 0xff]));
  }
  u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    this.parts.push(b);
  }
  u64(n) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    this.parts.push(b);
  }
  u128(n) {
    let v = BigInt(n);
    const b = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.parts.push(b);
  }
  bytes(buf) {
    this.u32(buf.length);
    this.parts.push(Buffer.from(buf));
  }
  fixed(buf) {
    this.parts.push(Buffer.from(buf));
  }
  string(s) {
    this.bytes(Buffer.from(String(s), "utf8"));
  }
  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

const borshString = (w, s) => w.string(s);

function publicKeyBytes(w, pub) {
  w.u8(0); // ED25519
  w.fixed(pub);
}

function functionCall(w, method, args, gas, deposit) {
  w.u8(2);
  borshString(w, method);
  w.bytes(Buffer.from(JSON.stringify(args ?? {}), "utf8"));
  w.u64(gas);
  w.u128(deposit);
}

function transfer(w, deposit) {
  w.u8(3);
  w.u128(deposit);
}

function createAccountAction(w) {
  w.u8(0);
}

function deployContract(w, code) {
  w.u8(1);
  w.bytes(code);
}

function addFullAccessKey(w, pub, nonce) {
  w.u8(5);
  publicKeyBytes(w, pub);
  w.u64(nonce);
  w.u8(1); // AccessKeyPermission::FullAccess (FunctionCall is 0)
}

export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const w = new Writer();
  borshString(w, signerId);
  publicKeyBytes(w, publicKey);
  w.u64(nonce);
  borshString(w, receiverId);
  w.fixed(blockHash);
  w.u32(actions.length);
  for (const a of actions) {
    switch (a.type) {
      case "functionCall":
        functionCall(w, a.method, a.args, a.gas ?? 30_000_000_000_000n, a.deposit ?? 0n);
        break;
      case "transfer":
        transfer(w, a.deposit ?? 0n);
        break;
      case "createAccount":
        createAccountAction(w);
        break;
      case "deployContract":
        deployContract(w, a.code);
        break;
      case "addFullAccessKey":
        addFullAccessKey(w, a.publicKey, a.nonce ?? 0n);
        break;
      default:
        throw new Error(`unknown action ${a.type}`);
    }
  }
  return w.toBuffer();
}

export function signTransaction(txBytes, seed) {
  const hash = createHash("sha256").update(txBytes).digest();
  const sig = signBytes(seed, hash);
  const w = new Writer();
  w.u8(0);
  w.fixed(sig);
  return Buffer.concat([txBytes, w.toBuffer()]);
}

// ---------------------------------------------------------------- rpc
export class Near {
  constructor({ rpcUrl, accountId, privateKey }) {
    this.rpcUrl = rpcUrl || "https://rpc.testnet.near.org";
    this.accountId = accountId || "";
    this.key = privateKey ? parseKey(privateKey) : null;
    // One access key means one nonce: serialize sends so two agents cannot
    // read the same nonce and race each other into INVALID_TRANSACTION.
    this._chain = Promise.resolve();
  }

  get configured() {
    return Boolean(this.rpcUrl && this.accountId && this.key);
  }

  async rpc(method, params) {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "boss", method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    if (body.error) {
      const msg = body.error?.cause?.name || body.error?.message || "rpc error";
      const raw = body.error?.data ?? body.error?.cause?.info ?? "";
      const data = typeof raw === "string" ? raw : JSON.stringify(raw);
      throw new Error(`${method}: ${msg} ${data.slice(0, 300)}`.trim());
    }
    return body.result;
  }

  status() {
    return this.rpc("status", []);
  }

  async viewAccount(accountId = this.accountId) {
    return this.rpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
  }

  async viewAccessKey(publicKey = this.key?.publicKeyStr, accountId = this.accountId) {
    return this.rpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
  }

  async callView(contractId, method, args = {}) {
    const res = await this.rpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    const text = Buffer.from(res.result || []).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async blockHash() {
    const b = await this.rpc("block", { finality: "final" });
    return hashToBytes(b.header.hash);
  }

  async signAndSend({ receiverId, actions, signerId = this.accountId, key = this.key }) {
    if (!key) throw new Error("no key configured");
    const send = async () => {
      let lastError;
      // A nonce read a moment ago can be stale if any other send touched the
      // key (or a previous attempt was dropped), so re-read and retry instead
      // of failing the job at the payment step.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const accessKey = await this.viewAccessKey(key.publicKeyStr, signerId);
          const blockHash = await this.blockHash();
          const tx = encodeTransaction({
            signerId,
            publicKey: key.publicKey,
            nonce: BigInt(accessKey.nonce) + 1n,
            receiverId,
            blockHash,
            actions,
          });
          const signed = signTransaction(tx, key.secret);
          const result = await this.rpc("send_tx", {
            signed_tx_base64: signed.toString("base64"),
            wait_until: "EXECUTED_OPTIMISTIC",
          });
          return {
            hash: result.transaction?.hash || result.final_execution_status,
            status: result.status,
            result,
          };
        } catch (e) {
          lastError = e;
          const retryable = /INVALID_TRANSACTION|nonce|expired|Timeout|EAI_AGAIN|fetch failed/i.test(e.message);
          if (!retryable || attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      throw lastError;
    };

    const next = this._chain.then(send, send);
    this._chain = next.catch(() => {});
    return next;
  }

  call({ contractId, method, args = {}, gas = 30_000_000_000_000n, deposit = 0n }) {
    return this.signAndSend({
      receiverId: contractId,
      actions: [{ type: "functionCall", method, args, gas, deposit }],
    });
  }

  deploy({ contractId, code }) {
    return this.signAndSend({
      receiverId: contractId,
      actions: [{ type: "deployContract", code }],
    });
  }

  /** Deploy and call an init method in the same transaction. */
  deployAndInit({ contractId, code, method = "new", args = {} }) {
    return this.signAndSend({
      receiverId: contractId,
      actions: [
        { type: "deployContract", code },
        { type: "functionCall", method, args, gas: 30_000_000_000_000n, deposit: 0n },
      ],
    });
  }

  createAccount({ newAccountId, publicKey, initialBalance = 5_000_000_000_000_000_000_000_000n }) {
    return this.signAndSend({
      receiverId: newAccountId,
      actions: [
        { type: "createAccount" },
        { type: "transfer", deposit: initialBalance },
        { type: "addFullAccessKey", publicKey },
      ],
    });
  }
}

export function hashToBytes(hashB58) {
  const b = b58decode(hashB58);
  if (b.length !== 32) throw new Error("block hash must be 32 bytes");
  return b;
}

export function txUrl(hash, network = "testnet") {
  if (!hash) return "";
  return `https://${network === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${hash}`;
}
