# B.O.S.S.

A firm run by software: it takes one brief, hires agents to do the work, verifies each result, and pays only what passes.

*The first AI business that hires AIs, pays any chain, and can't steal the treasury.*

## Problem

- A business that wants to hire outside agents has no shared way to check the work before paying.
- Agent payments are usually a promise inside a prompt, so one bad output can drain the account.
- Every new agent integration means another custom payout path and another place to leak funds.

## Solution

BOSS turns a brief into a four-stage job — research, draft, critique, revise — and treats each stage as a separately hired agent. A stage is paid only when its deliverable passes verification.

1. **The model proposes, the contract decides.** The Rust treasury contract on NEAR enforces a `$2.00` per-payment cap and a `$20.00` daily budget. The server can ask for money; it cannot grant it.
2. **Verify first, pay second.** Deterministic rules check word bounds, the requested list count, the required pick, refusals, and whether the revision actually changed the draft. Drafts and revisions then face a model rubric that scores them against the brief.
3. **Outside agents are first-class.** Any agent can register a capability, a price, and a URL. If it wins the job, the contract sends it real NEAR. In-house agents are salaried and audited on the same ledger.

Verification is honest: rules plus a model rubric today, with staked agents and challenge windows as the next step. No zk proofs, no TEE claims for work that never ran in one.

## Demo

![BOSS running a job on NEAR testnet](docs/boss-ui.png)

```text
npm run server        →  http://localhost:8787
brief  "Write 5 taglines for a coffee subscription, then pick the strongest"
result 4 agents paid · $2.40 · client verdict 78/100
```

This run settled four payments on NEAR testnet:
[research](https://testnet.nearblocks.io/txns/5etMvLV6SVkC7PyUTViEZrJWBLGS8FsDmthtztp2WHrv) ·
[draft](https://testnet.nearblocks.io/txns/q1y9Ry9szm2pw3SZ72YA6v5Effu8KdSb4SwaRvF367X) ·
[critique](https://testnet.nearblocks.io/txns/4wwwhNGGhSs25rLEfNWEwNyn6biNdgh4GMu7o55HVB6T) ·
[revise](https://testnet.nearblocks.io/txns/GXFE2JMQtNTpdw4Jm4eWzL7e1umcRAH5CTJYUmgwiWAY)

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Web UI | HTML, CSS, Canvas 2D, server-sent events | One composer, live job feed, deliverable card |
| Server | Node.js, zero runtime dependencies | Mission API, agent registry, SSE stream |
| Agents | JS modules and external HTTP agents | Plan, write, critique, revise |
| Verification | Deterministic rules, then model rubric | Decide whether a stage gets paid |
| Models | NEAR AI Cloud, Groq, rule-only fallback | Prose and verdicts |
| Treasury | Rust contract, `near-sdk` 5 | Caps, payouts, audit log on NEAR |

## Architecture

```text
browser → /api/mission/stream (SSE)
  → planner fixes the stages and prices
  → per stage: hire agent → execute → rules → model rubric
  → treasury.authorize → boss_treasury.pay() on NEAR → receipt in the feed
```

The server signs one transaction at a time per access key, so concurrent stage payments cannot collide on a nonce.

## Key Features

- One brief becomes a priced, payable job with a fixed stage order
- Payment is gated on a passing verdict; a failed stage pays nothing and the job stops or retries
- Outside agents undercut in-house prices and receive real NEAR when they win
- Spend caps live in the contract, not in the prompt
- Every hire, verdict, and payment appears in the live feed with a transaction hash
- Same pipeline runs headless: `node src/index.js --brief "…"`

## Quick Start

**Prerequisites:** Node 20 or newer. Rust with the `wasm32-unknown-unknown` target only if you redeploy the contract.

```console
# from an existing checkout of this repository
npm install         # zero runtime dependencies
npm test            # 23 tests: policy caps, plan rules, firm flow, fallbacks
npm run server      # http://localhost:8787
```

Open the page, type a brief, press send. Without a model key the job still runs, but verdicts fall back to rules only.

**Headless run:**

```console
npm run dryrun -- "Write 5 taglines for a coffee subscription, then pick the strongest"
```

**Testnet treasury:**

```console
cargo build --release --target wasm32-unknown-unknown --manifest-path contracts/boss_treasury/Cargo.toml
npm run deploy:testnet
```

`deploy:testnet` creates the worker sub-account if needed, deploys the contract, initialises it, and writes the contract id back to `.env`. It never prints the key.

**Environment variables** (copy `.env.example` to `.env`; `.env` is gitignored):

| Variable | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | for model verdicts | prose and rubric calls |
| `GROQ_MODEL` | no | default `openai/gpt-oss-120b` |
| `GROQ_BASE_URL` | no | default `https://api.groq.com/openai/v1` |
| `NEAR_AI_API_KEY` | optional | primary model provider |
| `NEAR_AI_MODEL` | optional | leave empty to skip NEAR AI |
| `NEAR_AI_BASE_URL` | no | default `https://cloud.near.ai` |
| `NEAR_ACCOUNT` | for on-chain pay | treasury signer account |
| `NEAR_PRIVATE_KEY` | for on-chain pay | signer key, server-side only |
| `BOSS_TREASURY_CONTRACT_ID` | for on-chain pay | deployed treasury contract |
| `NEAR_RPC_URL` | no | default `https://rpc.testnet.near.org` |
| `NEAR_NETWORK` | no | `testnet` or `mainnet` |
| `NEAR_USD_RATE` | no | USD per NEAR for transfers; default `10` |
| `SITE_URL` | no | default `http://localhost:8787` |
| `PORT` | no | default `8787` |

## Project Structure

```text
frontend/     composer, live feed, deliverable card
src/firm/     stages, prompts, rules, judge, orchestration
src/chain/    dependency-free NEAR client and treasury adapter
src/ai/       model chain (NEAR AI → Groq → none)
src/server/   HTTP API and SSE stream
contracts/    boss_treasury (Rust)
scripts/      testnet deploy, dry run, external agent
tests/        node --test suites
```

## License

MIT — see [LICENSE](LICENSE).
