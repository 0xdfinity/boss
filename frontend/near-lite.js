// Browser NEAR client — keys, borsh, signatures, RPC. No build step, no import.
//
// The key is generated in this tab, stored in this browser, and never leaves
// it: the server only ever receives a transaction that is already signed, so a
// compromised server still cannot spend a client's escrow.
//
// It is a deliberate twin of src/chain/near.js. `tests/browser-tx.test.js`
// encodes and signs the same transaction with both and compares the bytes, so
// the two cannot drift into signing different things.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
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
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

const hex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const bytesToB64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

export const b64ToBytes = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

export const bytesToHex = (bytes) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- keys

// PKCS#8 wrapper around a raw 32-byte ed25519 seed, the same prefix
// src/chain/near.js uses. WebCrypto will not derive a public key from a
// private one, so the key pair is generated once and both halves are stored.
const PKCS8 = hex("302e020100300506032b657004220420");

export function parseSecret(input) {
  const raw = String(input || "").replace(/^ed25519:/, "");
  if (!raw) throw new Error("empty key");
  const bytes = b58decode(raw);
  if (bytes.length === 64) {
    const seed = bytes.subarray(0, 32);
    const pub = bytes.subarray(32, 64);
    return { seed, publicKey: pub, publicKeyStr: `ed25519:${b58encode(pub)}`, secretStr: `ed25519:${raw}` };
  }
  if (bytes.length === 32) {
    return { seed: bytes, publicKey: null, publicKeyStr: null, secretStr: `ed25519:${raw}` };
  }
  throw new Error("ed25519 secret key must be 32 or 64 bytes");
}

export async function generateKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const pub = spki.subarray(spki.length - 32);
  return {
    seed,
    publicKey: pub,
    publicKeyStr: `ed25519:${b58encode(pub)}`,
    secretStr: `ed25519:${b58encode(concat([seed, pub]))}`,
  };
}

const keyCache = new Map();

function privateKey(seed) {
  const id = bytesToHex(seed);
  if (!keyCache.has(id)) {
    keyCache.set(
      id,
      crypto.subtle.importKey("pkcs8", concat([PKCS8, seed]), { name: "Ed25519" }, false, ["sign"])
    );
  }
  return keyCache.get(id);
}

// ---------------------------------------------------------------- borsh

class Writer {
  constructor() {
    this.parts = [];
  }
  u8(n) {
    this.parts.push(Uint8Array.of(n & 0xff));
  }
  u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.parts.push(b);
  }
  u64(n) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    this.parts.push(b);
  }
  u128(n) {
    let v = BigInt(n);
    const b = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    this.parts.push(b);
  }
  bytes(buf) {
    this.u32(buf.length);
    this.parts.push(buf instanceof Uint8Array ? buf : Uint8Array.from(buf));
  }
  fixed(buf) {
    this.parts.push(buf instanceof Uint8Array ? buf : Uint8Array.from(buf));
  }
  string(s) {
    this.bytes(new TextEncoder().encode(String(s)));
  }
  concat() {
    return concat(this.parts);
  }
}

const publicKeyBytes = (w, pub) => {
  w.u8(0); // ED25519
  w.fixed(pub);
};

const jsonBytes = (args) => new TextEncoder().encode(JSON.stringify(args ?? {}));

export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const w = new Writer();
  w.string(signerId);
  publicKeyBytes(w, publicKey);
  w.u64(nonce);
  w.string(receiverId);
  w.fixed(blockHash);
  w.u32(actions.length);
  for (const a of actions) {
    switch (a.type) {
      case "functionCall":
        w.u8(2);
        w.string(a.method);
        w.bytes(jsonBytes(a.args));
        w.u64(a.gas ?? 30_000_000_000_000n);
        w.u128(a.deposit ?? 0n);
        break;
      case "transfer":
        w.u8(3);
        w.u128(a.deposit ?? 0n);
        break;
      case "createAccount":
        w.u8(0);
        break;
      case "deployContract":
        w.u8(1);
        w.bytes(a.code);
        break;
      case "addFullAccessKey":
        w.u8(5);
        publicKeyBytes(w, a.publicKey);
        w.u64(a.nonce ?? 0n);
        w.u8(1); // FullAccess
        break;
      case "addFunctionCallKey":
        w.u8(5);
        publicKeyBytes(w, a.publicKey);
        w.u64(a.nonce ?? 0n);
        w.u8(0); // FunctionCall
        if (a.allowance === null || a.allowance === undefined) {
          w.u8(0);
        } else {
          w.u8(1);
          w.u128(a.allowance);
        }
        w.string(a.receiverId);
        w.u32((a.methodNames || []).length);
        for (const method of a.methodNames || []) w.string(method);
        break;
      default:
        throw new Error(`unknown action ${a.type}`);
    }
  }
  return w.concat();
}

export async function signTransaction(txBytes, secret) {
  const seed = secret instanceof Uint8Array ? secret : parseSecret(secret).seed;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", txBytes));
  const key = await privateKey(seed);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, hash));
  const w = new Writer();
  w.u8(0); // ED25519 signature
  w.fixed(sig);
  return concat([txBytes, w.concat()]);
}

// ---------------------------------------------------------------- money

/** USD -> yoctoNEAR. Integer math: 0.5/10*1e24 has more digits than a float. */
export function usdToYocto(usd, rate = 10) {
  const perNear = Number(rate) > 0 ? Number(rate) : 10;
  const micro = BigInt(Math.round(Number(usd) * 1e6));
  const rateMicro = BigInt(Math.round(perNear * 1e6));
  if (rateMicro <= 0n) throw new Error("rate must be positive");
  return (micro * 10n ** 24n) / rateMicro;
}

export const formatNear = (yocto) => (Number(yocto) / 1e24).toFixed(4);

// ---------------------------------------------------------------- rpc

const RPC_URL = "https://test.rpc.fastnear.com";

export class BrowserNear {
  constructor({ rpcUrl = RPC_URL, accountId, secret } = {}) {
    this.rpcUrl = rpcUrl;
    this.accountId = accountId || "";
    this.key = secret ? parseSecret(secret) : null;
    this._chain = Promise.resolve();
  }

  async rpc(method, params) {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "boss-browser", method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    if (body.error) {
      const msg = body.error?.cause?.name || body.error?.message || "rpc error";
      const raw = body.error?.data ?? body.error?.cause?.info ?? "";
      const data = typeof raw === "string" ? raw : JSON.stringify(raw);
      throw new Error(`${method}: ${msg} ${data.slice(0, 240)}`.trim());
    }
    // `query` reports a missing key inside the result, not as a JSON-RPC error.
    if (body.result && typeof body.result.error === "string") {
      throw new Error(`${method}: ${body.result.error}`);
    }
    return body.result;
  }

  async viewAccessKey(publicKey = this.key?.publicKeyStr, accountId = this.accountId) {
    return this.rpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
  }

  async balance(accountId = this.accountId) {
    const account = await this.rpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return BigInt(account.amount);
  }

  async blockHash() {
    const block = await this.rpc("block", { finality: "final" });
    return b58decode(block.header.hash);
  }

  async callView(contractId, method, args = {}) {
    const res = await this.rpc("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: bytesToB64(new TextEncoder().encode(JSON.stringify(args))),
    });
    const text = new TextDecoder().decode(Uint8Array.from(res.result || []));
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  successValue(out) {
    const raw = out?.status?.SuccessValue;
    if (typeof raw !== "string" || raw === "") return null;
    const text = new TextDecoder().decode(b64ToBytes(raw));
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async signAndSend({ receiverId, method, args = {}, gas = 30_000_000_000_000n, deposit = 0n }) {
    if (!this.key?.seed) throw new Error("no key in this browser");
    const send = async () => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const accessKey = await this.viewAccessKey();
          const blockHash = await this.blockHash();
          const tx = encodeTransaction({
            signerId: this.accountId,
            publicKey: this.key.publicKey,
            nonce: BigInt(accessKey.nonce) + 1n,
            receiverId,
            blockHash,
            actions: [{ type: "functionCall", method, args, gas, deposit }],
          });
          const signed = await signTransaction(tx, this.key.seed);
          const result = await this.rpc("send_tx", {
            signed_tx_base64: bytesToB64(signed),
            wait_until: "EXECUTED_OPTIMISTIC",
          });
          return {
            hash: result.transaction?.hash || result.final_execution_status,
            status: result.status,
            successValue: this.successValue(result),
            result,
          };
        } catch (e) {
          lastError = e;
          const retryable = /INVALID_TRANSACTION|nonce|expired|Timeout|fetch failed|Failed to fetch/i.test(
            String(e.message || e)
          );
          if (!retryable || attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
      }
      throw lastError;
    };
    // One key, one nonce: two clicks must not read the same nonce.
    const next = this._chain.then(send, send);
    this._chain = next.catch(() => {});
    return next;
  }

  openJob({ contractId, capability, specHash, specUrl, deadlineSecs, deposit }) {
    return this.signAndSend({
      receiverId: contractId,
      method: "open_job",
      args: {
        capability: String(capability),
        spec_hash: String(specHash),
        spec_url: String(specUrl),
        deadline_secs: Number(deadlineSecs),
      },
      deposit,
    });
  }

  release({ contractId, jobId }) {
    return this.signAndSend({
      receiverId: contractId,
      method: "release",
      args: { job_id: Number(jobId) },
      gas: 40_000_000_000_000n,
    });
  }

  refund({ contractId, jobId }) {
    return this.signAndSend({
      receiverId: contractId,
      method: "refund",
      args: { job_id: Number(jobId) },
      gas: 40_000_000_000_000n,
    });
  }
}

export const txUrl = (hash) => (hash ? `https://testnet.nearblocks.io/txns/${hash}` : "");
